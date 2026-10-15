/**
 * The MutiAgent harness plugin: the host half of the installable bundle.
 *
 * It activates in this order, and every step that can fail degrades instead of
 * aborting (ADR-0006):
 *
 * 1. Resolve settings and build the domain layer.
 * 2. Register every adapter this build carries; a missing binary is a diagnostic.
 * 3. Probe the harness seams and record what each absence disables.
 * 4. Publish the service, register native tools, slash commands, and — when the
 *    authenticated `/api` channel exists — the browser gateway.
 * 5. Warm the session index and start the worktree sampler in the background.
 *
 * Nothing here throws during activation except a genuinely self-contained
 * misconfiguration (an unreadable settings value), because a broken plugin must not
 * take the user's whole profile down with it.
 *
 * @module @zorker/muti-agent-plugin/host/index
 */

import { MutiAgentService, ScopedLogger, type AdapterSettings } from '@zorker/muti-agent-core'
import {
  Dispatcher,
  Gateway,
  OperationCatalog,
  buildTools,
  registerDefaultAdapters,
  registerOperations,
  type RegistrationContext,
} from '@zorker/muti-agent-control-plane'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LlmService } from '@zorker/muti-agent-llm-bridge'
import { PLUGIN_VERSION } from '@zorker/muti-agent-contracts'
import {
  createSurfaceState,
  probeHarness,
  provideService,
  registerEffect,
  registerWhenAvailable,
  type HarnessCapabilities,
  type HarnessContext,
} from './harness.ts'
import { readPluginSettings, type MutiAgentPluginConfig } from './settings.ts'

export const name = 'muti-agent'

// No service injection is declared on purpose. Everything the plugin needs from the
// harness is optional and probed at activation (`probeHarness`), so declaring a
// dependency would only add a way for activation to be deferred for no benefit.

/** The validated settings schema, expressed as the harness's Standard-Schema contract. */
export const Config = readPluginSettings.schema

/** One agent's model-route registration outcome, kept for diagnostics. */
interface ModelRouteOutcome {
  agentId: string
  providers: readonly string[]
  notes: readonly string[]
  error?: string
}

interface ActivationState {
  service: MutiAgentService | undefined
  /** Filled when the LLM surface mounts, read by the diagnostics operation. */
  modelRoutes: ModelRouteOutcome[]
  /** Adapters this build carries that did not register, with the reason. */
  skippedAdapters: { agentId: string, reason: string }[]
  gateway: Gateway | undefined
  disposers: (() => void | Promise<void>)[]
  timers: NodeJS.Timeout[]
  harness: HarnessCapabilities | undefined
}

/** Everything the plugin registered, so unload can release it in reverse order. */
const ACTIVATIONS = new WeakMap<object, ActivationState>()

/**
 * Activate the plugin.
 *
 * @param ctx - Cordis context supplied by the harness loader.
 * @param rawConfig - The row's `config` from the profile composition.
 * @returns A disposer that releases every registration, or `undefined` when the
 *   plugin declined to activate (a validation failure) and has already reported why.
 */
