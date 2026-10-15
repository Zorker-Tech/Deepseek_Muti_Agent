/**
 * The Grok Build (xAI `grok`) adapter: the one module that knows both the canonical
 * schema and grok's own surfaces (ADR-0002).
 *
 * Transport: `grok -p "<prompt>" --output-format streaming-json`, NDJSON on stdout,
 * mapped line by line onto the canonical event union (ADR-0003). Every dispatch passes
 * `--cwd`, so MutiAgent owns worktree isolation and grok's `-w/--worktree` is never
 * used; `externalWorktree` is therefore declared `false`.
 *
 * @module @zorker/muti-agent-adapter-grok
 */

import { join } from 'node:path'
import type {
  AgentAuthState,
  AgentCapabilities,
  AgentDescriptor,
  AgentMessage,
  AgentModelCatalog,
  AgentRunEvent,
  AgentSession,
  AgentTransport,
  AuthOperationResult,
  NativeSessionId,
  ProjectionNote,
  RunHandle,
  RunId,
  RunResult,
} from '@zorker/muti-agent-contracts'
import { ErrorCodes, MutiAgentError, agentId, nativeSessionId, runId as brandRunId, sessionKey } from '@zorker/muti-agent-contracts'
import type {
  AdapterContext,
  AdapterRun,
  AdapterRunRequest,
  AgentAdapter,
  BinaryResolution,
  ListSessionsOptions,
  LoginParams,
  ManagedProcess,
  NativeTaskState,
  ProcessSpec,
  ReadTranscriptOptions,
} from '@zorker/muti-agent-core'
import { Redactor, buildEnvironment, detectionFrom, jsonLines, probeVersion, resolveBinary } from '@zorker/muti-agent-core'
import { GROK_MANAGED_ENV_KEYS, GrokAuthService } from './auth.ts'
import { classifyGrokFailure, createStreamState, mapStreamingJsonLine } from './events.ts'
import type { GrokStreamState } from './events.ts'
import { readGrokModelCatalog } from './models.ts'
import {
  findGrokSessionDir,
  listGrokSessions,
  readGrokNativeTasks,
  readGrokTranscript,
  resolveGrokPaths,
} from './sessions.ts'
import type { GrokPaths, GrokSessionDirectory } from './sessions.ts'

/** Canonical agent id. */
export const GROK_ID = 'grok'

/** Human name of the product behind this adapter. */
export const GROK_DISPLAY_NAME = 'Grok Build'

/** Streaming-json lines can carry one large tool payload; the splitter bounds each line. */
const MAX_STREAM_LINE_BYTES = 8 * 1024 * 1024

/** Captured stderr kept on a failed run's error record, after redaction. */
const ERROR_OUTPUT_CHARS = 2 * 1024

/** Detection result, resolved once and cached for the adapter's lifetime. */
interface GrokDetection {
  paths: GrokPaths
  binary: BinaryResolution
  detection: AgentDescriptor['detection']
}

/**
 * One Grok Build adapter.
 *
 * `describe()` and every path it needs are resolved once; capability declaration never
 * touches the filesystem.
 */
export class GrokAdapter implements AgentAdapter {
  readonly id = GROK_ID
  readonly displayName = GROK_DISPLAY_NAME

  private detection: Promise<GrokDetection> | undefined
  private binary: string | undefined

  /**
   * @param ctx - Logger, resolved configuration, process runner and file probe.
   */
  constructor(private readonly ctx: AdapterContext) {}

  /**
   * @returns The declared capability set; never depends on detection.
   */
  capabilities(): AgentCapabilities {
    return {
      runModes: ['headless-exec'],
      streaming: true,
      resume: true,
      interrupt: false,
      listSessions: true,
      readTranscript: true,
      nativeTodos: true,
      nativePlan: true,
      // grok has its own worktrees, but MutiAgent always creates the worktree and
      // passes --cwd, so grok is never asked to accept a foreign one.
      externalWorktree: false,
      mcpClient: true,
      listModels: true,
      sandboxProfiles: ['off', 'workspace', 'devbox', 'read-only', 'strict'],
      approvalModes: ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'],
      credentials: {
        status: true,
        // grok has no non-interactive api-key login, so `api-key` is not declared;
        // `interactive` is what a settings page offers as "open native login".
        login: ['oauth-loopback', 'device-code', 'interactive'],
        logout: true,
      },
    }
  }

