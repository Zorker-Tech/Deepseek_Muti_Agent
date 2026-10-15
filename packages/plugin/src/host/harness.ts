/**
 * Harness seams, probed rather than assumed (ADR-0006).
 *
 * The plugin never imports a harness package at runtime. It asks the live Cordis
 * context what exists, records what it found, and degrades one capability per absent
 * seam with a diagnostic the settings page shows. That is what lets the same artifact
 * boot on a headless profile, a web profile, and a harness revision whose exports have
 * moved.
 *
 * Everything the plugin touches on the harness is declared here, in minimal structural
 * form, so the coupling surface of the whole project is one file.
 *
 * @module @zorker/muti-agent-plugin/host/harness
 */

/** A structural view of a Cordis context: only what this plugin uses. */
export interface HarnessContext {
  /** Read a service by name, or `undefined` when it is absent. */
  get(name: string): unknown
  /** Publish a service under a name. */
  provide?(name: string, value: unknown): void
  /** Register a typed event listener on the context. */
  on?(event: string, listener: (...args: never[]) => unknown): () => void
  /** Register a resource whose disposer runs when the plugin unloads. */
  effect?(callback: () => () => void, label?: string): () => void
  /**
   * Mount a child plugin that activates once every named service exists, and is
   * re-activated when a provider replaces one.
   */
  inject?(deps: readonly string[], callback: () => void): unknown
  /** Logger the harness provides on the root context. */
  logger?: { debug?: (...args: unknown[]) => void, info?: (...args: unknown[]) => void, warn?: (...args: unknown[]) => void, error?: (...args: unknown[]) => void }
}

/** The harness tool registry, as far as this plugin needs it. */
export interface ToolsService {
  register(definition: unknown): () => void
}

/** The harness command registry (slash commands). */
export interface CommandsService {
  register(definition: {
    name: string
    description: string
    input?: unknown
    handler: (invocation: unknown) => Promise<unknown> | unknown
  }): () => void
}

/** One exact fetch route registration shape, structurally. */
export interface ConnectionFetchService {
  register(route: {
    path: string
    methods: readonly string[]
    requestBody: 'buffered' | 'streaming'
    fetch: (request: Request) => Promise<Response>
  }): () => Promise<void> | (() => void)
}

/** The harness connection service, as far as this plugin needs it. */
export interface ConnectionService {
  fetch?: ConnectionFetchService
  /** Read the signed operator id from a request, when the harness exposes it. */
  authenticate?: (request: Request) => { subject?: string } | undefined
}

/** The harness terminal service, for launching an agent's own interactive UI. */
export interface TerminalService {
  create?(options: {
    command: string
    args: readonly string[]
    cwd?: string
    title?: string
  }): Promise<unknown> | unknown
}

/** What the harness offered at activation, and what each absence costs. */
export interface HarnessCapabilities {
  tools: ToolsService | undefined
  commands: CommandsService | undefined
  connection: ConnectionService | undefined
  terminal: TerminalService | undefined
  /** Names of the services that were present, for diagnostics. */
  present: readonly string[]
  /** Absent seams with the capability each one disables. */
  missing: readonly { service: string, disables: string }[]
  /** Whether the context can publish a service of its own. */
  canProvide: boolean
}

/**
 * Probe the harness context once, at activation.
 *
 * @param ctx - The Cordis context the plugin was applied with.
 * @returns What is available, phrased for both use and diagnostics.
 */
export function probeHarness(ctx: HarnessContext): HarnessCapabilities {
  const tools = asTools(ctx.get('tools'))
  const commands = asCommands(ctx.get('commands'))
  const connection = asConnection(ctx.get('connection'))
  const terminal = asTerminal(ctx.get('terminal'))

  const present: string[] = []
  const missing: { service: string, disables: string }[] = []

  const check = (name: string, value: unknown, disables: string): void => {
    if (value === undefined) missing.push({ service: name, disables })
    else present.push(name)
  }
  check('tools', tools, 'native tools, so the harness agent cannot orchestrate other agents')
  check('commands', commands, 'slash commands')
  check('connection', connection, 'the browser gateway, so the GUI panels have no data source')
  check('terminal', terminal, 'opening an agent\'s own interactive UI from the panel')

  return {
    tools,
    commands,
    connection,
    terminal,
    present,
    missing,
    canProvide: typeof ctx.provide === 'function',
  }
}

