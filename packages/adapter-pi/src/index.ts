/**
 * The Pi adapter: one `AgentAdapter` over `@earendil-works/pi-coding-agent`, implementing
 * the SPI in `@zorker/muti-agent-core` (ADR-0002).
 *
 * Transport: `pi --mode json` (a headless, one-shot JSONL stream) for runs, and pi's own
 * session files for discovery and transcript reading. `pi --mode rpc` exists and is
 * declared as an unavailable transport: it needs a long-lived duplex session, which is the
 * per-adapter opt-in ADR-0003 describes, not part of this pass.
 *
 * The model catalog comes from pi's own files (`models.json` providers and their models,
 * `settings.json`'s default model and enabled scope); pi's built-in catalog is deliberately
 * never read, so the catalog describes what this machine is configured to run.
 *
 * Three verified behaviours shape `run()`:
 *
 * - The prompt is written to **stdin**, never argv: that keeps it out of the process table
 *   and out of `ARG_MAX`, and pi reads piped stdin as its initial message. Context blocks
 *   are composed into that prompt by the orchestrator, so `--append-system-prompt` is
 *   deliberately unused.
 * - A resume passes the session **file path** rather than the bare id. With an id, pi
 *   resolves the session and, when it does not belong to the process's project directory,
 *   asks an interactive "fork this session into current directory?" question; with stdin
 *   closed that question is never answered and pi exits 0 having done nothing. The path
 *   form skips resolution entirely, so a resume in the session's own directory is quiet
 *   and reliable.
 * - Pi's JSON mode exits 0 even when the last assistant response failed, so the terminal
 *   classification also reads the stream's own stop reason, not only the exit code.
 *
 * @module @zorker/muti-agent-adapter-pi
 */

import { randomBytes } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import {
  ErrorCodes,
  agentId as brandAgentId,
  nativeSessionId,
  runId as brandRunId,
  sessionKey,
  type AgentAuthState,
  type AgentCapabilities,
  type AgentDescriptor,
  type AgentId,
  type AgentModelCatalog,
  type AgentRunEvent,
  type AgentSession,
  type AuthOperationResult,
  type NativeSessionId,
  type ProjectionNote,
  type RunHandle,
  type RunId,
  type RunResult,
  type RunStatus,
  type SessionUsage,
} from '@zorker/muti-agent-contracts'
import {
  buildEnvironment,
  detectionFrom,
  jsonLines,
  probeVersion,
  resolveBinary,
  type AdapterContext,
  type AdapterRun,
  type AdapterRunRequest,
  type AgentAdapter,
  type ListSessionsOptions,
  type LoginParams,
  type ManagedProcess,
  type NativeTaskState,
  type ProcessSpec,
  type ReadTranscriptOptions,
} from '@zorker/muti-agent-core'
import { loginPi, logoutPi, readPiAuthStatus } from './auth.ts'
import { PiRunProjection } from './events.ts'
import { readPiModelCatalog } from './models.ts'
import {
  findPiSessionFile,
  listPiSessions,
  parsePiSettings,
  readPiNativeTasks,
  readPiSessionHeaderAt,
  readPiTranscript,
  resolvePiStore,
  type PiStoreLayout,
  type PiTranscript,
} from './sessions.ts'

/** Canonical agent id. */
export const PI_ID = 'pi'

/** Human name. */
export const PI_DISPLAY_NAME = 'Pi'

/** Binary name pi publishes; resolved through `PATH` unless the config overrides it. */
export const PI_BINARY = 'pi'

/** Environment variable names this adapter resolves for a run; never values. */
export const PI_RUN_ENVIRONMENT_KEYS: readonly string[] = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']

/** How many bytes of native stderr are attached to a failed run's result. */
const MAX_STDERR_CHARS = 2_000

/** Cap on the model-listing probe, which may reach the network. */
const LIST_MODELS_TIMEOUT_MS = 20_000

/** The capability declaration, literal because consumers branch on it (ADR-0002). */
const PI_CAPABILITIES: AgentCapabilities = {
  runModes: ['headless-exec'],
  streaming: true,
  resume: true,
  interrupt: false,
  listSessions: true,
  readTranscript: true,
  nativeTodos: false,
  nativePlan: false,
  externalWorktree: false,
  mcpClient: true,
  listModels: true,
  sandboxProfiles: [],
  approvalModes: ['default', 'approve'],
  credentials: { status: true, login: ['interactive'], logout: false },
}

