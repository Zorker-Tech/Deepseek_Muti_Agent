/**
 * The OpenAI Codex adapter.
 *
 * One implementation of the {@link AgentAdapter} SPI for Codex: `describe()` detects
 * the binary and `$CODEX_HOME` once and caches the descriptor; `listSessions`,
 * `readTranscript` and `readNativeTasks` read Codex's own rollout store in place
 * (ADR-0012); `authStatus`/`login`/`logout` inspect `auth.json` read-only and delegate
 * every mutation to the CLI (ADR-0010); and `run` drives `codex exec --json` as a
 * managed process whose events are projected onto the canonical run union (ADR-0003,
 * ADR-0014). No consumer needs to know Codex's native shapes (ADR-0002).
 *
 * @module @zorker/muti-agent-adapter-codex
 */

import { homedir } from 'node:os'

import {
  ErrorCodes,
  MutiAgentError,
  agentId as toAgentId,
  nativeSessionId as toNativeSessionId,
  runId as toRunId,
  sessionKey as toSessionKey,
  type AgentAuthState,
  type AgentCapabilities,
  type AgentDescriptor,
  type AgentSession,
  type AuthOperationResult,
  type NativeSessionId,
  type RunHandle,
  type RunResult,
  type RunStatus,
} from '@zorker/muti-agent-contracts'
import {
  Git,
  Redactor,
  buildEnvironment,
  detectionFrom,
  jsonLines,
  probeVersion,
  resolveBinary,
  type AdapterContext,
  type AdapterRun,
  type AdapterRunRequest,
  type AdapterRuntimeConfig,
  type AgentAdapter,
  type FileProbe,
  type ListSessionsOptions,
  type Logger,
  type LoginParams,
  type NativeTaskState,
  type ProcessRunner,
  type ProcessSpec,
  type ReadTranscriptOptions,
} from '@zorker/muti-agent-core'

import {
  CODEX_CREDENTIAL_ENV_KEYS,
  CODEX_LOGIN_FLOWS,
  codexLogin,
  codexLogout,
  readCodexAuthState,
} from './auth.ts'
import { CodexExecEventMapper, RunEventQueue, classifyExecOutcome } from './events.ts'
import {
  DEFAULT_TASK_TAIL_BYTES,
  DEFAULT_TRANSCRIPT_TAIL_BYTES,
  listCodexSessions,
  readCodexNativeTasks,
  readCodexTranscript,
  resolveCodexHome,
  type CodexHome,
  type CodexTranscript,
} from './sessions.ts'

/** Canonical agent id. */
export const CODEX_ID = 'codex'

/** Sandbox profiles Codex accepts, in escalating isolation order. */
export const CODEX_SANDBOX_PROFILES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Approval modes this adapter passes through. */
export const CODEX_APPROVAL_MODES: readonly string[] = ['on-request', 'never']

/**
 * Environment variable names a run may receive from the host, sorted (ADR-0014).
 *
 * `CODEX_HOME` and `CODEX_SQLITE_HOME` keep the child on the home this adapter detected;
 * the credential variables are Codex's own, declared by name so an environment-provided
 * credential reaches the agent exactly as ADR-0010 reports it — MutiAgent never copies a
 * secret out of `auth.json` into the child environment.
 */
export const RUN_INHERIT_ENV_KEYS: readonly string[] = [
  ...CODEX_CREDENTIAL_ENV_KEYS,
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
].sort()

/** Per-stream capture cap for a run, which streams incrementally and keeps only a tail. */
const RUN_CAPTURE_BYTES = 512 * 1024

/** Cap on the stderr tail carried in a run's error record. */
const ERROR_OUTPUT_CHARS = 2_000

/** Applied to the prompt before it is recorded in a run's argv. */
const promptRedactor = new Redactor()

/** Settings this adapter reads out of `AdapterRuntimeConfig.settings`. */
export interface CodexAdapterSettings {
  /** Bytes read from the tail of a rollout when projecting a transcript. */
  readonly transcriptTailBytes?: number
  /** Wall-clock budget for a delegated login, which waits for a human. */
  readonly loginTimeoutMs?: number
}