  /**
   * @returns The full descriptor, with detection cached after the first call.
   */
  async describe(): Promise<AgentDescriptor> {
    const { paths, detection } = await this.detect()
    const transports: readonly AgentTransport[] = [
      { mode: 'headless-exec', mechanism: 'grok -p --output-format streaming-json', available: true },
      {
        mode: 'duplex-protocol',
        mechanism:
          'grok agent stdio (ACP JSON-RPC) — known but not implemented in v0.1; every dispatch uses the headless transport',
        available: false,
      },
    ]
    return {
      id: agentId(GROK_ID),
      displayName: this.displayName,
      summary: 'Grok Build by xAI: headless `grok -p` dispatches, sessions under $GROK_HOME/sessions, plan and todo state on disk.',
      capabilities: this.capabilities(),
      detection,
      transports,
      environmentKeys: GROK_MANAGED_ENV_KEYS,
      sessionRoot: paths.sessionRoot,
      credentialPath: paths.credentialPath,
    }
  }

  /**
   * Enumerate grok's own sessions.
   *
   * @param options - cwd filter, newest-first limit and a cancellation signal.
   * @returns The projected sessions, sorted by `updated_at` descending.
   */
  async listSessions(options: ListSessionsOptions): Promise<readonly AgentSession[]> {
    const { paths } = await this.detect()
    if (!(await this.ctx.files.isDirectory(paths.sessionRoot))) {
      this.ctx.log.debug('grok session root is absent', { sessionRoot: paths.sessionRoot })
      return []
    }
    return listGrokSessions({ files: this.ctx.files, paths, options, log: this.ctx.log })
  }

  /**
   * Read a bounded transcript window from `updates.jsonl`.
   *
   * @param nativeId - Grok's session id (UUIDv7), verbatim.
   * @param options - Message and byte caps.
   * @returns The window plus declared projection gaps.
   * @throws {MutiAgentError} `session/not-found` when no session directory holds that id.
   */
  async readTranscript(
    nativeId: NativeSessionId,
    options: ReadTranscriptOptions,
  ): Promise<{
    messages: readonly AgentMessage[]
    totalMessages?: number
    hasMore: boolean
    notes: readonly ProjectionNote[]
  }> {
    const dir = await this.requireSessionDir(String(nativeId))
    return readGrokTranscript({
      files: this.ctx.files,
      sessionDir: dir.dir,
      options,
      ...(dir.messageCount === undefined ? {} : { totalMessages: dir.messageCount }),
    })
  }

  /**
   * Read grok's own todo and plan-mode state.
   *
   * @param nativeId - Grok's session id.
   * @returns The observed state, or `undefined` when the session recorded neither file.
   * @throws {MutiAgentError} `session/not-found` when no session directory holds that id.
   */
  async readNativeTasks(nativeId: NativeSessionId): Promise<NativeTaskState | undefined> {
    const dir = await this.requireSessionDir(String(nativeId))
    return readGrokNativeTasks({
      files: this.ctx.files,
      sessionDir: dir.dir,
      observedIn: sessionKey(agentId(GROK_ID), nativeSessionId(String(nativeId))),
    })
  }

  /**
   * Read grok's configured model and provider catalog.
   *
   * Read from grok's own configuration files in grok's precedence order, the
   * `GROK_CONFIG`/`GROK_CONFIG_PATH` overlays, and the credential store's presence;
   * no network call is made, so the catalog is the configured subset of what the
   * endpoint serves (ADR-0002, ADR-0012).
   *
   * @returns The catalog; an absent or unparseable file is a declared gap, never an error.
   */
  async listModels(): Promise<AgentModelCatalog> {
    const { paths } = await this.detect()
    return await readGrokModelCatalog({
      files: this.ctx.files,
      paths,
      hostEnv: process.env,
      cwd: process.cwd(),
      log: this.ctx.log,
    })
  }

