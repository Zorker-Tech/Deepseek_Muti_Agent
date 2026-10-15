/**
 * The AgentAdapter SPI. One implementation per integrated agent; the registry and
 * every consumer above it work exclusively through this interface, which is why a
 * new agent requires no consumer changes (ADR-0002).
 *
 * Contract rules for implementers:
 *
 * - `listSessions`, `readTranscript` and `readNativeTasks` are **read-only**. No
 *   adapter may write into another product's store (ADR-0012).
 * - `authStatus`, `login` and `logout` never persist a credential of their own;
 *   they inspect the native store and delegate mutation to the native CLI (ADR-0010).
 * - `run` emits the canonical event union and nothing native; a native event the
 *   adapter cannot model is emitted as `unknown` rather than dropped (ADR-0003).
 * - Declaration over detection: report what is supported in `capabilities()`, and
 *   let `describe().detection` carry what is present on this machine.
 *
 * @module @zorker/muti-agent-core/adapter/types
 */

import type {
  AgentAuthState,
  AgentCapabilities,
  AgentDescriptor,
  AgentMessage,
  AgentRunEvent,
  AgentSession,
  AgentTodo,
  AgentPlan,
  AuthOperationResult,
  CredentialFlow,
  IsolationMode,
  NativeSessionId,
  ProjectionNote,
  RunResult,
  SessionUsage,
} from '@zorker/muti-agent-contracts'

/** Minimal structured logger the core passes to adapters. */
export interface Logger {
  /**
   * Record a diagnostic.
   *
   * @param message - What happened, in the operation's own terms.
   * @param fields - Structured context; never a credential.
   */
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void
  /**
   * Record something the user may need to act on.
   *
   * @param message - The condition, phrased for a human.
   * @param fields - Structured context.
   */
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
}

/** Options for {@link AgentAdapter.listSessions}. */
export interface ListSessionsOptions {
  /** Only return sessions created in this working directory. */
  cwd?: string
  /** Stop after this many sessions, newest first. */
  limit?: number
  /** Abort a long scan. */
  signal?: AbortSignal
}

/** Options for {@link AgentAdapter.readTranscript}. */
export interface ReadTranscriptOptions {
  /** Maximum messages to return, counted from the end of the transcript. */
  maxMessages?: number
  /** Maximum bytes to read from the native store. */
  maxBytes?: number
}

/** Native task state as an adapter observed it. */
export interface NativeTaskState {
  /** Normalized todos. */
  todos: readonly AgentTodo[]
  /** Plan-mode state, when the agent has one. */
  plan?: {
    active: boolean
    /** Plan text or phase titles, verbatim from the native store. */
    items: readonly string[]
  }
  /** Declared projection gaps. */
  notes: readonly ProjectionNote[]
}

/** Parameters for {@link AgentAdapter.login}. */
export interface LoginParams {
  /** Credential flow to use; must be declared in `capabilities().credentials.login`. */
  flow: CredentialFlow
  /**
   * Secret to feed the flow on stdin for a `api-key` flow. Callers must never
   * place this value in argv, and adapters must never log or persist it.
   */
  secret?: string
}

/** Parameters for {@link AgentAdapter.run}. */
export interface AdapterRunRequest {
  /** Run id assigned by the orchestrator; adapters echo it on every event. */
  runId: string
  /** Absolute directory to execute in (already resolved to a worktree when isolated). */
  cwd: string
  /** The task text, including any injected context block the orchestrator composed. */
  prompt: string
  /** Continue this native session instead of starting a new one. */
  resumeNativeId?: string
  /** Model override, verbatim; adapters that cannot select a model ignore it and note it. */
  model?: string
  /** Sandbox profile from `capabilities().sandboxProfiles`. */
  sandbox?: string
  /** Approval mode from `capabilities().approvalModes`. */
  approval?: string
  /** Wall-clock budget; the runner kills the process group and reports `run/timeout`. */
  timeoutMs?: number
  /** Extra environment entries layered over the adapter's resolved set. */
  env?: Readonly<Record<string, string>>
  /** Whether the orchestrator isolated the code for this run. */
  isolation: IsolationMode
}

/**
 * A dispatched run. The event iterable is single-consumer and completes after the
 * terminal `run.finished` event; {@link AdapterRun.result} resolves with the same
 * terminal result for callers that only need the outcome.
 */
