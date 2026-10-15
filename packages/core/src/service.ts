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
   * Concrete secrets to redact from every output. Seeded from values the user typed
   * into settings during this process's lifetime.
   */
  secrets?: readonly string[]
}

/** Concrete adapters are constructed by the plugin, because each needs its own config type. */
export type AdapterFactory = (context: AdapterContext) => AgentAdapter

const DEFAULT_RUNS: RunManagerOptions = {
  maxParallel: 4,
  historyLimit: 200,
  shareContext: true,
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