  /**
   * @returns The observed credential state, from the store, the environment, or a CLI probe.
   */
  async authStatus(): Promise<AgentAuthState> {
    return (await this.authService()).status()
  }

  /**
   * Start a credential flow through `grok login`.
   *
   * @param params - The flow to run; a flow grok cannot complete non-interactively is
   *   returned with the interaction a human must perform.
   * @returns The observed post-state.
   */
  async login(params: LoginParams): Promise<AuthOperationResult> {
    return (await this.authService()).login(params)
  }

  /**
   * @returns Whether `grok logout` succeeded, plus the observed post-state.
   */
  async logout(): Promise<AuthOperationResult> {
    return (await this.authService()).logout()
  }

  /**
   * Dispatch one headless run.
   *
   * @param request - Run id, cwd, prompt, and optional model, sandbox, approval,
   *   resume id and environment additions.
   * @returns A live run whose events end with exactly one `run.finished`.
   * @throws {MutiAgentError} `run/start-failed` when the binary cannot be spawned.
   */
  async run(request: AdapterRunRequest): Promise<AdapterRun> {
    const { paths } = await this.detect()
    const command = await this.binaryPath()
    const args = this.runArgs(request)
    const env = this.childEnvironment(paths, request.env)
    const envMode = this.ctx.config.envMode
    const budget = request.timeoutMs ?? this.ctx.config.timeoutMs
    const spec: ProcessSpec = {
      command,
      args,
      cwd: request.cwd,
      envMode,
      env,
      inheritKeys: GROK_MANAGED_ENV_KEYS,
      ...(budget > 0 ? { timeoutMs: budget } : {}),
    }
    // Only a new session needs the directory diff that recovers an unobserved id.
    const before = request.resumeNativeId === undefined ? await this.sessionSnapshot(paths) : undefined

    const state = createStreamState()
    const notes: string[] = [...this.runNotes(request)]
    const queue = new EventQueue()
    const deferred = createDeferred<RunResult>()
    const startedAt = Date.now()
    const startedAtIso = new Date(startedAt).toISOString()
    const runId = brandRunId(request.runId)
    const resumeId = request.resumeNativeId === undefined ? undefined : nativeSessionId(request.resumeNativeId)
    const argv: readonly string[] = [command, ...args]
    const environmentKeys = buildEnvironment({ env, envMode, inheritKeys: GROK_MANAGED_ENV_KEYS }, process.env).names

    const child = this.ctx.process.start(spec)
    queue.push({
      kind: 'run.started',
      runId,
      agentId: agentId(GROK_ID),
      at: startedAtIso,
      ...(resumeId === undefined ? {} : { nativeSessionId: resumeId }),
    })

    // Started synchronously so the stdout iterator attaches before the first chunk.
    const pumping = this.pump({
      request,
      runId,
      argv,
      child,
      state,
      queue,
      notes,
      before,
      paths,
      startedAt,
      environmentKeys,
    })
    void pumping.then(result => { deferred.resolve(result) })

    return {
      argv,
      environmentKeys,
      events: queue,
      result: deferred.promise,
      cancel: (reason?: string): void => {
        this.ctx.log.debug('cancelling a grok run', {
          runId: request.runId,
          ...(reason === undefined ? {} : { reason }),
        })
        child.kill('cancel')
      },
    }
  }

  /**
   * Argv that opens grok's own TUI, optionally resuming a session.
   *
   * @param nativeId - Session to resume; omitted opens a fresh session.
   * @returns The launch argv, resolved against the cached detection when available.
   */
  nativeLaunchCommand(nativeId?: NativeSessionId): readonly string[] {
    const binary = this.cachedBinaryPath() ?? this.ctx.config.binaryPath ?? GROK_ID
    return nativeId === undefined ? [binary] : [binary, '--resume', String(nativeId)]
  }

