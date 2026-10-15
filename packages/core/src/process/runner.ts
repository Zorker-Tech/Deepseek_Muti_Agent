/**
 * Managed process execution: explicit environment, own process group, bounded
 * capture, classified exits (ADR-0014).
 *
 * @module @zorker/muti-agent-core/process/runner
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { MutiAgentError, ErrorCodes } from '@zorker/muti-agent-contracts'

/** Environment variable name filter for variables never inherited by default. */
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i

/** Variables a child always receives when present in the parent, with no secret semantics. */
const BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TZ',
  'TERM',
  'TERM_PROGRAM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
] as const

/** How the child environment is derived from the host's. */
export type EnvMode = 'minimal' | 'inherit-agent' | 'inherit-all'

/** Everything needed to spawn one managed process. */
export interface ProcessSpec {
  /** Executable path or bare name resolved through the child's `PATH`. */
  command: string
  /** Arguments, passed verbatim; nothing is shell-interpreted. */
  args: readonly string[]
  /** Working directory. */
  cwd: string
  /** Environment derivation mode. */
  envMode?: EnvMode
  /**
   * Explicit environment entries layered over the derived base. For a
   * `api-key`-style credential flow, values here are visible in the process
   * table only if the caller put them in `args`; passing secrets here is the
   * supported channel.
   */
  env?: Readonly<Record<string, string>>
  /**
   * Variable **names** that may be inherited from the host even when they match
   * the secret filter. Required because an agent's own credential variable is
   * exactly what we want to pass through when `envMode` is not `minimal`.
   */
  inheritKeys?: readonly string[]
  /** Bytes to write to stdin before closing it. */
  stdin?: string
  /** Wall-clock budget; the whole process group is killed when exceeded. */
  timeoutMs?: number
  /** Grace period between SIGTERM and SIGKILL for the process group. */
  killGraceMs?: number
  /** Caller cancellation; killing follows the same path as a timeout. */
  signal?: AbortSignal
  /** Capture limits per stream. */
  captureBytes?: number
}

/** One captured stream: a bounded head and tail with a drop counter. */
export interface CapturedStream {
  /** First bytes seen, up to the head cap. */
  head: string
  /** Last bytes seen, up to the tail cap. */
  tail: string
  /** Bytes discarded between head and tail. */
  droppedBytes: number
  /** Total bytes seen. */
  totalBytes: number
}

/** Outcome of a completed process. */
export interface ProcessOutcome {
  /** Exit code, or `undefined` when the process was signalled. */
  code: number | undefined
  /** Terminating signal, when one was reported. */
  signal: string | undefined
  /** Captured stdout. */
  stdout: CapturedStream
  /** Captured stderr. */
  stderr: CapturedStream
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Whether the run was killed by its own timeout. */
  timedOut: boolean
  /** Whether the run was killed by caller cancellation. */
  cancelled: boolean
  /** Environment variable **names** the child received, sorted, for the run record. */
  environmentKeys: readonly string[]
}

/** A live managed process. */
export interface ManagedProcess {
  /** OS process id, when the spawn succeeded. */
  readonly pid: number | undefined
  /** Outcome; resolves once the process and its pipes have settled. */
  readonly outcome: Promise<ProcessOutcome>
  /** Raw stdout stream, for incremental consumers. */
  readonly stdout: NodeJS.ReadableStream | null
  /** Raw stderr stream, for incremental consumers. */
  readonly stderr: NodeJS.ReadableStream | null
  /**
   * Terminate the process group.
   *
   * @param reason - Recorded so the caller can classify the outcome.
   */
  kill(reason?: 'cancel' | 'timeout'): void
}

const HEAD_BYTES = 8 * 1024

/** Accumulates a stream into a bounded head/tail pair. */
class StreamCapture {
  private headParts: Buffer[] = []
  private headBytes = 0
  private tail = Buffer.alloc(0)
  private dropped = 0
  private total = 0