/** One row of `pi --list-models`, with its values verbatim. */
export interface PiModelEntry {
  /** Provider id, verbatim. */
  provider: string
  /** Model id, verbatim. */
  id: string
  /** Context window as pi prints it, e.g. `200K`. */
  contextWindow?: string
  /** Maximum output tokens as pi prints it. */
  maxOutput?: string
  /** Whether the model supports thinking levels. */
  thinking: boolean
  /** Whether the model accepts image input. */
  images: boolean
}

/** The result of a model-listing probe. */
export interface PiModelListing {
  models: readonly PiModelEntry[]
  notes: readonly ProjectionNote[]
}

/**
 * Pi's adapter. Construct through {@link createPiAdapter}; the constructor is public so a
 * test can inject an environment.
 */
export class PiAdapter implements AgentAdapter {
  readonly id: string = PI_ID
  readonly displayName: string = PI_DISPLAY_NAME

  private readonly agent: AgentId = brandAgentId(PI_ID)
  private described: AgentDescriptor | undefined

  /**
   * @param ctx - Ambient core services: logger, config, process runner, file probe.
   * @param env - Host environment to resolve the store and detection from.
   */
  constructor(
    private readonly ctx: AdapterContext,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * The static capability declaration.
   *
   * @returns The literal declaration; never detection-dependent.
   */
  capabilities(): AgentCapabilities {
    return PI_CAPABILITIES
  }

  /**
   * Describe this agent, including detection on this machine. Detection is cached because
   * the catalog is queried on every GUI load and the probe spawns a process.
   *
   * @returns The descriptor.
   */
  async describe(): Promise<AgentDescriptor> {
    if (this.described !== undefined) return this.described
    const layout = await this.layout()
    const resolution = await resolveBinary(PI_BINARY, {
      ...(this.ctx.config.binaryPath === undefined ? {} : { candidates: [this.ctx.config.binaryPath] }),
      env: this.env,
    })
    const version =
      resolution.found && resolution.path !== undefined
        ? await probeVersion(this.ctx.process, resolution.path)
        : undefined
    const descriptor: AgentDescriptor = {
      id: this.agent,
      displayName: this.displayName,
      summary: 'Pi (@earendil-works/pi-coding-agent): a coding agent whose sessions are append-only JSONL trees.',
      capabilities: PI_CAPABILITIES,
      detection: detectionFrom(resolution, {
        ...(version === undefined ? {} : { version }),
        homeDir: layout.agentDir,
      }),
      transports: [
        { mode: 'headless-exec', mechanism: 'pi --mode json', available: true },
        {
          mode: 'duplex-protocol',
          mechanism: 'pi --mode rpc (JSONL commands on stdin, responses and events on stdout)',
          available: false,
        },
      ],
      environmentKeys: PI_RUN_ENVIRONMENT_KEYS,
      sessionRoot: layout.sessionDirOverride ?? layout.defaultSessionsRoot,
      credentialPath: layout.credentialPath,
    }
    this.described = descriptor
    return descriptor
  }

  /**
   * Enumerate pi's sessions from its own store. Read-only.
   *
   * @param options - Cwd filter, limit and cancellation.
   * @returns Session summaries, newest first.
   */
  async listSessions(options: ListSessionsOptions): Promise<readonly AgentSession[]> {
    return listPiSessions(this.ctx, this.agent, options, this.storeEnv())
  }

  /**
   * Read a bounded transcript window along a session's live branch. Read-only.
   *
   * @param nativeId - Pi session id, or a session file path.
   * @param options - Message and byte caps.
   * @returns The window and its declared gaps.
   */
  async readTranscript(nativeId: NativeSessionId, options: ReadTranscriptOptions): Promise<PiTranscript> {
    return readPiTranscript(this.ctx, nativeId, options, this.storeEnv())
  }

  /**
   * Pi has no native todo list and no plan mode, so there is nothing to read.
   *
   * @returns Always `undefined`; the README records why.
   */
  async readNativeTasks(): Promise<NativeTaskState | undefined> {
    return readPiNativeTasks()
  }

  /**
   * Inspect pi's credential store and the host environment. Never returns secret material.
   *
   * @returns The observed auth state.
   */
  async authStatus(): Promise<AgentAuthState> {
    return readPiAuthStatus(this.ctx, this.agent, { env: this.storeEnv() })
  }

  /**
   * Report that pi has no non-interactive login. The `interactive` flow is declared and
   * surfaced as guidance rather than driving a TUI (ADR-0003, ADR-0010).
   *
   * @param params - Requested flow; the secret is never used or logged.
   * @returns An unsuccessful result carrying the guidance and the observed state.
   */
  async login(params: LoginParams): Promise<AuthOperationResult> {
    return loginPi(this.ctx, this.agent, params, this.storeEnv())
  }

  /**
   * Report that pi has no non-interactive logout.
   *
   * @returns An unsuccessful result carrying the guidance and the observed state.
   */
  async logout(): Promise<AuthOperationResult> {
    return logoutPi(this.ctx, this.agent, this.storeEnv())
  }

  /**
   * Read the model and provider catalog from pi's own configuration files. Read-only.
   *
   * This is the SPI's catalog: `models.json` providers and their models, the
   * `modelOverrides` a provider declares, and the default model and enabled scope from
   * `settings.json`. Pi's built-in catalog is deliberately not read, so the result is the
   * configured subset; every read says so in `notes`.
   *
   * @returns The catalog, with every declared gap.
   */
  async listModels(): Promise<AgentModelCatalog> {
    return readPiModelCatalog(this.ctx, this.agent, { env: this.storeEnv() })
  }

  /**
   * Ask pi itself for the models it can currently reach.
   *
   * This is an extra beyond the SPI: it runs `pi --offline --list-models`, so it neither
   * refreshes catalogs nor blocks on the network, and it covers models pi ships that no
   * configuration file declares. The file-based {@link listModels} needs no process.
   *
   * @param search - Optional fuzzy search pattern, passed to pi verbatim.
   * @returns Parsed rows plus declared gaps.
   */
  async listNativeModels(search?: string): Promise<PiModelListing> {
    const layout = await this.layout()
    const outcome = await this.ctx.process.run({
      command: this.binaryPath(),
      args: ['--offline', '--list-models', ...(search === undefined || search.trim() === '' ? [] : [search])],
      cwd: layout.agentDir,
      envMode: 'minimal',
      env: { ...this.derivedEnv(layout), ...this.ctx.config.env },
      timeoutMs: LIST_MODELS_TIMEOUT_MS,
      captureBytes: 256 * 1024,
    })
    const notes: ProjectionNote[] = []
    if (outcome.code !== 0) {
      notes.push({
        field: '*',
        reason: `\`pi --list-models\` exited with ${
          outcome.code === undefined ? `signal ${String(outcome.signal)}` : `code ${String(outcome.code)}`
        }`,
      })
    }
    const listing = parseModelTable(`${outcome.stdout.head}${outcome.stdout.tail}`)
    if (!listing.sawHeader) {
      notes.push({
        field: 'models',
        reason: `pi printed no model table${listing.firstLine === undefined ? '' : `: ${listing.firstLine}`}`,
      })
    } else if (listing.models.length === 0) {
      notes.push({ field: 'models', reason: 'pi listed no models' })
    } else if (listing.skipped > 0) {
      notes.push({ field: 'models', reason: `${listing.skipped} output lines did not parse as model rows` })
    }
    return { models: listing.models, notes }
  }

  /**
   * Argv that opens pi's own TUI, optionally resuming a session.
   *
   * `--session-dir` is included whenever the adapter resolved a session directory itself,
   * because the TUI would otherwise resolve its own. The agent directory cannot travel in
   * argv: a launcher must export `PI_CODING_AGENT_DIR` when a `homeDir` override is set.
   *
   * @param nativeId - Session to resume; omitted opens pi's default new session.
   * @returns The argv to launch.
   */
  nativeLaunchCommand(nativeId?: NativeSessionId): readonly string[] {
    const argv = [this.binaryPath()]
    const settings = parsePiSettings(this.ctx.config.settings)
    const envDir = this.env.PI_CODING_AGENT_SESSION_DIR
    const resolvedDir =
      settings.sessionDir ??
      (envDir === undefined || envDir.trim() === '' ? undefined : envDir.trim()) ??
      (this.ctx.config.homeDir === undefined
        ? undefined
        : `${this.ctx.files.resolvePath(this.ctx.config.homeDir)}/sessions`)
    if (resolvedDir !== undefined) argv.push('--session-dir', this.ctx.files.resolvePath(resolvedDir))
    if (nativeId === undefined) return argv
    // `--resume` is deliberately unused: it opens an interactive picker.
    argv.push('--session', String(nativeId))
    return argv
  }

  /**
   * Dispatch a run through `pi --mode json`, ending with exactly one `run.finished`.
   *
   * @param request - Run parameters; `prompt` travels on stdin, and `cwd` must be the
   *   directory the session belongs to when resuming.
   * @returns The run handle, its event stream and its terminal result.
   */
  async run(request: AdapterRunRequest): Promise<AdapterRun> {
    const layout = await this.layout()
    const runIdValue = brandRunId(request.runId)
    const projection = new PiRunProjection(runIdValue)
    const queue = new EventQueue()
    const finished = deferred<RunResult>()
    const startedAtMs = Date.now()

    const resumeId = request.resumeNativeId === undefined ? undefined : nativeSessionId(request.resumeNativeId)
    const resume = await this.resolveResume(resumeId, request.cwd)
    if (resume.blocked !== undefined) {
      // A resume pi cannot perform non-interactively must not become a silent no-op or a
      // run in the wrong directory, so it is reported as a classified, spawnless failure.
      const handle = this.handleFor(request, [], [], startedAtMs)
      queue.push({
        kind: 'run.started',
        runId: runIdValue,
        agentId: this.agent,
        at: new Date().toISOString(),
        ...(resumeId === undefined ? {} : { nativeSessionId: resumeId }),
      })
      queue.push(projection.warn(resume.blocked.message, new Date().toISOString()))
      projection.addNote(resume.blocked.note)
      const result = this.terminal(handle, 'failed', projection, startedAtMs, {
        code: resume.blocked.code,
        message: resume.blocked.message,
        remediation: resume.blocked.remediation,
      })
      queue.push({ kind: 'run.finished', runId: runIdValue, at: result.finishedAt, result })
      queue.close()
      finished.resolve(result)
      return { argv: [], environmentKeys: [], events: queue, result: finished.promise, cancel: () => {} }
    }

    const newSessionId = resumeId !== undefined ? undefined : generatePiSessionId()
    const args = this.buildRunArgs(request, resume.path, resumeId, newSessionId)
    const timeoutMs = request.timeoutMs ?? this.ctx.config.timeoutMs
    const spec: ProcessSpec = {
      command: this.binaryPath(),
      args,
      cwd: request.cwd,
      envMode: this.ctx.config.envMode,
      env: this.buildRunEnv(request, layout),
      stdin: request.prompt,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      captureBytes: 512 * 1024,
    }
    // The names are computed from the same spec the runner derives the child environment
    // from; in production `this.env` is the host environment the runner was built with.
    const environmentKeys = buildEnvironment(spec, this.env).names
    const managed = this.ctx.process.start(spec)
    const handle = this.handleFor(request, args, environmentKeys, startedAtMs)
    const plannedSessionId = newSessionId === undefined ? resumeId : nativeSessionId(newSessionId)
    queue.push({
      kind: 'run.started',
      runId: runIdValue,
      agentId: this.agent,
      at: new Date().toISOString(),
      ...(plannedSessionId === undefined ? {} : { nativeSessionId: plannedSessionId }),
    })
    if (request.prompt.trim() === '') {
      // Pi's print mode sends nothing and exits 0 when it receives neither argv nor stdin
      // content, so an empty prompt would look like a successful no-op turn.
      projection.addNote('the prompt was empty, so pi was started with nothing to send')
      queue.push(projection.warn('the prompt is empty: pi will exit without doing work', new Date().toISOString()))
    }
    if (request.sandbox !== undefined && request.sandbox !== '') {
      // Declaration over detection: capabilities().sandboxProfiles is empty, so a profile
      // can only arrive from a caller that ignored the declaration.
      projection.addNote('pi has no sandbox, so the requested sandbox profile was ignored')
      queue.push(
        projection.warn(
          `pi has no sandbox; the requested profile "${request.sandbox}" was ignored`,
          new Date().toISOString(),
        ),
      )
    }

    void this.drive({ managed, queue, projection, handle, finished, startedAtMs, timeoutMs, runIdValue })

    return {
      // Nothing secret is an argv element: the prompt is on stdin and credentials reach pi
      // through its own store or the derived environment.
      argv: args,
      environmentKeys,
      events: queue,
      result: finished.promise,
      cancel: () => {
        managed.kill('cancel')
      },
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The environment the store is resolved from: the host's plus per-adapter extras. */
  private storeEnv(): NodeJS.ProcessEnv {
    return { ...this.env, ...this.ctx.config.env }
  }

  /** The resolved binary: the configured override, else the bare name for `PATH`. */
  private binaryPath(): string {
    return this.ctx.config.binaryPath === undefined || this.ctx.config.binaryPath === ''
      ? PI_BINARY
      : this.ctx.config.binaryPath
  }

  /** Resolve the store layout from the same environment a run will see. */
  private layout(): Promise<PiStoreLayout> {
    return resolvePiStore(this.ctx, this.storeEnv())
  }

  /** The variables this adapter always resolves for pi, before caller overrides. */
  private derivedEnv(layout: PiStoreLayout): Record<string, string> {
    return {
      PI_CODING_AGENT_DIR: layout.agentDir,
      ...(layout.sessionDirOverride === undefined
        ? {}
        : { PI_CODING_AGENT_SESSION_DIR: layout.sessionDirOverride }),
    }
  }

  /** Build the orchestrator-facing part of a run handle. */
  private handleFor(
    request: AdapterRunRequest,
    argv: readonly string[],
    environmentKeys: readonly string[],
    startedAtMs: number,
  ): RunHandle {
    return {
      id: brandRunId(request.runId),
      agentId: this.agent,
      status: 'running',
      startedAt: new Date(startedAtMs).toISOString(),
      cwd: request.cwd,
      isolation: request.isolation,
      argv,
      environmentKeys,
    }
  }

  /**
   * The argv for a run. `--mode json` is the headless transport; a resume passes the
   * session file path when one was resolved, else the id for pi's own lookup, and never
   * silently starts a fresh session instead.
   */
  private buildRunArgs(
    request: AdapterRunRequest,
    resumePath: string | undefined,
    resumeId: NativeSessionId | undefined,
    newSessionId: string | undefined,
  ): string[] {
    const args = ['--mode', 'json']
    if (resumePath !== undefined) args.push('--session', resumePath)
    else if (resumeId !== undefined) args.push('--session', String(resumeId))
    else if (newSessionId !== undefined) args.push('--session-id', newSessionId)

    const model = request.model ?? this.ctx.config.model
    if (model !== undefined && model.trim() !== '') {
      // Pi accepts `provider/id` directly, but `--provider` is the explicit form for the
      // run record, and it keeps a provider whose model ids contain a slash unambiguous.
      const split = splitPiModel(model)
      if (split.provider !== undefined) args.push('--provider', split.provider)
      args.push('--model', split.model)
    }
    // `default` means "obey pi's own trust store", which is exactly pi's no-flag behavior.
    if (request.approval === 'approve') args.push('--approve')
    return args
  }

  /** The environment for a run: derived variables, then the adapter's, then the caller's. */
  private buildRunEnv(request: AdapterRunRequest, layout: PiStoreLayout): Record<string, string> {
    return {
      ...this.derivedEnv(layout),
      ...this.ctx.config.env,
      ...request.env,
    }
  }

  /** Resolve a resume id to a session file, or to a classified refusal. */
  private async resolveResume(resumeId: NativeSessionId | undefined, cwd: string): Promise<{
    path?: string
    blocked?: { code: string; message: string; remediation: string; note: string }
  }> {
    if (resumeId === undefined) return {}
    const path = await findPiSessionFile(this.ctx, resumeId, this.storeEnv())
    if (path === undefined) {
      // Pi's own lookup may still succeed (its scan is unbounded), and the terminal
      // classification catches the silent no-op when it does not.
      return {}
    }
    const header = await readPiSessionHeaderAt(this.ctx, path)
    const sessionCwd = header === undefined || header.cwd === '' ? undefined : header.cwd
    if (sessionCwd === undefined || resolvePath(sessionCwd) === resolvePath(cwd)) return { path }
    return {
      blocked: {
        code: ErrorCodes.runContextUnavailable,
        message:
          `pi session ${String(resumeId)} belongs to ${sessionCwd} ` +
          `and cannot be continued in ${cwd}`,
        remediation:
          `Dispatch this resume with cwd set to ${sessionCwd}, or start a new session there ` +
          '(omit resumeNativeId): pi requires an interactive confirmation to fork a session ' +
          'into another project, and this adapter never drives a TUI.',
        note: 'the run was not spawned: pi cannot continue a session in another directory non-interactively',
      },
    }
  }

  /** Read the stream, then classify the exit into exactly one terminal result. */
  private async drive(options: {
    managed: ManagedProcess
    queue: EventQueue
    projection: PiRunProjection
    handle: RunHandle
    finished: { promise: Promise<RunResult>; resolve: (value: RunResult) => void }
    startedAtMs: number
    timeoutMs: number
    runIdValue: RunId
  }): Promise<void> {
    const { managed, queue, projection, handle, finished, startedAtMs, runIdValue } = options
    const stream = managed.stdout
    if (stream === null) {
      projection.addNote('the run produced no stdout stream, so no events could be recorded')
    } else {
      try {
        for await (const record of jsonLines(stream, {
          onError: (error, lineNumber) => {
            // `jsonLines` flushes a synthetic trailing newline, so its own parser reports
            // one empty line for a stream that simply ended; that is not a defect.
            if (error === 'empty line') return
            projection.addNote(`stdout line ${lineNumber} was not valid JSON (${error})`)
          },
          onOverflow: dropped => {
            projection.addNote(`an over-long stdout line dropped ${dropped} bytes`)
          },
        })) {
          const at = new Date().toISOString()
          for (const event of projection.observe(record.value, record.raw, at)) queue.push(event)
        }
      } catch (cause) {
        queue.push(
          projection.warn(
            `reading pi's event stream failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            new Date().toISOString(),
          ),
        )
      }
    }

    const outcome = await managed.outcome
    const state = projection.state()
    const stderrTail = bounded(`${outcome.stderr.tail}${outcome.stderr.head}`.trim())

    let status: RunStatus = 'succeeded'
    let error: RunResult['error']
    if (outcome.cancelled) {
      status = 'cancelled'
      error = { code: ErrorCodes.runCancelled, message: 'the run was cancelled' }
    } else if (outcome.timedOut) {
      status = 'timeout'
      error = {
        code: ErrorCodes.runTimeout,
        message: `the run exceeded its ${options.timeoutMs} ms budget`,
      }
    } else if (outcome.code === undefined && outcome.signal === undefined) {
      // The process never reported an exit status, which is how the runner reports a
      // spawn failure (a missing binary or a working directory that does not exist).
      status = 'failed'
      error = {
        code: ErrorCodes.runStartFailed,
        message: `pi could not be started in ${handle.cwd}`,
        remediation: 'Check that the pi binary exists and is executable, and that the working directory exists.',
      }
    } else if (outcome.code !== undefined && outcome.code !== 0) {
      status = 'failed'
      error = classifyPiExit(outcome.code, stderrTail)
    } else if (state.lastStopReason === 'error') {
      // Pi's JSON mode exits 0 even when the last assistant response failed.
      status = 'failed'
      error = {
        code: ErrorCodes.runAgentCrashed,
        message: state.lastErrorMessage ?? 'the assistant response failed',
        remediation: 'Check the model and provider credentials configured for this agent; the run itself started cleanly.',
      }
    } else if (state.sessionId === undefined) {
      // No session header means pi never established a session at all: the signature of an
      // unanswerable interactive question, which exits 0 with no output.
      status = 'failed'
      error = {
        code: ErrorCodes.runContextUnavailable,
        message: 'pi exited without starting a session and produced no events',
        remediation:
          'Check the session id and the working directory: pi asks on stdin, which a managed ' +
          'run cannot answer, when it cannot find the requested session or would have to fork ' +
          'one from another project.',
      }
    } else if (state.aborted) {
      status = 'cancelled'
      error = { code: ErrorCodes.runCancelled, message: 'pi aborted the turn' }
    }
    if (state.sessionId !== undefined && !state.settled && status === 'succeeded') {
      projection.addNote('the stream ended before pi reported agent_settled, so the turn may not have finished')
    }

    const result = this.terminal(handle, status, projection, startedAtMs, {
      ...(error?.code === undefined ? {} : { code: error.code }),
      ...(error?.message === undefined ? {} : { message: error.message }),
      ...(error?.remediation === undefined ? {} : { remediation: error.remediation }),
      ...(error === undefined || stderrTail === '' ? {} : { output: stderrTail }),
      ...(outcome.code === undefined ? {} : { exitCode: outcome.code }),
      ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
      ...(state.finalText === undefined ? {} : { finalText: state.finalText }),
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    })
    queue.push({ kind: 'run.finished', runId: runIdValue, at: result.finishedAt, result })
    queue.close()
    finished.resolve(result)
  }

  /** Assemble the terminal result, with `exactOptionalPropertyTypes`-safe optionals. */
  private terminal(
    handle: RunHandle,
    status: RunStatus,
    projection: PiRunProjection,
    startedAtMs: number,
    details: {
      code?: string
      message?: string
      remediation?: string
      output?: string
      exitCode?: number
      signal?: string
      finalText?: string
      usage?: SessionUsage
      sessionId?: string
    },
  ): RunResult {
    const result: RunResult = {
      handle: {
        ...handle,
        status,
        ...(details.sessionId === undefined
          ? {}
          : { sessionKey: sessionKey(this.agent, nativeSessionId(details.sessionId)) }),
      },
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
      ...(details.signal === undefined ? {} : { signal: details.signal }),
      ...(details.finalText === undefined ? {} : { finalText: details.finalText }),
      ...(details.usage === undefined ? {} : { usage: details.usage }),
      notes: [...projection.state().notes],
    }
    if (details.code !== undefined && details.message !== undefined) {
      result.error = {
        code: details.code,
        message: details.message,
        ...(details.remediation === undefined ? {} : { remediation: details.remediation }),
        ...(details.output === undefined ? {} : { output: details.output }),
      }
    }
    return result
  }
}

/**
 * Create the Pi adapter.
 *
 * @param ctx - Ambient core services for this adapter.
 * @returns A ready adapter.
 */
export function createPiAdapter(ctx: AdapterContext): PiAdapter {
  return new PiAdapter(ctx)
}

/**
 * Split a configured model string into pi's `--provider` and `--model` values.
 *
 * `provider/id` is split at the first slash; anything else is passed verbatim, because a
 * bare pattern is legal (pi also accepts fuzzy patterns and a `:<thinking>` suffix), and
 * guessing would silently select a different model.
 *
 * @param model - Model string from the run request or the adapter config.
 * @returns The provider, when the string has the `provider/id` shape, and the model value.
 */
export function splitPiModel(model: string): { provider?: string; model: string } {
  const trimmed = model.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return { model: trimmed }
  const provider = trimmed.slice(0, slash)
  const id = trimmed.slice(slash + 1)
  if (id === '' || !/^[A-Za-z0-9._-]+$/.test(provider)) return { model: trimmed }
  return { provider, model: id }
}

/**
 * Generate a session id pi accepts: uuid-v7-shaped, so ids sort by creation time and match
 * pi's `[A-Za-z0-9][A-Za-z0-9._-]*` pattern.
 *
 * @param now - Creation time in milliseconds; injected for testability.
 * @returns The session id.
 */
export function generatePiSessionId(now: number = Date.now()): string {
  const time = Math.trunc(now).toString(16).padStart(12, '0').slice(-12)
  const random = randomBytes(15).toString('hex')
  const versionGroup = `7${random.slice(0, 3)}`
  const variantNibble = ((Number.parseInt(random.slice(3, 4), 16) & 0x3) | 0x8).toString(16)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-${versionGroup}-${variantNibble}${random.slice(4, 7)}-${random.slice(7, 19)}`
}

/** A single-consumer async queue: the pump pushes, the run's consumer pulls. */
class EventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly buffered: AgentRunEvent[] = []
  private waiter: ((result: IteratorResult<AgentRunEvent>) => void) | undefined
  private closed = false

  /**
   * Enqueue one event.
   *
   * @param event - Event to emit, in order.
   */
  push(event: AgentRunEvent): void {
    const waiter = this.waiter
    if (waiter !== undefined) {
      this.waiter = undefined
      waiter({ value: event, done: false })
      return
    }
    this.buffered.push(event)
  }

  /** Signal completion, after the terminal event has been pushed. */
  close(): void {
    this.closed = true
    const waiter = this.waiter
    if (waiter !== undefined) {
      this.waiter = undefined
      waiter({ value: undefined, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentRunEvent> {
    while (true) {
      const buffered = this.buffered.shift()
      if (buffered !== undefined) {
        yield buffered
        continue
      }
      if (this.closed) return
      const result = await new Promise<IteratorResult<AgentRunEvent>>(resolve => {
        this.waiter = resolve
      })
      if (result.done === true) return
      yield result.value
    }
  }
}

/** A promise with an exposed resolver, so a background pump can settle it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value)
    },
  }
}

/** Classify a non-zero pi exit, or a process that never ran, into a canonical code. */
function classifyPiExit(code: number, stderr: string): NonNullable<RunResult['error']> {
  if (/no session found matching/i.test(stderr)) {
    return {
      code: ErrorCodes.sessionNotFound,
      message: 'pi could not find the requested session',
      remediation:
        'Check the session id, or resume within the session\'s own project directory; MutiAgent reads the same store pi does.',
    }
  }
  if (
    /no api key|invalid api key|not (logged in|authenticated)|unauthorized|\b401\b|no models available|use \/login/i.test(
      stderr,
    )
  ) {
    return {
      code: ErrorCodes.authNotConfigured,
      message: `pi exited with code ${String(code)} without a usable credential`,
      remediation: 'Authenticate pi (run `pi` and use /login) or set the provider API key for this agent.',
    }
  }
  if (/rate.?limit|\b429\b|quota/i.test(stderr)) {
    return {
      code: ErrorCodes.runRateLimited,
      message: `pi exited with code ${String(code)} after a provider rate limit`,
      remediation: 'Retry after the quota resets, or configure a different model for this agent.',
    }
  }
  return {
    code: ErrorCodes.runAgentCrashed,
    message: `pi exited with code ${String(code)}`,
    remediation: 'Inspect the attached stderr tail; a missing model or an unreadable extension are the usual causes.',
  }
}

/** Bound a diagnostic string for a run record, keeping its tail. */
function bounded(text: string): string {
  return text.length > MAX_STDERR_CHARS ? text.slice(text.length - MAX_STDERR_CHARS) : text
}

/**
 * Parse the table `pi --list-models` prints.
 *
 * Rows are only accepted after the `provider  model  …` header, so explanatory output —
 * pi prints credential guidance when it has no usable provider — is never mistaken for a
 * model row.
 *
 * @param text - Captured stdout.
 * @returns Parsed rows, the count of lines that were not rows, and the first line.
 */
function parseModelTable(text: string): {
  models: PiModelEntry[]
  skipped: number
  firstLine: string | undefined
  sawHeader: boolean
} {
  const models: PiModelEntry[] = []
  let skipped = 0
  let firstLine: string | undefined
  let sawHeader = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue
    if (firstLine === undefined) firstLine = line.trim()
    if (!sawHeader) {
      if (line.trim().toLowerCase().startsWith('provider')) sawHeader = true
      else skipped += 1
      continue
    }
    const columns = line.split(/\s{2,}/).map(column => column.trim())
    const provider = columns[0]
    const id = columns[1]
    if (provider === undefined || provider === '' || id === undefined || id === '') {
      skipped += 1
      continue
    }
    const contextWindow = columns[2]
    const maxOutput = columns[3]
    models.push({
      provider,
      id,
      ...(contextWindow === undefined || contextWindow === '' ? {} : { contextWindow }),
      ...(maxOutput === undefined || maxOutput === '' ? {} : { maxOutput }),
      thinking: columns[4] === 'yes',
      images: columns[5] === 'yes',
    })
  }
  return { models, skipped, firstLine, sawHeader }
}