function asTools(value: unknown): ToolsService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { register?: unknown }
  if (typeof candidate.register !== 'function') return undefined
  return value as ToolsService
}

function asCommands(value: unknown): CommandsService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { register?: unknown }
  if (typeof candidate.register !== 'function') return undefined
  return value as CommandsService
}

function asConnection(value: unknown): ConnectionService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { fetch?: unknown }
  const fetchService = candidate.fetch
  if (typeof fetchService !== 'object' || fetchService === null) {
    // A connection without a fetch registry still counts as absent for our purposes:
    // the gateway is the only thing we need from it.
    return undefined
  }
  const register = (fetchService as { register?: unknown }).register
  if (typeof register !== 'function') return undefined
  return value as ConnectionService
}

function asTerminal(value: unknown): TerminalService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { create?: unknown }
  if (typeof candidate.create !== 'function') return undefined
  return value as TerminalService
}

/**
 * Publish a service on the context when the harness allows it.
 *
 * A missing `provide` is not an error: the plugin's own surfaces (tools, routes, MCP)
 * do not need the service name to be published. It matters only for another plugin
 * that wants to call MutiAgent in-process, which is a bonus rather than a dependency.
 *
 * @param ctx - The Cordis context.
 * @param name - Service name to publish under.
 * @param value - The service instance.
 * @returns Whether it was published.
 */
export function provideService(ctx: HarnessContext, name: string, value: unknown): boolean {
  if (typeof ctx.provide !== 'function') return false
  try {
    ctx.provide(name, value)
    return true
  } catch {
    return false
  }
}

/**
 * Run a registration once the named services exist.
 *
 * Cordis has no "optional dependency": any name in a plugin's `inject` makes activation
 * wait for it, and omitting it makes activation race every other plugin. Both are wrong
 * for this plugin, which needs the harness's services when they exist and must boot
 * without them under a headless profile. `ctx.inject` mounts a *child* fiber whose
 * declared dependencies are waited for, so registration happens when the service
 * appears — deterministically, whatever order the composition loads in — and the child is
 * disposed with this plugin.
 *
 * A context without `inject` (a test stub, or a harness revision that changed the API)
 * falls back to registering immediately, which is the previous behaviour rather than a
 * failure.
 *
 * @param ctx - The Cordis context the plugin was applied with.
 * @param deps - Service names the registration needs.
 * @param callback - The registration to perform.
 * @returns Whether a deferred mount was installed.
 */
export function registerWhenAvailable(
  ctx: HarnessContext,
  deps: readonly string[],
  callback: () => void,
): boolean {
  if (typeof ctx.inject !== 'function') {
    callback()
    return false
  }
  try {
    void ctx.inject(deps, callback)
    return true
  } catch {
    callback()
    return false
  }
}

/**
 * Register a resource with the harness's effect system, falling back to running the
 * callback immediately when the context has no `effect`.
 *
 * Registering everything through effects is what makes unloading the plugin leave no
 * residue; a context without it is a test harness or an unusual composition, where
 * running immediately is the honest behaviour.
 *
 * @param ctx - The Cordis context.
 * @param callback - Returns the disposer for whatever it registered.
 * @param label - Label the harness records with the effect.
 * @returns A disposer for this registration.
 */
export function registerEffect(
  ctx: HarnessContext,
  callback: () => () => void,
  label: string,
): () => void {
  if (typeof ctx.effect === 'function') {
    try {
      return ctx.effect(callback, label)
    } catch {
      // Fall through to the direct path below.
    }
  }
  const dispose = callback()
  return () => { dispose() }
}
