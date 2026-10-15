/**
 * The MutiAgent service facade: one object that wires the registry, session index,
 * worktree manager, collaboration store, run manager and credential service, and
 * exposes the operations every surface (HTTP, MCP, native tools, the harness agent)
 * calls through.
 *
 * This is what a Cordis plugin publishes as `ctx.mutiAgent`, so a consumer never
 * assembles the domain layer itself (ADR-0006).
 *
 * @module @zorker/muti-agent-core/service
 */

import { join } from 'node:path'
import { Redactor, ScopedLogger, stderrSink, type LogLevel, type LogSink } from './log.ts'
import { AgentRegistry } from './adapter/registry.ts'
import { FileProbe } from './process/files.ts'
import { Git } from './process/git.ts'
import { ProcessRunner } from './process/runner.ts'
import { SessionIndex } from './sessions/index.ts'
import { StateStore, resolveStateRoot } from './state/store.ts'
import { WorktreeManager, type WorktreeOptions } from './worktree/manager.ts'
import { MutiAgentError, ErrorCodes } from '@zorker/muti-agent-contracts'
import type { AgentCapabilityInventory, AgentModelCatalog } from '@zorker/muti-agent-contracts'
import { CollaborationStore } from './orchestration/collaboration.ts'
import { RunManager, type RunManagerOptions } from './orchestration/runs.ts'
import { CredentialService } from './credentials/service.ts'
import type { AgentAdapter, AdapterContext, AdapterRuntimeConfig, Logger } from './adapter/types.ts'

/** Per-adapter configuration supplied by the plugin's settings. */
export interface AdapterSettings {
  enabled?: boolean
  binaryPath?: string
  homeDir?: string
  env?: Readonly<Record<string, string>>
  envMode?: AdapterRuntimeConfig['envMode']
  timeoutMs?: number
  model?: string
  settings?: Readonly<Record<string, unknown>>
}

/** Everything that configures a service instance. */
export interface ServiceOptions {
  /** Explicit state directory; defaults to `<harnessHome>/mutiagent` or `~/.muti-agent`. */
  stateDir?: string
  /** The harness home directory, used to derive the default state directory. */
  harnessHome?: string
  /** Log level. */
  logLevel?: LogLevel
  /** Additional log destination, so records also reach the harness log. */
  logSink?: LogSink
  /** Per-agent configuration, keyed by agent id. */
  adapters: Readonly<Record<string, AdapterSettings>>
  /** Worktree isolation settings; `undefined` disables isolation entirely. */
  worktree?: Partial<WorktreeOptions> & { enabled?: boolean }
  /** Run concurrency and retention. */
  runs?: Partial<RunManagerOptions>
  /** Whether shared todos/plan are injected into delegated runs (ADR-0009). */
  shareContext?: boolean
  /** Whether credential status may fall back to an agent CLI probe. */
  probeCliCredentials?: boolean
  /**
   * Whether a harness session has started, i.e. carries at least one event.
   *
   * Supplied by the plugin, which can reach the harness's session store; the domain layer
   * cannot. It decides when a session's agent binding stops being changeable: the binding is
   * a **choice** while a conversation has not begun and a **fact** afterwards, because the
   * transcript, the worktree and the shared todos accumulate around one agent from the first
   * turn onward.
   *
   * Omitted means "assume started", so an embedder that cannot tell keeps the stricter
   * behaviour rather than silently allowing a re-point.
   */
  sessionActivity?: (sessionId: string) => boolean
  /**
   * Concrete secrets to redact from every output. Seeded from values the user typed
   * into settings during this process's lifetime.
   */
  secrets?: readonly string[]
}

/**
 * The reserved id meaning "the harness's own agent answers".
 *
 * A composer sits in one conversation, and most conversations belong to the harness's own
 * agent; delegating is the exception. Without this value a switcher can only express which
 * *external* agent a session uses, which reads as "every conversation must be delegated".
 * It is not an adapter and never appears in the agent registry.
 */
