/**
 * MutiAgent error taxonomy and the codes each layer may raise. Codes are stable
 * contract: the GUI, tools and diagnostics localize against the namespace, so a
 * code must never be renamed without treating it as a breaking change.
 *
 * @module @zorker/muti-agent-contracts/errors
 */

/** Namespaces of MutiAgent error codes. */
export type ErrorNamespace =
  /** Finding an agent binary or its home directory. */
  | 'detection'
  /** Reading credential state, and delegating login/logout. */
  | 'auth'
  /** Enumerating and reading another agent's session store. */
  | 'session'
  /** Dispatching, streaming and cancelling a delegated run. */
  | 'run'
  /** Creating, sampling and integrating git worktrees. */
  | 'worktree'
  /** Validating canonical input at a boundary. */
  | 'schema'
  /** Interacting with the hosting harness's services and seams. */
  | 'harness'
  /** Collaboration, tasks and shared documents. */
  | 'mesh'
  /** The HTTP/MCP envelope itself. */
  | 'wire'

/** A structured, user-presentable failure. */
export interface MutiAgentErrorShape {
  /** `<namespace>/<slug>`. */
  code: string
  /** What went wrong, naming the agent and operation. */
  message: string
  /** What the human should do next, when there is an action. */
  remediation?: string
  /** Extra context: agent id, path, exit code. Never a credential. */
  details?: Readonly<Record<string, string | number | boolean>>
  /** Whether a retry could succeed without changing inputs. */
  retryable: boolean
  /** Preserved lower-level cause message, redacted. */
  cause?: string
}

/** The error class MutiAgent throws across its own boundaries. */
export class MutiAgentError extends Error {
  /** Stable code, `<namespace>/<slug>`. */
  readonly code: string
  /** Actionable next step for the human, when one exists. */
  readonly remediation: string | undefined
  /** Structured context, safe to transmit. */
  readonly details: Readonly<Record<string, string | number | boolean>> | undefined
  /** Whether a plain retry may succeed. */
  readonly retryable: boolean

  /**
   * @param code - `<namespace>/<slug>` code from this module's catalog.
   * @param message - What went wrong, in the terms of the failing operation.
   * @param options - Remediation, structured details, retryability, and a cause.
   */
  constructor(
    code: string,
    message: string,
    options: {
      remediation?: string
      details?: Readonly<Record<string, string | number | boolean>>
      retryable?: boolean
      cause?: unknown
    } = {},
  ) {
    super(message)
    this.name = 'MutiAgentError'
    this.code = code
    this.remediation = options.remediation
    this.details = options.details
    this.retryable = options.retryable ?? false
    if (options.cause !== undefined) {
      this.cause = options.cause instanceof Error ? options.cause.message : String(options.cause)
    }
  }

  /** The serialized form sent over the wire and returned from tools. */
  toShape(): MutiAgentErrorShape {
    const shape: MutiAgentErrorShape = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    }
    if (this.remediation !== undefined) shape.remediation = this.remediation
    if (this.details !== undefined) shape.details = this.details
    if (typeof this.cause === 'string') shape.cause = this.cause
    return shape
  }
}

/** True when a thrown value is a MutiAgentError. */
export function isMutiAgentError(value: unknown): value is MutiAgentError {
  return value instanceof MutiAgentError
}

/** Convert any thrown value into a shape safe to transmit. */
export function toErrorShape(value: unknown): MutiAgentErrorShape {
  if (isMutiAgentError(value)) return value.toShape()
  if (value instanceof Error) {
    return { code: 'harness/unclassified', message: value.message, retryable: false }
  }
  return { code: 'harness/unclassified', message: String(value), retryable: false }
}

/** Selectors for the codes this project raises. Kept in one table so the set is auditable. */
export const ErrorCodes = {
  detectionNotFound: 'detection/not-found',
  detectionProbeFailed: 'detection/probe-failed',
  detectionHomeUnresolved: 'detection/home-unresolved',

  authNotConfigured: 'auth/not-configured',
  authExpired: 'auth/expired',
  authStoreUnreadable: 'auth/store-unreadable',
  authLoginUnsupported: 'auth/login-unsupported',
  authLoginFailed: 'auth/login-failed',
  authLogoutFailed: 'auth/logout-failed',
  authHumanStepRequired: 'auth/human-step-required',

  sessionNotFound: 'session/not-found',
  sessionUnreadable: 'session/unreadable',
  sessionRootMissing: 'session/root-missing',
  sessionReadCapExceeded: 'session/read-cap-exceeded',
  /**
   * A session's agent is chosen once and then fixed: the transcript, the worktree and the
   * shared todos accumulate around one agent, so changing it mid-conversation would mix two
   * contexts and put two agents in one working tree.
   */
  sessionAgentLocked: 'session/agent-locked',

  runStartFailed: 'run/start-failed',
  runAgentCrashed: 'run/agent-crashed',
  runCancelled: 'run/cancelled',
  runTimeout: 'run/timeout',
  runRateLimited: 'run/rate-limited',
  runPolicyBlocked: 'run/policy-blocked',
  runProtocolError: 'run/protocol-error',
  runNotRunning: 'run/not-running',
  runContextUnavailable: 'run/context-unavailable',

  worktreeNotARepository: 'worktree/not-a-repository',
  worktreeCreateFailed: 'worktree/create-failed',
  worktreeNotFound: 'worktree/not-found',
  worktreeDirty: 'worktree/dirty',
  worktreeUnmerged: 'worktree/unmerged',
  worktreeOrphan: 'worktree/orphan',
  worktreeGitUnavailable: 'worktree/git-unavailable',

  schemaInvalid: 'schema/invalid',
  schemaVersionUnsupported: 'schema/version-unsupported',
  schemaTodoConflict: 'schema/todo-conflict',

  harnessToolsUnavailable: 'harness/tools-unavailable',
  harnessRouteUnavailable: 'harness/route-unavailable',
  harnessServiceMissing: 'harness/service-missing',
  harnessUnclassified: 'harness/unclassified',

  meshCollaborationNotFound: 'mesh/collaboration-not-found',
  meshTaskNotFound: 'mesh/task-not-found',
  meshConfirmationRequired: 'mesh/confirmation-required',
  meshInvalidTransition: 'mesh/invalid-transition',

  wireBadEnvelope: 'wire/bad-envelope',
  wireUnknownMethod: 'wire/unknown-method',
  wireUnauthorized: 'wire/unauthorized',
  wireBadParams: 'wire/bad-params',
} as const

/** The union of catalog codes, for exhaustiveness where useful. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]