  /** Consume stdout, then settle the run exactly once. */
  private async pump(params: {
    request: AdapterRunRequest
    runId: RunId
    argv: readonly string[]
    child: ManagedProcess
    state: GrokStreamState
    queue: EventQueue
    notes: string[]
    before: ReadonlyMap<string, number> | undefined
    paths: GrokPaths
    startedAt: number
    environmentKeys: readonly string[]
  }): Promise<RunResult> {
    try {
      await this.drainStdout(params)
    } catch (cause) {
      params.queue.push({
        kind: 'warning',
        runId: params.runId,
        at: new Date().toISOString(),
        message: `the streaming-json reader stopped early: ${describe(cause)}`,
      })
    }
    try {
      return await this.settle(params)
    } catch (cause) {
      return this.settleUnexpected(params, cause)
    }
  }

  /** Forward every mapped line until the child closes stdout. */
  private async drainStdout(params: {
    runId: RunId
    child: ManagedProcess
    state: GrokStreamState
    queue: EventQueue
  }): Promise<void> {
    const stdout = params.child.stdout
    if (stdout === null) return
    const emit = (event: AgentRunEvent): void => { params.queue.push(event) }
    const stream = jsonLines(stdout, {
      maxLineBytes: MAX_STREAM_LINE_BYTES,
      onError: (error, lineNumber) => {
        emit({
          kind: 'warning',
          runId: params.runId,
          at: new Date().toISOString(),
          message: `streaming-json line ${String(lineNumber)} could not be parsed: ${error}`,
        })
      },
      onOverflow: dropped => {
        emit({
          kind: 'warning',
          runId: params.runId,
          at: new Date().toISOString(),
          message: `an over-long streaming-json line dropped ${String(dropped)} bytes`,
        })
      },
    })
    for await (const line of stream) {
      for (const event of mapStreamingJsonLine(line.value, { runId: params.runId, at: new Date().toISOString() }, params.state)) {
        emit(event)
      }
    }
  }

  /** Await the process, bind the session, classify the exit and emit the terminal event. */
  private async settle(params: {
    request: AdapterRunRequest
    runId: RunId
    argv: readonly string[]
    child: ManagedProcess
    state: GrokStreamState
    queue: EventQueue
    notes: string[]
    before: ReadonlyMap<string, number> | undefined
    paths: GrokPaths
    startedAt: number
    environmentKeys: readonly string[]
  }): Promise<RunResult> {
    const { runId, request, state } = params
    const emit = (event: AgentRunEvent): void => { params.queue.push(event) }

    const outcome = await params.child.outcome
    const finishedAt = Date.now()
    const observed =
      state.sessionId ?? (params.before === undefined ? undefined : await this.newSessionId(params.paths, params.before))
    const finalId = observed ?? request.resumeNativeId
    if (observed !== undefined && observed !== request.resumeNativeId) {
      emit({ kind: 'session.bound', runId, at: new Date(finishedAt).toISOString(), nativeSessionId: nativeSessionId(observed) })
    }
    if (finalId === undefined) {
      emit({
        kind: 'warning',
        runId,
        at: new Date(finishedAt).toISOString(),
        message:
          'the native session id could not be observed: no `sessionId` on the end line and no session directory gained files during the run, so this run is unbound and cannot be resumed',
      })
      params.notes.push('the native session id could not be observed; the run cannot be resumed')
    }
    if (params.request.isolation === 'worktree') {
      params.notes.push('the run executed in a MutiAgent worktree passed with --cwd; grok -w/--worktree is never used')
    }
    if (params.request.resumeNativeId === undefined && state.usage === undefined) {
      params.notes.push('grok reported no token usage for this run')
    }
    if (state.cacheCreationTokens !== undefined) {
      params.notes.push(
        `grok reported ${String(state.cacheCreationTokens)} cache-creation input tokens, which the canonical usage record has no field for`,
      )
    }
    if (!state.ended) {
      params.notes.push('the streaming-json stream ended without an `end` line; terminal metadata and usage may be missing')
    }

    const failure = classifyGrokFailure({
      exitCode: outcome.code,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      stderrTail: `${outcome.stderr.head}${outcome.stderr.tail}`,
      errorMessage: state.errorMessage,
    })
    if (failure === undefined && state.stopReason === 'refusal') {
      emit({
        kind: 'warning',
        runId,
        at: new Date(finishedAt).toISOString(),
        message: 'grok stopped with a refusal; the task was not completed',
      })
    }

    const handle: RunHandle = {
      id: runId,
      agentId: agentId(GROK_ID),
      ...(finalId === undefined ? {} : { sessionKey: sessionKey(agentId(GROK_ID), nativeSessionId(finalId)) }),
      status:
        failure === undefined
          ? 'succeeded'
          : failure.code === ErrorCodes.runCancelled
            ? 'cancelled'
            : failure.code === ErrorCodes.runTimeout
              ? 'timeout'
              : 'failed',
      startedAt: new Date(params.startedAt).toISOString(),
      cwd: request.cwd,
      isolation: request.isolation,
      argv: params.argv,
      environmentKeys: params.environmentKeys,
    }
    const usage = state.usage
    const output = errorOutput(outcome)
    const result: RunResult = {
      handle,
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - params.startedAt,
      ...(outcome.code === undefined ? {} : { exitCode: outcome.code }),
      ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
      ...(state.text === '' ? {} : { finalText: state.text }),
      ...(usage === undefined ? {} : { usage }),
      ...(failure === undefined
        ? {}
        : {
            error: {
              code: failure.code,
              message: failure.message,
              remediation: failure.remediation,
              ...(output === '' ? {} : { output }),
            },
          }),
      notes: [...params.notes, ...state.notes],
    }

    if (state.text !== '') {
      emit({ kind: 'message.completed', runId, at: result.finishedAt, text: state.text })
    }
    emit({ kind: 'run.finished', runId, at: result.finishedAt, result })
    params.queue.end()
    return result
  }