/**
 * Validate this adapter's settings.
 *
 * An unset entry is omitted; a present but unusable one is reported and then omitted,
 * so a typo in the settings file degrades one tunable instead of failing the adapter.
 *
 * @param raw - `AdapterRuntimeConfig.settings`, unvalidated by construction.
 * @param log - Logger for a rejected value.
 * @returns The usable settings.
 */
export function parseCodexSettings(raw: Readonly<Record<string, unknown>>, log: Logger): CodexAdapterSettings {
  const transcriptTailBytes = positiveInt(raw.transcriptTailBytes)
  const loginTimeoutMs = positiveInt(raw.loginTimeoutMs)
  if (transcriptTailBytes === undefined && raw.transcriptTailBytes !== undefined) {
    log.warn('ignoring codex setting transcriptTailBytes', { value: String(raw.transcriptTailBytes) })
  }
  if (loginTimeoutMs === undefined && raw.loginTimeoutMs !== undefined) {
    log.warn('ignoring codex setting loginTimeoutMs', { value: String(raw.loginTimeoutMs) })
  }
  return {
    ...(transcriptTailBytes === undefined ? {} : { transcriptTailBytes }),
    ...(loginTimeoutMs === undefined ? {} : { loginTimeoutMs }),
  }
}

/** A positive integer setting value, or `undefined`. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * The Codex adapter.
 *
 * Instances are stateless between operations apart from two caches: the resolved
 * descriptor (detection touches the filesystem and spawns `codex --version`, and the
 * catalog is queried on every GUI load) and the resolved home layout.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id: string = CODEX_ID

  readonly displayName = 'Codex'

  private readonly agent = toAgentId(CODEX_ID)

  private readonly log: Logger

  private readonly config: AdapterRuntimeConfig

  private readonly process: ProcessRunner

  private readonly files: FileProbe

  private readonly settings: CodexAdapterSettings

  private descriptor: Promise<AgentDescriptor> | undefined

  private homeLayout: Promise<CodexHome> | undefined

  private binary: string | undefined

  /**
   * @param ctx - Ambient services the core exposes: logger, config, process runner and
   *   read-only filesystem helpers.
   */
  constructor(ctx: AdapterContext) {
    this.log = ctx.log
    this.config = ctx.config
    this.process = ctx.process
    this.files = ctx.files
    this.settings = parseCodexSettings(ctx.config.settings, ctx.log)
  }

  /** Declared capabilities; never depends on detection. */
  capabilities(): AgentCapabilities {
    return {
      runModes: ['headless-exec'],
      streaming: true,
      resume: true,
      // `codex app-server` can interrupt a turn, but this adapter speaks only
      // `codex exec`; killing the process group is cancellation, not interruption.
      interrupt: false,
      listSessions: true,
      readTranscript: true,
      nativeTodos: true,
      nativePlan: true,
      // Codex can run in a worktree it created (`--worktree`), not one MutiAgent made.
      externalWorktree: false,
      // Codex is an MCP client through `mcp_servers` in its own config.
      mcpClient: true,
      listModels: false,
      sandboxProfiles: CODEX_SANDBOX_PROFILES,
      approvalModes: CODEX_APPROVAL_MODES,
      credentials: { status: true, login: CODEX_LOGIN_FLOWS, logout: true },
    }
  }

  /** Describe this agent on this machine, with detection resolved once and cached. */
  async describe(): Promise<AgentDescriptor> {
    const pending = this.descriptor ?? this.buildDescriptor()
    this.descriptor = pending
    try {
      return await pending
    } catch (cause) {
      // A detection failure must not be cached as a permanent verdict: the user may
      // install the binary and ask again without restarting.
      this.descriptor = undefined
      throw cause
    }
  }

  /** Enumerate Codex sessions, active first and archived as well. */
  async listSessions(options: ListSessionsOptions): Promise<readonly AgentSession[]> {
    const home = await this.resolveHome()
    return listCodexSessions({ files: this.files, log: this.log, agentId: this.agent, home, options })
  }

  /**
   * Read a bounded window from the tail of a session's rollout.
   *
   * `totalMessages` is deliberately never reported: Codex records no message count,
   * so claiming one would mean a full read on every call.
   */
  async readTranscript(nativeId: NativeSessionId, options: ReadTranscriptOptions): Promise<CodexTranscript> {
    const home = await this.resolveHome()
    return readCodexTranscript({
      files: this.files,
      home,
      nativeId,
      options,
      defaultTailBytes: this.settings.transcriptTailBytes ?? DEFAULT_TRANSCRIPT_TAIL_BYTES,
    })
  }

  /** Read Codex's own checklist and plan state, when the session recorded either. */
  async readNativeTasks(nativeId: NativeSessionId): Promise<NativeTaskState | undefined> {
    const home = await this.resolveHome()
    return readCodexNativeTasks({
      files: this.files,
      home,
      agentId: this.agent,
      nativeId,
      tailBytes: DEFAULT_TASK_TAIL_BYTES,
    })
  }

  /** Observe authentication state without writing anything (ADR-0010). */
  async authStatus(): Promise<AgentAuthState> {
    const home = await this.resolveHome()
    const state = await readCodexAuthState({ files: this.files, home, agentId: this.agent })
    this.log.debug('codex auth status observed', { status: state.status, source: state.source })
    return state
  }

  /** Start a credential flow through `codex login`. */
  async login(params: LoginParams): Promise<AuthOperationResult> {
    const binary = await this.requireBinary()
    const home = await this.resolveHome()
    return codexLogin({
      process: this.process,
      log: this.log,
      binary,
      home,
      agentId: this.agent,
      params: { flow: params.flow, ...(params.secret === undefined ? {} : { secret: params.secret }) },
      status: () => this.authStatus(),
      cwd: await this.cliCwd(home),
      env: this.runEnvironment(home, undefined),
      envMode: this.config.envMode,
      ...(this.settings.loginTimeoutMs === undefined ? {} : { timeoutMs: this.settings.loginTimeoutMs }),
    })
  }

  /** Revoke credentials through `codex logout`. */
  async logout(): Promise<AuthOperationResult> {
    const binary = await this.requireBinary()
    const home = await this.resolveHome()
    return codexLogout({
      process: this.process,
      log: this.log,
      binary,
      home,
      agentId: this.agent,
      status: () => this.authStatus(),
      cwd: await this.cliCwd(home),
      env: this.runEnvironment(home, undefined),
      envMode: this.config.envMode,
    })
  }

  /**
   * Dispatch `codex exec --json` for one run.
   *
   * The prompt is the final positional argument, after `--` when it begins with `-`;
   * the child's working directory is set *and* `-C` is passed with the same value, so
   * the session Codex records cannot drift from the directory the orchestrator chose.
   *
   * @param request - Run assignment.
   * @returns The run handle, whose events end with exactly one `run.finished` carrying
   *   the same {@link RunResult} its `result` promise resolves with.
   * @throws {MutiAgentError} `detection/not-found` when the binary is missing, and
   *   `schema/invalid` when a sandbox or approval value is outside the declared set.
   */
  async run(request: AdapterRunRequest): Promise<AdapterRun> {
    const binary = await this.requireBinary()
    const home = await this.resolveHome()
    const sandbox = this.validateSandbox(request.sandbox)
    const approval = this.validateApproval(request.approval)
    const model = request.model ?? this.config.model
    const runId = toRunId(request.runId)
    // A `--skip-git-repo-check` that is not needed is harmless; one that is missing makes
    // Codex refuse to start, so a false negative from a missing git is the safe side.
    const inRepository = await new Git(this.process).isRepository(request.cwd)
    const args = buildExecArgs({
      cwd: request.cwd,
      model,
      sandbox,
      approval,
      resumeNativeId: request.resumeNativeId,
      prompt: request.prompt,
      skipGitRepoCheck: !inRepository,
    })
    const env = this.runEnvironment(home, request.env)
    const timeoutMs = request.timeoutMs ?? (this.config.timeoutMs > 0 ? this.config.timeoutMs : undefined)
    const controller = new AbortController()
    const spec: ProcessSpec = {
      command: binary,
      args,
      cwd: request.cwd,
      envMode: this.config.envMode,
      env,
      inheritKeys: RUN_INHERIT_ENV_KEYS,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      signal: controller.signal,
      captureBytes: RUN_CAPTURE_BYTES,
    }
    const environmentKeys = buildEnvironment(spec, process.env).names
    // The prompt is the one argv element that can carry something the user pasted; the
    // run record keeps its shape but not a credential-shaped substring.
    const recordedArgv = [binary, ...args.map(part => (part === request.prompt ? promptRedactor.apply(part) : part))]
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    const handle = this.process.start(spec)
    const mapper = new CodexExecEventMapper({ runId })
    let dropped = 0
    const queue = new RunEventQueue({ onDrop: total => { dropped = total } })
    let cancelReason: string | undefined

    const settle = async (streamError: string | undefined, malformed: number): Promise<RunResult> => {
      const outcome = await handle.outcome
      const stderrText = `${outcome.stderr.head}${outcome.stderr.tail}`
      const classification = classifyExecOutcome(outcome, stderrText)
      const finishedAt = new Date().toISOString()
      const status: RunStatus = classification.ok
        ? 'succeeded'
        : classification.failure === 'cancelled'
          ? 'cancelled'
          : classification.failure === 'timeout'
            ? 'timeout'
            : 'failed'
      const thread = mapper.nativeSessionId
      const runHandle: RunHandle = {
        id: runId,
        agentId: this.agent,
        status,
        startedAt,
        cwd: request.cwd,
        isolation: request.isolation,
        argv: recordedArgv,
        environmentKeys,
        ...(thread === undefined ? {} : { sessionKey: toSessionKey(this.agent, toNativeSessionId(thread)) }),
      }
      const notes: string[] = [
        'assistant text arrives as item-level deltas plus one completed message; a consumer must apply them, not concatenate both',
        'interrupt is not available in this transport: cancellation kills the process group (ADR-0003)',
      ]
      if (cancelReason !== undefined) notes.push(`cancelled by the caller: ${cancelReason}`)
      if (timeoutMs !== undefined && outcome.timedOut) notes.push(`the run was killed after ${String(timeoutMs)} ms`)
      if (dropped > 0) notes.push(`${String(dropped)} event(s) were dropped because nothing was reading the stream`)
      if (malformed > 0) notes.push(`${String(malformed)} stdout line(s) were not valid JSON and are reported as output events`)
      if (streamError !== undefined) notes.push(`the stdout stream ended abnormally: ${streamError}`)
      if (classification.ok && mapper.errorEvidence.length > 0) {
        notes.push(`the stream reported: ${truncate(mapper.errorEvidence.join('; '), ERROR_OUTPUT_CHARS)}`)
      }
      if (mapper.unmodelledItemTypes.length > 0) {
        notes.push(`native types emitted as \`unknown\` events: ${mapper.unmodelledItemTypes.join(', ')}`)
      }
      return {
        handle: runHandle,
        finishedAt,
        durationMs: Date.now() - startedMs,
        notes,
        ...(outcome.code === undefined ? {} : { exitCode: outcome.code }),
        ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
        ...(mapper.finalText === undefined ? {} : { finalText: mapper.finalText }),
        ...(mapper.reportedUsage === undefined ? {} : { usage: mapper.reportedUsage }),
        ...(classification.ok
          ? {}
          : {
              error: {
                code: classification.code,
                message: classification.message,
                remediation: classification.remediation,
                ...(stderrText.trim() === '' ? {} : { output: truncate(stderrText.trim(), ERROR_OUTPUT_CHARS) }),
              },
            }),
      }
    }

    // The producer never blocks on the consumer: `result` must settle for a caller that
    // only awaits it, and the queue bounds what an unread stream can accumulate.
    const pump = async (): Promise<void> => {
      queue.push({ kind: 'run.started', runId, agentId: this.agent, at: startedAt })
      let streamError: string | undefined
      let malformed = 0
      const stdout = handle.stdout
      if (stdout === null) {
        streamError = 'the managed process exposed no stdout stream'
      } else {
        try {
          const lines = jsonLines(stdout, {
            onError: (error: string, lineNumber: number) => {
              // The line splitter reports its own end-of-stream artifact as an empty
              // line; that is not agent output and must not be surfaced as one.
              if (error.includes('empty line')) return
              malformed += 1
              queue.push({
                kind: 'output',
                runId,
                at: new Date().toISOString(),
                stream: 'stdout',
                text: `unparsable json on stdout line ${String(lineNumber)}: ${error}`,
              })
            },
            onOverflow: (droppedBytes: number) => {
              queue.push({
                kind: 'warning',
                runId,
                at: new Date().toISOString(),
                message: `codex wrote an over-long stdout line; ${String(droppedBytes)} byte(s) were dropped`,
              })
            },
          })
          for await (const line of lines) {
            for (const event of mapper.mapLine(line.value, line.raw)) queue.push(event)
          }
        } catch (cause) {
          streamError = cause instanceof Error ? cause.message : String(cause)
        }
      }
      const result = await settle(streamError, malformed)
      queue.push({ kind: 'run.finished', runId, at: result.finishedAt, result })
      this.log.debug('codex run finished', {
        runId: request.runId,
        status: result.handle.status,
        exitCode: result.exitCode ?? -1,
      })
    }
    pump().catch((cause: unknown) => {
      // The producer must never leave `result` pending: closing with a cause rejects it
      // with a classified `run/protocol-error`.
      this.log.warn('codex run producer failed', {
        runId: request.runId,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      queue.close(cause)
    })

    return {
      argv: recordedArgv,
      environmentKeys,
      events: queue,
      result: queue.result,
      cancel: (reason?: string): void => {
        // Idempotent: the first caller's reason is the one the run record keeps.
        if (reason !== undefined && cancelReason === undefined) cancelReason = reason
        controller.abort()
      },
    }
  }

  /** Argv that opens Codex's own TUI, optionally resuming a session. */
  nativeLaunchCommand(nativeId?: NativeSessionId): readonly string[] {
    // Detection is asynchronous, so before the first `describe()` this is the bare name,
    // which resolves through PATH exactly as a user's shell would.
    const binary = this.binary ?? 'codex'
    return nativeId === undefined ? [binary] : [binary, 'resume', nativeId]
  }

  /** Resolve the descriptor, and therefore detection, once. */
  private async buildDescriptor(): Promise<AgentDescriptor> {
    const resolution = await resolveBinary('codex', {
      ...(this.config.binaryPath === undefined || this.config.binaryPath === ''
        ? {}
        : { candidates: [this.files.resolvePath(this.config.binaryPath)] }),
    })
    if (resolution.path !== undefined) this.binary = resolution.path
    const home = await this.resolveHome()
    const version = resolution.path === undefined ? undefined : await probeVersion(this.process, resolution.path)
    return {
      id: this.agent,
      displayName: this.displayName,
      summary:
        'OpenAI Codex CLI: append-only rollout sessions under $CODEX_HOME, a JSONL exec stream, sandboxed headless runs, and ChatGPT or API-key credentials.',
      capabilities: this.capabilities(),
      detection: detectionFrom(resolution, {
        ...(version === undefined ? {} : { version }),
        homeDir: home.path,
      }),
      transports: [
        { mode: 'headless-exec', mechanism: 'codex exec --json', available: true },
        { mode: 'duplex-protocol', mechanism: 'codex app-server --stdio (duplex transport planned)', available: false },
      ],
      environmentKeys: RUN_INHERIT_ENV_KEYS,
      sessionRoot: home.sessionsRoot,
      credentialPath: home.credentialFile,
    }
  }

  /** Resolve the home layout once. */
  private async resolveHome(): Promise<CodexHome> {
    this.homeLayout ??= this.buildHome()
    return this.homeLayout
  }

  /** Resolve the home layout, warning when a configured `CODEX_HOME` was unusable. */
  private async buildHome(): Promise<CodexHome> {
    const home = await resolveCodexHome(this.files, this.config.homeDir)
    if (home.fallbackReason !== undefined) this.log.warn(home.fallbackReason, { agent: CODEX_ID })
    return home
  }

  /**
   * The environment a run receives.
   *
   * Caller entries layer over the adapter's configured set, and `CODEX_HOME` always
   * concludes the chain so a run cannot resolve a different home than the one this
   * adapter inspected.
   *
   * @param home - Resolved home layout.
   * @param overrides - Per-request entries from the orchestrator.
   * @returns The explicit environment entries.
   */
  private runEnvironment(
    home: CodexHome,
    overrides: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> {
    return { ...this.config.env, ...(overrides ?? {}), CODEX_HOME: home.path }
  }

  /** A working directory that exists, for spawning the CLI. */
  private async cliCwd(home: CodexHome): Promise<string> {
    return (await this.files.isDirectory(home.path)) ? home.path : homedir()
  }

  /** The resolved binary, or a classified error naming what to fix. */
  private async requireBinary(): Promise<string> {
    const descriptor = await this.describe()
    const binary = descriptor.detection.binaryPath
    if (binary === undefined) {
      throw new MutiAgentError(ErrorCodes.detectionNotFound, 'the codex binary is not available', {
        details: { agent: CODEX_ID },
        remediation: 'Install Codex, or set the codex binary path in this adapter\'s settings.',
      })
    }
    return binary
  }

  /** Validate a requested sandbox profile against the declared set. */
  private validateSandbox(value: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined
    if (CODEX_SANDBOX_PROFILES.includes(value)) return value
    throw new MutiAgentError(ErrorCodes.schemaInvalid, `"${value}" is not a Codex sandbox profile`, {
      details: { agent: CODEX_ID, sandbox: value },
      remediation: `Declared profiles: ${CODEX_SANDBOX_PROFILES.join(', ')}.`,
    })
  }

  /** Validate a requested approval mode against the declared set. */
  private validateApproval(value: string | undefined): string | undefined {
    if (value === undefined || value === '') return undefined
    if (CODEX_APPROVAL_MODES.includes(value)) return value
    throw new MutiAgentError(ErrorCodes.schemaInvalid, `"${value}" is not a Codex approval mode`, {
      details: { agent: CODEX_ID, approval: value },
      remediation: `Declared modes: ${CODEX_APPROVAL_MODES.join(', ')}.`,
    })
  }
}

/** Arguments for one `codex exec` invocation. */
interface ExecArgsOptions {
  /** Directory the session runs in; also passed as `-C`. */
  readonly cwd: string
  /** Model override, when one is configured. */
  readonly model: string | undefined
  /** Sandbox profile, already validated. */
  readonly sandbox: string | undefined
  /** Approval mode, already validated. */
  readonly approval: string | undefined
  /** Native session to continue, when resuming; the SPI passes it as a plain string. */
  readonly resumeNativeId: string | undefined
  /** The task text. */
  readonly prompt: string
  /** Whether `--skip-git-repo-check` is required because the cwd is not a repository. */
  readonly skipGitRepoCheck: boolean
}

/**
 * Build `codex exec` arguments.
 *
 * Every option is placed before the `resume` subcommand and before the prompt, which is
 * the only position the CLI's own parser accepts for all of them; the prompt is passed
 * after `--` when it starts with `-` so it cannot be read as a flag.
 *
 * @param options - The run's resolved inputs.
 * @returns The argument vector, without the binary.
 */
function buildExecArgs(options: ExecArgsOptions): string[] {
  const args = ['exec', '--json', '-C', options.cwd]
  if (options.model !== undefined && options.model !== '') args.push('-m', options.model)
  if (options.sandbox !== undefined) args.push('-s', options.sandbox)
  if (options.approval !== undefined) args.push('-c', `approval_policy="${options.approval}"`)
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check')
  if (options.resumeNativeId !== undefined) args.push('resume', String(options.resumeNativeId))
  if (options.prompt.startsWith('-')) args.push('--')
  args.push(options.prompt)
  return args
}

/** The first `count` characters of a string, marked when it was cut. */
function truncate(text: string, count: number): string {
  return text.length <= count ? text : `${text.slice(0, count)}…`
}

/**
 * Create the Codex adapter.
 *
 * @param ctx - Ambient services provided by the core.
 * @returns A new adapter; the registry, not the caller, owns its lifetime.
 */
export function createCodexAdapter(ctx: AdapterContext): CodexAdapter {
  return new CodexAdapter(ctx)
}