export const HARNESS_AGENT = 'harness'

/** Operator preferences MutiAgent persists across restarts. */
export interface Preferences {
  /**
   * The agent a delegated run defaults to when the caller names none, and the fallback for
   * a session that has no choice of its own.
   *
   * Held host-side rather than in browser storage so it follows the operator to any
   * client, and so a script or an MCP caller sees the same default the GUI shows.
   */
  preferredAgent?: string
  /**
   * Agent chosen per harness session, keyed by session id.
   *
   * Per session rather than global because the control lives in one conversation's
   * composer: a user working on two things at once must be able to send one to Codex and
   * leave the other on the harness agent. The reserved value {@link HARNESS_AGENT} means
   * "no delegation here".
   *
   * **A value, once written, is not replaceable** — see {@link MutiAgentService.setPreferences}
   * and `session/agent-locked`.
   */
  agentBySession?: Readonly<Record<string, string>>
  /**
   * Model chosen per agent, keyed by agent id.
   *
   * Deliberately **not** validated against the agent's catalog: a machine's usable models
   * include ids its configuration never names (a provider's own list, a built-in catalog),
   * so rejecting an unknown id here would refuse a model the agent would happily run. The
   * catalog is a menu, not a whitelist.
   */
  preferredModelByAgent?: Readonly<Record<string, string>>
}

/** Where preferences live inside the state directory. */
const PREFERENCES_PATH = 'preferences.json'

/** Concrete adapters are constructed by the plugin, because each needs its own config type. */
export type AdapterFactory = (context: AdapterContext) => AgentAdapter

const DEFAULT_RUNS: RunManagerOptions = {
  maxParallel: 4,
  historyLimit: 200,
  shareContext: true,
}

/** Why the reserved harness binding has no foreign inventory to read. */
export const HARNESS_INVENTORY_NOTE =
  "the harness answers with its own agent, whose capability surfaces already describe it: the " +
  'Trajectory "Tools" tab renders the tool catalog the agent loop logged for the session, and ' +
  'the "/" menu resolves skills from the session\'s own composition'

/**
 * A capability inventory with nothing declared but the reason why, so "this agent cannot be
 * enumerated" is never presented as "this agent declares nothing".
 *
 * @param agentId - The agent the inventory is about; it need not be registered.
 * @param reason - Why there is nothing to show.
 * @returns The noted empty inventory.
 */
function emptyInventory(agentId: string, reason: string): AgentCapabilityInventory {
  return {
    agentId: agentId as AgentCapabilityInventory['agentId'],
    tools: [],
    skills: [],
    mcpServers: [],
    commands: [],
    contextFiles: [],
    sources: [],
    notes: [{ field: '*', reason }],
    observedAt: new Date().toISOString(),
  }
}

/** The assembled domain layer. */
export class MutiAgentService {
  readonly state: StateStore
  readonly registry: AgentRegistry
  readonly sessions: SessionIndex
  readonly worktrees: WorktreeManager | undefined
  readonly collaborations: CollaborationStore
  readonly runs: RunManager
  readonly credentials: CredentialService
  readonly log: ScopedLogger
  readonly redactor: Redactor
  private readonly probe: FileProbe
  private readonly git: Git
  private readonly process: ProcessRunner