  /**
   * @param cap - Maximum bytes retained across head and tail.
   */
  constructor(private readonly cap: number) {}

  /** Append a chunk. */
  push(chunk: Buffer): void {
    this.total += chunk.byteLength
    if (this.headBytes < HEAD_BYTES) {
      const room = HEAD_BYTES - this.headBytes
      const taken = chunk.byteLength <= room ? chunk : chunk.subarray(0, room)
      this.headParts.push(taken)
      this.headBytes += taken.byteLength
      chunk = chunk.byteLength <= room ? Buffer.alloc(0) : chunk.subarray(room)
      if (chunk.byteLength === 0) return
    }
    const tailCap = Math.max(0, this.cap - this.headBytes)
    const merged = Buffer.concat([this.tail, chunk])
    if (merged.byteLength > tailCap) {
      this.dropped += merged.byteLength - tailCap
      this.tail = tailCap === 0 ? Buffer.alloc(0) : Buffer.from(merged.subarray(merged.byteLength - tailCap))
    } else {
      this.tail = merged
    }
  }

  /** Snapshot the capture. */
  finish(): CapturedStream {
    return {
      head: Buffer.concat(this.headParts).toString('utf8'),
      tail: this.tail.toString('utf8'),
      droppedBytes: this.dropped,
      totalBytes: this.total,
    }
  }
}

/**
 * Build the child environment. Exported because the exact composition is part of
 * the run record and of ADR-0014's contract, and it is tested directly.
 *
 * @param spec - The spawn specification whose env fields drive composition.
 * @param hostEnv - The host process environment (injected for testability).
 * @returns The environment to hand to `spawn`, and the sorted names it contains.
 */
export function buildEnvironment(
  spec: Pick<ProcessSpec, 'env' | 'envMode' | 'inheritKeys'>,
  hostEnv: NodeJS.ProcessEnv,
): { env: Record<string, string>; names: readonly string[] } {
  const mode: EnvMode = spec.envMode ?? 'minimal'
  const explicit = spec.env ?? {}
  const allowed = new Set<string>(BASE_ENV_KEYS)
  for (const key of spec.inheritKeys ?? []) allowed.add(key)

  const env: Record<string, string> = {}
  if (mode === 'inherit-all') {
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value !== undefined) env[key] = value
    }
  } else {
    for (const key of allowed) {
      const value = hostEnv[key]
      if (value !== undefined) env[key] = value
    }
    if (mode === 'inherit-agent') {
      for (const [key, value] of Object.entries(hostEnv)) {
        if (value === undefined) continue
        if (key.startsWith('DSH_')) continue
        if (SECRETISH.test(key) && !allowed.has(key)) continue
        env[key] = value
      }
    }
  }
  for (const [key, value] of Object.entries(explicit)) env[key] = value
  // A child must never believe it is the harness itself.
  delete env.DSH_HOME
  delete env.DSH_PROFILE
  return { env, names: Object.keys(env).sort() }
}

/** Process execution with cancellation, timeout and classification guarantees. */
export class ProcessRunner {
  /**
   * @param hostEnv - Host environment to derive child environments from.
   * @param defaultGraceMs - SIGTERM→SIGKILL grace period for the process group.
   */
  constructor(
    private readonly hostEnv: NodeJS.ProcessEnv = process.env,
    private readonly defaultGraceMs = 5_000,
  ) {}