  /** Build argv for one dispatch. */
  private runArgs(request: AdapterRunRequest): readonly string[] {
    const settings = this.ctx.config.settings
    const args: string[] = []
    if (request.prompt.startsWith('-')) {
      // clap reads a leading '-' as a flag; the equals form is the value unambiguously.
      args.push(`--single=${request.prompt}`)
    } else {
      args.push('-p', request.prompt)
    }
    args.push('--output-format', 'streaming-json')
    // grok records the session's cwd; passing it explicitly keeps the record correct
    // even when the process cwd would differ.
    args.push('--cwd', request.cwd)

    const model = request.model ?? this.ctx.config.model
    if (model !== undefined && model !== '') args.push('-m', model)

    const sandbox = request.sandbox ?? settingText(settings, 'sandbox')
    if (sandbox !== undefined) args.push('--sandbox', sandbox)

    const approval = request.approval ?? settingText(settings, 'approval')
    if (approval === 'bypassPermissions') args.push('--always-approve')
    else if (approval !== undefined) args.push('--permission-mode', approval)

    const maxTurns = settingNumber(settings, 'maxTurns')
    if (maxTurns !== undefined) args.push('--max-turns', String(maxTurns))

    const effort = settingText(settings, 'reasoningEffort')
    if (effort !== undefined) args.push('--reasoning-effort', effort)

    if (request.resumeNativeId !== undefined) args.push('-r', request.resumeNativeId)
    // Headless grok parses these but only the interactive pager consumes them; they are
    // passed anyway so a configured intent is visible in the run's argv.
    if (settings.noPlan === true) args.push('--no-plan')
    if (settings.noSubagents === true) args.push('--no-subagents')
    if (settings.disableWebSearch === true) args.push('--disable-web-search')
    return args
  }

  /** Projection gaps that hold for every run matching this request. */
  private runNotes(request: AdapterRunRequest): readonly string[] {
    const settings = this.ctx.config.settings
    const notes: string[] = []
    if (settings.noPlan === true || settings.noSubagents === true) {
      notes.push('grok accepts --no-plan/--no-subagents in headless mode but only its interactive pager applies them')
    }
    if (request.sandbox === undefined && request.resumeNativeId !== undefined) {
      notes.push("no sandbox override was requested, so the resumed session's recorded profile applies")
    }
    if (request.approval === undefined) {
      notes.push("no approval mode was requested, so grok's own configured permission mode applies")
    }
    return notes
  }