  /**
   * @param options - Directories, settings and log wiring.
   */
  constructor(private readonly options: ServiceOptions) {
    const redactor = new Redactor(options.secrets ?? [])
    this.redactor = redactor
    const sink = options.logSink ?? stderrSink
    const level = options.logLevel ?? 'info'
    this.log = new ScopedLogger('core', sink, level, redactor)

    this.state = new StateStore(resolveStateRoot({
      ...(options.stateDir === undefined ? {} : { override: options.stateDir }),
      ...(options.harnessHome === undefined ? {} : { harnessHome: options.harnessHome }),
    }), this.log)
    this.process = new ProcessRunner()
    this.probe = new FileProbe()
    this.git = new Git(this.process)
    this.registry = new AgentRegistry(this.log)
    this.sessions = new SessionIndex(this.registry, this.state, this.log)
    const runOptions: RunManagerOptions = { ...DEFAULT_RUNS, ...options.runs }
    if (options.shareContext !== undefined) runOptions.shareContext = options.shareContext

    const worktreeOptions = resolveWorktreeOptions(options)
    this.worktrees = worktreeOptions === undefined
      ? undefined
      : new WorktreeManager(this.git, this.state, worktreeOptions, this.log)

    this.collaborations = new CollaborationStore(this.state, this.log)
    this.runs = new RunManager(
      this.registry,
      this.worktrees,
      this.collaborations,
      this.state,
      runOptions,
      this.log,
      redactor,
    )
    this.credentials = new CredentialService(
      this.registry,
      this.state,
      redactor,
      { probeCli: options.probeCliCredentials ?? true },
      this.log,
    )
  }

  /**
   * Construct and register one adapter.
   *
   * The plugin owns the factory list because each adapter's settings schema is its
   * own; this method only supplies the ambient services and resolved configuration.
   *
   * @param agentId - Adapter id, used to look up its configuration.
   * @param factory - Constructor for the adapter.
   */
  registerAdapter(agentId: string, factory: AdapterFactory): void {
    const settings = this.options.adapters[agentId] ?? {}
    const config: AdapterRuntimeConfig = {
      enabled: settings.enabled ?? true,
      env: settings.env ?? {},
      envMode: settings.envMode ?? 'minimal',
      timeoutMs: settings.timeoutMs ?? 0,
      settings: settings.settings ?? {},
      ...(settings.binaryPath === undefined ? {} : { binaryPath: settings.binaryPath }),
      ...(settings.homeDir === undefined ? {} : { homeDir: settings.homeDir }),
      ...(settings.model === undefined ? {} : { model: settings.model }),
    }
    const logger: Logger = {
      debug: (message, fields) => { this.log.child(agentId).debug(message, fields) },
      warn: (message, fields) => { this.log.child(agentId).warn(message, fields) },
    }
    this.registry.add(factory({
      log: logger,
      config,
      process: this.process,
      files: this.probe,
    }))
  }

  /** Prepare the state directory and load cached session scans. */
  async start(): Promise<void> {
    await this.state.ensure()
    await this.sessions.load()
    this.log.info('muti-agent core ready', {
      stateDir: this.state.root,
      agents: this.registry.ids().join(','),
      isolation: this.worktrees === undefined ? 'disabled' : 'worktree',
    })
  }

  /** Refresh every agent's session index. */
  async refreshSessions(options: { limit?: number; signal?: AbortSignal } = {}): Promise<
    Awaited<ReturnType<SessionIndex['refreshAll']>>
  > {
    return this.sessions.refreshAll(options)
  }

  /** Sample every worktree and return the conflict report for a repository. */
  async worktreeReport(repoRoot: string): Promise<{
    worktrees: Awaited<ReturnType<WorktreeManager['sampleAll']>>
    conflicts: Awaited<ReturnType<WorktreeManager['conflicts']>>
  } | undefined> {
    if (this.worktrees === undefined) return undefined
    const worktrees = await this.worktrees.sampleAll(this.runs.active().map(record => String(record.id)))
    const conflicts = await this.worktrees.conflicts(repoRoot)
    return { worktrees, conflicts }
  }