export interface AdapterRun {
  /** Redacted argv of the spawned process, for the run record. */
  readonly argv: readonly string[]
  /** Environment variable names passed to the process; never values. */
  readonly environmentKeys: readonly string[]
  /** Canonical run events, in order, ending with `run.finished`. */
  readonly events: AsyncIterable<AgentRunEvent>
  /** Terminal outcome. Resolves once, after the last event. */
  readonly result: Promise<RunResult>
  /**
   * Request cancellation. Idempotent; a run that already finished is unaffected.
   *
   * @param reason - Recorded on the terminal event, for the run record.
   */
  cancel(reason?: string): void
}

/**
 * Per-adapter deployment configuration. Concrete adapters narrow
 * {@link settings} with their own validated shape; the core only needs the shared
 * keys, so an adapter with extra settings does not change this interface.
 */
export interface AdapterRuntimeConfig {
  /** Whether this adapter participates at all. */
  enabled: boolean
  /** Override for the agent binary; absent means "resolve from PATH". */
  binaryPath?: string
  /** Override for the agent's home/config directory. */
  homeDir?: string
  /** Extra environment entries for every run of this agent. */
  env: Readonly<Record<string, string>>
  /** How the child environment is derived from the host environment (ADR-0014). */
  envMode: 'minimal' | 'inherit-agent' | 'inherit-all'
  /** Per-adapter wall-clock budget for a run, in milliseconds. */
  timeoutMs: number
  /** Default model for runs of this agent, when it accepts one. */
  model?: string
  /** Adapter-specific settings, validated by the adapter itself. */
  settings: Readonly<Record<string, unknown>>
}

/** Ambient services the core exposes to an adapter. */
export interface AdapterContext {
  /** Structured logger scoped to this adapter. */
  readonly log: Logger
  /** Resolved configuration for this adapter. */
  readonly config: AdapterRuntimeConfig
  /** Process execution with the environment, grouping and exit rules of ADR-0014. */
  readonly process: import('../process/runner.ts').ProcessRunner
  /**
   * Read-only filesystem helpers that tolerate a concurrently-written file:
   * bounded reads, tail reads, and fingerprinting.
   */
  readonly files: import('../process/files.ts').FileProbe
}

/**
 * One integrated agent.
 *
 * `describe()` is expected to be cheap after the first call: detection runs once
 * and is cached, because the catalog is queried on every GUI load.
 */
export interface AgentAdapter {
  /** Canonical agent id, e.g. `codex`. */
  readonly id: string
  /** Human name, e.g. `Codex`. */
  readonly displayName: string
  /** Synchronous capability declaration; must not depend on detection. */
  capabilities(): AgentCapabilities
  /** Full descriptor including detection on this machine. */
  describe(): Promise<AgentDescriptor>
  /** Enumerate this agent's sessions from its own store. Read-only. */
  listSessions(options: ListSessionsOptions): Promise<readonly AgentSession[]>
  /** Read a bounded transcript window. Read-only. */
  readTranscript(nativeId: NativeSessionId, options: ReadTranscriptOptions): Promise<{
    messages: readonly AgentMessage[]
    totalMessages?: number
    hasMore: boolean
    notes: readonly ProjectionNote[]
  }>
  /**
   * Read this agent's own todo/plan state for a session, when it has any.
   *
   * @returns The observed state, or `undefined` when the agent has no native
   *   task model or the session records none.
   */
  readNativeTasks(nativeId: NativeSessionId): Promise<NativeTaskState | undefined>
  /** Observed authentication state. Never returns secret material. */
  authStatus(): Promise<AgentAuthState>
  /** Start a credential flow through the native CLI. */
  login(params: LoginParams): Promise<AuthOperationResult>
  /** Revoke credentials through the native CLI. */
  logout(): Promise<AuthOperationResult>
  /** Dispatch a run. */
  run(request: AdapterRunRequest): Promise<AdapterRun>
  /**
   * Argv that opens this agent's own interactive UI, optionally resuming a
   * session. Used for the "open native session" action; MutiAgent launches it
   * rather than driving it (ADR-0003).
   */
  nativeLaunchCommand(nativeId?: NativeSessionId): readonly string[]
}

/** Convenience: a session's canonical key from an adapter id and native id. */
export function canonicalSessionKey(agentId: string, nativeId: string): string {
  return `${agentId}:${nativeId}`
}

/** Re-export so adapters need one import for the canonical vocabulary. */
export type {
  AgentAuthState,
  AgentCapabilities,
  AgentDescriptor,
  AgentMessage,
  AgentRunEvent,
  AgentPlan,
  AgentSession,
  AgentTodo,
  AuthOperationResult,
  IsolationMode,
  ProjectionNote,
  RunResult,
  SessionUsage,
}