  /** Read the whole sessions tree into `session directory path -> mtime`. */
  private async sessionSnapshot(paths: GrokPaths): Promise<ReadonlyMap<string, number>> {
    const snapshot = new Map<string, number>()
    for (const cwdDir of await this.ctx.files.listDir(paths.sessionRoot)) {
      if (!cwdDir.isDirectory) continue
      for (const sessionDir of await this.ctx.files.listDir(cwdDir.path)) {
        if (!sessionDir.isDirectory) continue
        snapshot.set(sessionDir.path, sessionDir.mtimeMs)
      }
    }
    return snapshot
  }

  /** The session id of a directory that appeared or changed during the run. */
  private async newSessionId(paths: GrokPaths, before: ReadonlyMap<string, number>): Promise<string | undefined> {
    const after = await this.sessionSnapshot(paths)
    const gained: { id: string; mtimeMs: number }[] = []
    for (const [path, mtimeMs] of after) {
      if (before.get(path) === mtimeMs) continue
      gained.push({ id: this.ctx.files.baseName(path), mtimeMs })
    }
    // Another process can create a session concurrently; the newest one is this run's.
    gained.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return gained[0]?.id
  }

  /** Terminal state for a failure that happened while projecting the stream. */
  private settleUnexpected(
    params: {
      request: AdapterRunRequest
      runId: RunId
      argv: readonly string[]
      queue: EventQueue
      notes: string[]
      startedAt: number
      environmentKeys: readonly string[]
    },
    cause: unknown,
  ): RunResult {
    const at = new Date().toISOString()
    const result: RunResult = {
      handle: {
        id: params.runId,
        agentId: agentId(GROK_ID),
        status: 'failed',
        startedAt: new Date(params.startedAt).toISOString(),
        cwd: params.request.cwd,
        isolation: params.request.isolation,
        argv: params.argv,
        environmentKeys: params.environmentKeys,
      },
      finishedAt: at,
      durationMs: Date.now() - params.startedAt,
      error: {
        code: ErrorCodes.runProtocolError,
        message: `the run could not be settled: ${describe(cause)}`,
        remediation: 'Open the run record; the adapter stopped while projecting the native stream.',
      },
      notes: params.notes,
    }
    params.queue.push({ kind: 'run.finished', runId: params.runId, at, result })
    params.queue.end()
    return result
  }

  /** Resolve (and cache) binary, version, home and credential paths. */
  private async detect(): Promise<GrokDetection> {
    if (this.detection === undefined) this.detection = this.runDetection()
    return await this.detection
  }

  /** One detection pass; never rejects, so a broken install still yields a descriptor. */
  private async runDetection(): Promise<GrokDetection> {
    const override = this.ctx.config.homeDir
    const paths = resolveGrokPaths({
      ...(override === undefined || override === '' ? {} : { homeDir: override }),
      env: process.env,
      files: this.ctx.files,
    })
    const configured = this.ctx.config.binaryPath
    const binary = await resolveBinary(GROK_ID, {
      ...(configured === undefined || configured === '' ? {} : { candidates: [configured] }),
    })
    if (!binary.found || binary.path === undefined) {
      this.ctx.log.warn('the grok binary was not found', { ...(binary.reason === undefined ? {} : { reason: binary.reason }) })
      return { paths, binary, detection: detectionFrom(binary, { homeDir: paths.home }) }
    }
    this.binary = binary.path
    const version = await probeVersion(this.ctx.process, binary.path)
    return {
      paths,
      binary,
      detection: detectionFrom(binary, { ...(version === undefined ? {} : { version }), homeDir: paths.home }),
    }
  }

  /** The resolved binary path, from the cache when detection already ran. */
  private cachedBinaryPath(): string | undefined {
    return this.binary
  }

  /** Resolve the binary, throwing a classified error when it is missing. */
  private async binaryPath(): Promise<string> {
    const { binary } = await this.detect()
    if (binary.found && binary.path !== undefined) return binary.path
    throw new MutiAgentError(ErrorCodes.detectionNotFound, 'the grok binary was not found', {
      remediation: 'Install Grok Build, or set the adapter binary path in settings.',
      ...(binary.reason === undefined ? {} : { cause: binary.reason }),
    })
  }