  /**
   * The model and provider catalog for one agent, or for every agent.
   *
   * A per-agent read failure is reported inside that agent's catalog as a declared gap
   * rather than thrown, because one agent with an unreadable config must not hide the
   * other two.
   *
   * @param agentIds - Agents to read; omitted reads every registered agent.
   * @returns One catalog per requested agent, in registry order.
   */
  async modelCatalogs(agentIds?: readonly string[]): Promise<readonly AgentModelCatalog[]> {
    const requested = agentIds ?? this.registry.ids()
    const catalogs: AgentModelCatalog[] = []
    for (const agentId of requested) {
      const adapter = this.registry.get(agentId)
      if (adapter === undefined) {
        catalogs.push({
          agentId: agentId as AgentModelCatalog['agentId'],
          providers: [],
          models: [],
          sources: [],
          notes: [{ field: '*', reason: `agent "${agentId}" is not available in this process` }],
          observedAt: new Date().toISOString(),
        })
        continue
      }
      try {
        catalogs.push(await adapter.listModels())
      } catch (cause) {
        this.log.warn(`reading the model catalog for ${agentId} failed`, {
          error: cause instanceof Error ? cause.message : String(cause),
        })
        catalogs.push({
          agentId: agentId as AgentModelCatalog['agentId'],
          providers: [],
          models: [],
          sources: [],
          notes: [{
            field: '*',
            reason: `the catalog could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
          }],
          observedAt: new Date().toISOString(),
        })
      }
    }
    return catalogs
  }

  /**
   * The capability inventory for one agent.
   *
   * One read of the agent's own configuration and resource directories: the tools, skills,
   * MCP servers, commands and context files it will offer in a session. A read failure, an
   * agent this process does not carry, and the reserved {@link HARNESS_AGENT} all answer
   * with an empty inventory carrying a `ProjectionNote` that says which of them it was —
   * an unreadable agent must not hide the other agents, and "cannot enumerate" must stay
   * distinguishable from "declares none".
   *
   * @param agentId - Canonical agent id, or the reserved `harness`.
   * @returns The inventory; never throws.
   */
  async capabilities(agentId: string): Promise<AgentCapabilityInventory> {
    if (agentId === HARNESS_AGENT) return emptyInventory(agentId, HARNESS_INVENTORY_NOTE)
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) {
      return emptyInventory(
        agentId,
        `agent "${agentId}" is not available in this process, so nothing of its own configuration could be read`,
      )
    }
    try {
      return await adapter.readCapabilities()
    } catch (cause) {
      this.log.warn(`reading the capability inventory for ${agentId} failed`, {
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return emptyInventory(
        agentId,
        `the capability inventory could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }

  /**
   * The capability inventory for every requested agent, in registry order.
   *
   * Each agent's read degrades on its own, exactly like {@link modelCatalogs}: one agent
   * with an unreadable configuration produces a noted empty inventory while the others
   * answer in full.
   *
   * @param agentIds - Agents to read; omitted reads every registered agent.
   * @returns One inventory per requested agent.
   */
  async capabilityInventories(agentIds?: readonly string[]): Promise<readonly AgentCapabilityInventory[]> {
    const requested = agentIds ?? this.registry.ids()
    const inventories: AgentCapabilityInventory[] = []
    for (const agentId of requested) inventories.push(await this.capabilities(agentId))
    return inventories
  }

  /**
   * Whether a session has begun.
   *
   * @param sessionId - Harness session id.
   * @returns Whether the session carries activity, using the probe the plugin supplied.
   */
  sessionStarted(sessionId: string): boolean {
    return this.options.sessionActivity?.(sessionId) ?? true
  }

  /**
   * Which of these sessions have begun.
   *
   * @param sessionIds - Candidate session ids.
   * @returns The subset that has activity, so a client can render a binding as settled
   *   without having to attempt a change and be refused.
   */
  startedSessions(sessionIds: readonly string[]): readonly string[] {
    return sessionIds.filter(sessionId => this.sessionStarted(sessionId))
  }

  /** The stored operator preferences. */
  async preferences(): Promise<Preferences> {
    return (await this.state.readJson<Preferences>(PREFERENCES_PATH)) ?? {}
  }

  /**
   * Merge preferences and persist the result.
   *
   * @param patch - The fields to change.
   * @param actor - Who asked, recorded in the audit journal.
   * @returns The stored preferences after the change.
   * @throws {MutiAgentError} `schema/invalid` when the patch names an agent this process
   *   does not know — a preference pointing at a nonexistent agent would silently make
   *   every later default fail.
   */
  async setPreferences(patch: Preferences, actor: string): Promise<Preferences> {
    if (
      patch.preferredAgent !== undefined
      && patch.preferredAgent !== HARNESS_AGENT
      && !this.registry.has(patch.preferredAgent)
    ) {
      throw new MutiAgentError(
        ErrorCodes.schemaInvalid,
        `no agent "${patch.preferredAgent}" is registered in this process`,
        {
          details: { agentId: patch.preferredAgent, registered: this.registry.ids().join(',') },
          remediation: 'Choose one of the agents listed by agents.list.',
        },
      )
    }
    for (const agentId of Object.values(patch.agentBySession ?? {})) {
      if (agentId === HARNESS_AGENT || this.registry.has(agentId)) continue
      throw new MutiAgentError(
        ErrorCodes.schemaInvalid,
        `no agent "${agentId}" is registered in this process`,
        {
          details: { agentId, registered: [...this.registry.ids(), HARNESS_AGENT].join(',') },
          remediation: 'Choose one of the agents listed by agents.list, or the reserved "harness".',
        },
      )
    }
    for (const agentId of Object.keys(patch.preferredModelByAgent ?? {})) {
      if (this.registry.has(agentId)) continue
      throw new MutiAgentError(
        ErrorCodes.schemaInvalid,
        `no agent "${agentId}" is registered in this process`,
        {
          details: { agentId, registered: this.registry.ids().join(',') },
          remediation: 'Choose one of the agents listed by agents.list.',
        },
      )
    }
    // A session's agent may be changed while the conversation has not begun, and not after.
    // The refusal lives here rather than in the control because the rule is about the session
    // rather than about one client: an MCP caller must not re-point a conversation whose work
    // is already under way either.
    const existing = await this.preferences()
    for (const [sessionId, agentId] of Object.entries(patch.agentBySession ?? {})) {
      const bound = existing.agentBySession?.[sessionId]
      if (bound === undefined || bound === agentId) continue
      if (!this.sessionStarted(sessionId)) continue
      throw new MutiAgentError(
        ErrorCodes.sessionAgentLocked,
        `session ${sessionId} has started and is bound to ${bound}`,
        {
          details: { sessionId, bound, requested: agentId },
          remediation: 'Start a new conversation to use another agent; a conversation already under way keeps the agent it began with.',
        },
      )
    }
    const next: Preferences = { ...(await this.preferences()), ...patch }
    await this.state.writeJson(PREFERENCES_PATH, next)
    this.state.appendJournal({
      at: new Date().toISOString(),
      kind: 'preferences.set',
      actor,
      detail: { keys: Object.keys(patch).join(',') },
    })
    return next
  }

  /** Path of the state directory, for display. */
  get stateRoot(): string {
    return this.state.root
  }

  /** Where a run-scoped artifact would live, for diagnostics. */
  runPath(runId: string): string {
    return join(this.state.root, 'runs', `${runId}.json`)
  }
}

/**
 * Resolve worktree options, honoring the `enabled` flag.
 *
 * @param options - Service options carrying the worktree block.
 * @returns Effective options, or `undefined` when isolation is disabled.
 */
function resolveWorktreeOptions(options: ServiceOptions): WorktreeOptions | undefined {
  const block = options.worktree
  if (block?.enabled === false) return undefined
  const stateRoot = resolveStateRoot({
    ...(options.stateDir === undefined ? {} : { override: options.stateDir }),
    ...(options.harnessHome === undefined ? {} : { harnessHome: options.harnessHome }),
  })
  return {
    location: block?.location ?? 'in-repo',
    stateRoot: block?.stateRoot ?? stateRoot,
    conflictPolicy: block?.conflictPolicy ?? 'report',
    featureBoundaries: block?.featureBoundaries ?? [],
    autoIntegrate: block?.autoIntegrate ?? false,
    ...(block?.baseRef === undefined ? {} : { baseRef: block.baseRef }),
  }
}