export async function apply(
  ctx: HarnessContext,
  rawConfig?: unknown,
): Promise<(() => Promise<void>) | undefined> {
  const state: ActivationState = {
    service: undefined,
    gateway: undefined,
    disposers: [],
    timers: [],
    harness: undefined,
    modelRoutes: [],
    skippedAdapters: [],
  }
  ACTIVATIONS.set(ctx as object, state)

  const parsed = readPluginSettings.safeParse(rawConfig ?? {})
  if (!parsed.ok) {
    // A self-contained misconfiguration: the settings cannot be interpreted at all, so
    // activating with invented defaults would hide the user's mistake.
    const detail = parsed.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')
    ctx.logger?.error?.(`muti-agent: settings are invalid, plugin not activated: ${detail}`)
    return undefined
  }
  const config: MutiAgentPluginConfig = parsed.value

  const harnessHome = resolveHarnessHome(ctx)
  const adapters: Record<string, AdapterSettings> = {}
  for (const [agentId, settings] of Object.entries(config.agents)) {
    adapters[agentId] = {
      enabled: settings.enabled,
      env: settings.env,
      envMode: settings.envMode,
      timeoutMs: settings.timeoutMs,
      ...(settings.binaryPath === '' ? {} : { binaryPath: settings.binaryPath }),
      ...(settings.homeDir === '' ? {} : { homeDir: settings.homeDir }),
      ...(settings.model === '' ? {} : { model: settings.model }),
    }
  }
  // The harness session store is how the plugin knows whether a conversation has begun; the
  // domain layer cannot reach it.
  //
  // The lookup happens **per call**, never once at activation: `sessions` is frequently not
  // yet registered while `apply` runs, and a snapshot taken then would be permanently
  // `undefined` — which reads as "every session has started" and locks the agent switcher in
  // every conversation. The same eager-capture mistake was already fixed for the tools,
  // commands and connection surfaces by registering them reactively.
  const sessionActivity = (sessionId: string): boolean => {
    const sessions = ctx.get('sessions') as
      | { get?(id: string): { events?: readonly unknown[] } | undefined }
      | undefined
    const session = sessions?.get?.(sessionId)
    // A store or entry this process cannot see cannot answer the question, so the stricter
    // answer stands: an unknown session counts as started.
    if (session === undefined) return true
    return Array.isArray(session.events) && session.events.length > 0
  }

  const service = new MutiAgentService({
    adapters,
    sessionActivity,
    logLevel: config.log.level,
    ...(config.stateDir === '' ? {} : { stateDir: config.stateDir }),
    ...(harnessHome === undefined ? {} : { harnessHome }),
    shareContext: config.collaboration.sharePlan,
    probeCliCredentials: config.credentials.probeCli,
    worktree: {
      enabled: config.worktree.enabled,
      location: config.worktree.location,
      conflictPolicy: config.worktree.conflictPolicy,
      featureBoundaries: config.worktree.featureBoundaries,
      autoIntegrate: config.worktree.autoIntegrate,
      ...(config.worktree.baseRef === '' ? {} : { baseRef: config.worktree.baseRef }),
    },
    runs: { maxParallel: config.runs.maxParallel, historyLimit: config.runs.historyLimit },
    logSink: record => {
      const line = `[muti-agent:${record.scope}] ${record.message}`
      if (record.level === 'error') ctx.logger?.error?.(line)
      else if (record.level === 'warn') ctx.logger?.warn?.(line)
      else ctx.logger?.debug?.(line)
    },
  })
  state.service = service

  const registration = await registerDefaultAdapters(service, {
    enabled: Object.entries(config.agents)
      .filter(([, settings]) => settings.enabled !== false)
      .map(([agentId]) => agentId),
  })
  for (const skip of registration.skipped) state.skippedAdapters.push(skip)
  if (registration.skipped.length > 0) {
    ctx.logger?.warn?.(
      `muti-agent: ${String(registration.skipped.length)} adapter(s) skipped: ${registration.skipped
        .map(item => `${item.agentId} (${item.reason})`)
        .join('; ')}`,
    )
  }
  await service.start()

  const harness = probeHarness(ctx)
  state.harness = harness

  const surfaces = createSurfaceState()
  const catalog = new OperationCatalog()
  const registrationContext: RegistrationContext = {
    pluginVersion: PLUGIN_VERSION,
    // Read at call time, not captured here: registration is reactive, so the effective
    // surfaces change after activation.
    modelRoutes: () => state.modelRoutes,
    skippedAdapters: () => state.skippedAdapters,
    surfaces: () => {
      const mounted = new Set(surfaces.mounted)
      const missing: { service: string, disables: string }[] = []
      for (const [service, disables] of SURFACE_DISABLES) {
        if (mounted.has(service)) continue
        const failure = surfaces.failed.get(service)
        missing.push(failure === undefined ? { service, disables } : { service, disables: `${disables} (registration failed: ${failure})` })
      }
      return {
        services: [...mounted],
        missing,
        failed: [...surfaces.failed].map(([service, reason]) => ({ service, reason })),
      }
    },
  }
  registerOperations(catalog, registrationContext)
  const dispatcher = new Dispatcher(service, catalog)

  if (harness.canProvide) provideService(ctx, 'mutiAgent', dispatcher)

  // Each surface waits for the harness services it needs, so activation order in the
  // composition cannot decide whether the panel has data.

  // Surface A: native tools, so the harness's own agent can drive the mesh.
  registerWhenAvailable(ctx, ['tools'], 'tools', surfaces, () => {
    const tools = ctx.get('tools') as { register(definition: unknown): () => void } | undefined
    if (tools === undefined) return
    for (const tool of buildTools(dispatcher)) {
      state.disposers.push(registerEffect(ctx, () => tools.register(tool), `muti-agent: tool ${tool.name}`))
    }
    ctx.logger?.debug?.(`muti-agent: ${String(buildTools(dispatcher).length)} native tools registered`)
  })

  // Slash commands, so a user can act from the composer without leaving the keyboard.
  registerWhenAvailable(ctx, ['commands'], 'commands', surfaces, () => {
    const commands = ctx.get('commands') as
      | { register(definition: { name: string, description: string, handler: (invocation: unknown) => Promise<unknown> }): () => void }
      | undefined
    if (commands === undefined) return
    for (const command of buildCommands(dispatcher, service)) {
      state.disposers.push(registerEffect(
        ctx,
        () => commands.register(command),
        `muti-agent: command ${command.name}`,
      ))
    }
    ctx.logger?.debug?.(`muti-agent: ${String(buildCommands(dispatcher, service).length)} slash commands registered`)
  })

  // Surface B: the authenticated browser gateway.
  registerWhenAvailable(ctx, ['connection'], 'connection', surfaces, () => {
    const connection = ctx.get('connection') as
      | { fetch?: { register(route: unknown): () => void } }
      | undefined
    if (connection?.fetch === undefined) return
    const gateway = new Gateway(dispatcher, push => service.runs.subscribe(push), {
      maxBodyBytes: config.gateway.maxBodyBytes,
      heartbeatMs: config.gateway.heartbeatMs,
    })
    state.gateway = gateway
    for (const route of gateway.routes()) {
      state.disposers.push(registerEffect(ctx, () => {
        const registered = connection.fetch?.register({
          path: route.path,
          methods: route.methods,
          requestBody: route.requestBody,
          fetch: route.fetch,
        })
        return () => { void Promise.resolve(registered).then(dispose => { if (typeof dispose === 'function') dispose() }) }
      }, `muti-agent: route ${route.path}`))
    }
    ctx.logger?.debug?.('muti-agent: browser gateway registered')
  })

  // Surface D: the models the agents' own configuration files declare, registered into the
  // harness's LLM layer so its model selector can offer and run them. This is what makes the
  // sync real rather than cosmetic: a route is registered only together with a transport that
  // knows how to speak to it (`llm-bridge` over `fetch`), so a listed model is one that
  // answers. Reactive like the other surfaces, because `llm` is frequently registered after
  // this plugin activates.
  registerWhenAvailable(ctx, ['llm'], 'llm', surfaces, () => {
    // Structural, like every other seam this plugin uses: the service is whatever the
    // harness published under this name, and the bridge restates only the members a route
    // registration touches (ADR-0006).
    const llm = ctx.get('llm') as LlmService | undefined
    if (llm === undefined) return
    void registerAgentRoutes(ctx, state, llm, config)
  })

  // Background work: a warm session scan, then a sampler that keeps worktree progress
  // fresh for the mesh panel and for conflict warnings.
  schedule(ctx, state, async () => {
    const outcomes = await service.refreshSessions()
    const failed = outcomes.filter(outcome => !outcome.ok)
    if (failed.length > 0) {
      ctx.logger?.debug?.(
        `muti-agent: session scan finished with ${String(failed.length)} failure(s): ${failed
          .map(outcome => `${outcome.agentId} (${outcome.error ?? 'unknown'})`)
          .join('; ')}`,
      )
    }
  }, config.sessions.warmScanDelayMs)

  if (service.worktrees !== undefined && config.worktree.sampleIntervalMs > 0) {
    const timer = setInterval(() => {
      void service.worktrees
        ?.sampleAll(service.runs.active().map(record => String(record.id)))
        .catch((cause: unknown) => {
          ctx.logger?.debug?.(
            `muti-agent: worktree sample failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        })
    }, config.worktree.sampleIntervalMs)
    timer.unref?.()
    state.timers.push(timer)
  }

  ctx.logger?.info?.(
    `muti-agent: active (agents: ${registration.registered.join(',') || 'none'}; state: ${service.stateRoot}; surfaces: tools/commands/connection mount on availability)`,
  )

  return async () => {
    for (const timer of state.timers) clearInterval(timer)
    state.timers.length = 0
    state.gateway?.close()
    await service.runs.drain(config.runs.shutdownGraceMs)
    for (const dispose of [...state.disposers].reverse()) {
      if (typeof dispose === 'function') await dispose()
    }
    state.disposers.length = 0
    ACTIVATIONS.delete(ctx as object)
  }
}

/** Run a task after a delay, without keeping the process alive. */
function schedule(
  ctx: HarnessContext,
  state: ActivationState,
  task: () => Promise<void>,
  delayMs: number,
): void {
  const timer = setTimeout(() => {
    void task().catch((cause: unknown) => {
      ctx.logger?.debug?.(`muti-agent: background task failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
  }, delayMs)
  timer.unref?.()
  state.timers.push(timer)
}

/**
 * What each harness surface enables, for diagnostics.
 *
 * The label is the capability a user loses, not the service name, because that is the
 * question "is anything missing?" actually asks.
 */
const SURFACE_DISABLES: readonly (readonly [string, string])[] = [
  ['tools', 'native tools, so the harness agent cannot orchestrate other agents'],
  ['commands', 'slash commands'],
  ['connection', 'the browser gateway, so the GUI panels have no data source'],
  ['terminal', 'opening an agent\'s own interactive UI from the panel'],
]

/**
 * Register each agent's configured provider routes with the harness's LLM layer.
 *
 * Each adapter package owns the reading, the route naming and the transport choice, so this
 * only supplies the agent directory and the environment. A failure to import or register one
 * agent is logged and skipped: the other agents' models must still appear.
 *
 * @param ctx - The Cordis context.
 * @param state - Activation state, so every disposer is released on unload.
 * @param llm - The harness LLM service the routes are registered against.
 * @param config - Resolved plugin settings, for per-agent home overrides.
 */
async function registerAgentRoutes(
  ctx: HarnessContext,
  state: ActivationState,
  llm: LlmService,
  config: MutiAgentPluginConfig,
): Promise<void> {
  const home = (agentId: string, envName: string, fallback: readonly string[]): string => {
    const configured = config.agents[agentId]?.homeDir ?? ''
    if (configured !== '') return configured
    const fromEnv = process.env[envName]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    return join(homedir(), ...fallback)
  }
  const targets: readonly { agentId: string, register: () => Promise<{ dispose: () => void, providers: readonly string[], notes: readonly string[] }> }[] = [
    {
      agentId: 'omp',
      register: async () => {
        const module = await import('@zorker/muti-agent-adapter-omp')
        return await module.registerOmpLlm({ llm }, {
          env: process.env,
          agentDir: home('omp', 'PI_CODING_AGENT_DIR', ['.omp', 'agent']),
        })
      },
    },
    {
      agentId: 'pi',
      register: async () => {
        const module = await import('@zorker/muti-agent-adapter-pi')
        return await module.registerPiLlm({ llm }, {
          env: process.env,
          agentDir: home('pi', 'PI_CODING_AGENT_DIR', ['.pi', 'agent']),
        })
      },
    },
    {
      agentId: 'grok',
      register: async () => {
        const module = await import('@zorker/muti-agent-adapter-grok')
        return await module.registerGrokLlm({ llm }, {
          env: process.env,
          homeDir: home('grok', 'GROK_HOME', ['.grok']),
        })
      },
    },
    {
      agentId: 'codex',
      register: async () => {
        const module = await import('@zorker/muti-agent-adapter-codex')
        return await module.registerCodexLlm({ llm }, {
          env: process.env,
          homeDir: home('codex', 'CODEX_HOME', ['.codex']),
          cwd: process.cwd(),
        })
      },
    },
  ]

  for (const target of targets) {
    if (config.agents[target.agentId]?.enabled === false) continue
    try {
      const registration = await target.register()
      state.disposers.push(registration.dispose)
      state.modelRoutes.push({
        agentId: target.agentId,
        providers: registration.providers,
        notes: registration.notes,
      })
      ctx.logger?.debug?.(
        `muti-agent: ${target.agentId} registered ${String(registration.providers.length)} model route(s): ${registration.providers.join(', ') || 'none'}`,
      )
      for (const note of registration.notes) {
        ctx.logger?.debug?.(`muti-agent: ${target.agentId} model route note: ${note}`)
      }
    } catch (cause) {
      // A missing credential, an unreadable config or an absent package costs this agent's
      // models and nothing else.
      const reason = cause instanceof Error ? cause.message : String(cause)
      state.modelRoutes.push({ agentId: target.agentId, providers: [], notes: [], error: reason })
      ctx.logger?.warn?.(`muti-agent: ${target.agentId} model routes were not registered: ${reason}`)
    }
  }
}

/** The slash commands the plugin contributes. */
function buildCommands(
  dispatcher: Dispatcher,
  service: MutiAgentService,
): readonly {
  name: string
  description: string
  handler: (invocation: unknown) => Promise<unknown>
}[] {
  const run = async (method: string, params: unknown): Promise<unknown> => {
    const result = await dispatcher.invoke({ method, params }, { actor: { id: 'harness-command', trusted: true } })
    if (!result.ok) return `${result.error.code}: ${result.error.message}`
    return result.result
  }
  return [
    {
      name: 'agents',
      description: 'List the integrated coding agents and their sign-in state.',
      handler: async () => run('credentials.list', {}),
    },
    {
      name: 'agent-sessions',
      description: 'List recent sessions grouped per agent.',
      handler: async () => run('sessions.partitions', { limit: 20 }),
    },
    {
      name: 'agent-refresh',
      description: 'Re-scan every agent\'s session store.',
      handler: async () => run('sessions.refresh', {}),
    },
    {
      name: 'agents-diagnostics',
      description: 'Report what MutiAgent can reach, and what is missing.',
      handler: async () => run('agents.diagnostics', {}),
    },
    {
      name: 'mesh-runs',
      description: 'List recent delegated runs.',
      handler: async () => run('runs.list', { limit: 20 }),
    },
    {
      name: 'mesh-state',
      description: 'Show the state directory and isolation mode MutiAgent is using.',
      handler: async () => ({ stateDir: service.stateRoot, isolation: service.worktrees === undefined ? 'disabled' : 'worktree' }),
    },
  ]
}

/** Resolve the harness home directory from the context or the environment. */
function resolveHarnessHome(ctx: HarnessContext): string | undefined {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const host = ctx.get('host')
  if (typeof host === 'object' && host !== null) {
    const candidate = (host as { home?: unknown }).home
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** The logger a caller can use when the harness provides one; exported for tests. */
export type { ScopedLogger }