  /** The environment every grok child receives: same store, same resolved policy. */
  private childEnvironment(paths: GrokPaths, extra?: Readonly<Record<string, string>>): Record<string, string> {
    const sandbox = settingText(this.ctx.config.settings, 'sandbox')
    const defaultAuthPath = join(paths.home, 'auth.json')
    return {
      GROK_HOME: paths.home,
      ...(paths.credentialPath === defaultAuthPath ? {} : { GROK_AUTH_PATH: paths.credentialPath }),
      ...(sandbox === undefined ? {} : { GROK_SANDBOX: sandbox }),
      ...this.ctx.config.env,
      ...(extra ?? {}),
    }
  }

  /** Build the credential service against the cached detection. */
  private async authService(): Promise<GrokAuthService> {
    const { paths } = await this.detect()
    return new GrokAuthService({
      files: this.ctx.files,
      runner: this.ctx.process,
      paths,
      hostEnv: process.env,
      childEnv: this.childEnvironment(paths),
      envMode: this.ctx.config.envMode,
      probeCli: this.ctx.config.settings.probeCli !== false,
      log: this.ctx.log,
      resolveBinary: () => this.binaryPath(),
    })
  }

  /** Locate a session directory or fail with the canonical code. */
  private async requireSessionDir(nativeId: string): Promise<GrokSessionDirectory> {
    const { paths } = await this.detect()
    const dir = await findGrokSessionDir({ files: this.ctx.files, paths, nativeId })
    if (dir === undefined) {
      throw new MutiAgentError(ErrorCodes.sessionNotFound, `grok has no session ${nativeId}`, {
        details: { nativeId, sessionRoot: paths.sessionRoot },
        remediation: 'List the sessions again; the native record may have been deleted or moved.',
      })
    }
    return dir
  }
}

/**
 * Create the Grok Build adapter.
 *
 * @param ctx - Ambient services the core exposes to adapters.
 * @returns A ready adapter; detection happens lazily on first `describe()`.
 */
export function createGrokAdapter(ctx: AdapterContext): GrokAdapter {
  return new GrokAdapter(ctx)
}

/** Single-consumer, unbounded event queue that decouples the pump from its consumer. */
class EventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly buffered: AgentRunEvent[] = []
  private readonly waiting: ((result: IteratorResult<AgentRunEvent, undefined>) => void)[] = []
  private closed = false

  /**
   * @param event - Event to deliver, or buffer until a consumer attaches.
   */
  push(event: AgentRunEvent): void {
    if (this.closed) return
    const waiter = this.waiting.shift()
    if (waiter === undefined) {
      this.buffered.push(event)
      return
    }
    waiter({ value: event, done: false })
  }

  /** Complete the iteration; further pushes are ignored. */
  end(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
    return {
      next: async (): Promise<IteratorResult<AgentRunEvent, undefined>> => {
        const buffered = this.buffered.shift()
        if (buffered !== undefined) return { value: buffered, done: false }
        if (this.closed) return { value: undefined, done: true }
        return await new Promise<IteratorResult<AgentRunEvent, undefined>>(resolve => {
          this.waiting.push(resolve)
        })
      },
    }
  }
}

/** A promise plus its resolver, without a non-null assertion. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settle: ((value: T) => void) | undefined
  const promise = new Promise<T>(resolve => {
    settle = resolve
  })
  return {
    promise,
    resolve: value => {
      settle?.(value)
    },
  }
}

/** A non-empty string setting. */
function settingText(settings: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = settings[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A finite number setting. */
function settingNumber(settings: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = settings[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Message of an arbitrary thrown value. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Redacted, capped stderr tail for a failed run's error record. */
function errorOutput(outcome: { stderr: { head: string; tail: string; droppedBytes: number } }): string {
  const text = outcome.stderr.droppedBytes === 0
    ? outcome.stderr.head
    : `${outcome.stderr.head}\n[output omitted]\n${outcome.stderr.tail}`
  const redacted = new Redactor().apply(text).trim()
  return redacted.length > ERROR_OUTPUT_CHARS ? redacted.slice(redacted.length - ERROR_OUTPUT_CHARS) : redacted
}