  /**
   * Spawn a managed process without waiting for it.
   *
   * @param spec - Command, cwd, environment and limits.
   * @returns A handle whose `outcome` settles when the process group is reaped.
   * @throws {MutiAgentError} `run/start-failed` when the executable cannot be spawned.
   */
  start(spec: ProcessSpec): ManagedProcess {
    const { env, names } = buildEnvironment(spec, this.hostEnv)
    const cap = spec.captureBytes ?? 512 * 1024
    const stdout = new StreamCapture(cap)
    const stderr = new StreamCapture(cap)
    const startedAt = Date.now()
    let timedOut = false
    let cancelled = false
    let child: ChildProcess

    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env,
        // A new process group so cancellation reaches the agent's own children.
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      throw new MutiAgentError(ErrorCodes.runStartFailed, `could not start ${spec.command}`, {
        details: { command: spec.command, cwd: spec.cwd },
        remediation: 'Check that the agent binary exists and is executable, or set its path in settings.',
        cause,
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })

    // stdin is never a TTY: either it carries an explicit payload, or it closes
    // immediately so an agent that expects input fails fast instead of hanging.
    if (child.stdin !== null && child.stdin !== undefined) {
      if (spec.stdin !== undefined) child.stdin.end(spec.stdin)
      else child.stdin.end()
    }

    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid
      if (pid === undefined) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-pid, signal)
      } catch {
        // The group is already gone; the outcome path already recorded why.
      }
    }

    let graceTimer: NodeJS.Timeout | undefined
    const terminate = (reason: 'cancel' | 'timeout'): void => {
      if (reason === 'timeout') timedOut = true
      if (reason === 'cancel') cancelled = true
      killGroup('SIGTERM')
      if (graceTimer !== undefined) return
      graceTimer = setTimeout(() => { killGroup('SIGKILL') }, spec.killGraceMs ?? this.defaultGraceMs)
      graceTimer.unref?.()
    }

    const timeoutMs = spec.timeoutMs
    const timeoutTimer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => { terminate('timeout') }, timeoutMs)
    timeoutTimer?.unref?.()

    const onAbort = (): void => { terminate('cancel') }
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) onAbort()
      else spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    const outcome = new Promise<ProcessOutcome>(resolve => {
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
        if (graceTimer !== undefined) clearTimeout(graceTimer)
        spec.signal?.removeEventListener('abort', onAbort)
        resolve({
          code: code ?? undefined,
          signal: signal ?? undefined,
          stdout: stdout.finish(),
          stderr: stderr.finish(),
          durationMs: Date.now() - startedAt,
          timedOut,
          cancelled,
          environmentKeys: names,
        })
      }
      child.once('error', (cause: Error) => {
        stderr.push(Buffer.from(`[muti-agent] spawn error: ${cause.message}\n`, 'utf8'))
        settle(null, null)
      })
      child.once('close', settle)
    })

    const handle: ManagedProcess = {
      pid: child.pid,
      outcome,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: (reason = 'cancel') => { terminate(reason) },
    }
    return handle
  }

  /**
   * Run a process to completion, capturing bounded output.
   *
   * @param spec - Command, cwd, environment and limits.
   * @returns The observed outcome; a non-zero exit is **not** thrown here, so a
   *   caller can classify it with the agent's own semantics.
   */
  async run(spec: ProcessSpec): Promise<ProcessOutcome> {
    return this.start(spec).outcome
  }

  /**
   * Run a process and require a successful exit.
   *
   * @param spec - Command, cwd, environment and limits.
   * @param onFailure - Maps a non-zero outcome to a classified error.
   * @returns The successful outcome.
   * @throws {MutiAgentError} The error produced by `onFailure`, or `run/agent-crashed`.
   */
  async runChecked(
    spec: ProcessSpec,
    onFailure?: (outcome: ProcessOutcome) => MutiAgentError,
  ): Promise<ProcessOutcome> {
    const outcome = await this.run(spec)
    if (outcome.code === 0) return outcome
    if (onFailure !== undefined) throw onFailure(outcome)
    throw new MutiAgentError(
      ErrorCodes.runAgentCrashed,
      `${spec.command} exited with ${outcome.code === undefined ? `signal ${String(outcome.signal)}` : `code ${String(outcome.code)}`}`,
      {
        details: { command: spec.command, code: outcome.code ?? -1 },
        cause: outcome.stderr.tail.trim(),
      },
    )
  }
}
