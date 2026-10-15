/**
 * Run request/lifecycle types and the single normalized run-event union every
 * adapter emits (ADR-0003).
 *
 * @module @zorker/muti-agent-contracts/run
 */

import type { AgentId, NativeSessionId, RunId, SessionKey } from './ids.ts'
import type { SessionUsage } from './session.ts'

/** Terminal and non-terminal states of a delegated run. */
export type RunStatus =
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'

/** How much isolation a run gets (ADR-0008). */
export type IsolationMode = 'worktree' | 'shared-cwd'

/** One context block injected into a delegated run's prompt (ADR-0009). */
export interface InjectedContext {
  /** What produced the block. */
  kind: 'shared-todos' | 'shared-plan' | 'collaboration-brief' | 'user'
  /** Rendered text, verbatim, so the run is reproducible from its record. */
  text: string
  /** Content hash of {@link text}, for idempotent re-injection. */
  hash: string
}

/** Everything needed to dispatch one run. */
export interface RunRequest {
  /** Target agent. */
  agentId: AgentId
  /** The task text handed to the agent. */
  prompt: string
  /** Absolute directory to run in; already resolved to a worktree when isolated. */
  cwd: string
  /** Isolation actually applied. */
  isolation: IsolationMode
  /** Continue this native session instead of starting a new one. */
  resumeNativeId?: NativeSessionId
  /** Model override, verbatim; ignored when the agent has no model selection. */
  model?: string
  /** Sandbox profile name from the adapter's declared set. */
  sandbox?: string
  /** Approval mode from the adapter's declared set. */
  approval?: string
  /** Wall-clock budget in milliseconds; absent means bounded only by cancellation. */
  timeoutMs?: number
  /** Extra environment entries layered over the adapter's resolved set. */
  env?: Readonly<Record<string, string>>
  /** Context blocks to inject ahead of the prompt. */
  context: readonly InjectedContext[]
  /** Collaboration this run belongs to, when any. */
  collaborationId?: string
  /** Worktree allocated for this run, when isolated. */
  worktreeId?: string
  /** Who asked for the run: the harness agent, the GUI, an MCP client, or a user. */
  requestedBy: string
}

/** A live run handle as returned to a dispatcher. */
export interface RunHandle {
  /** Run identifier. */
  id: RunId
  /** Target agent. */
  agentId: AgentId
  /** Session the run writes into, once known (may arrive after the first event). */
  sessionKey?: SessionKey
  /** Current status. */
  status: RunStatus
  /** Wall-clock start, ISO 8601. */
  startedAt: string
  /** Directory the run executes in. */
  cwd: string
  /** Isolation applied. */
  isolation: IsolationMode
  /** Worktree allocated, when isolated. */
  worktreeId?: string
  /** Collaboration the run belongs to, when any. */
  collaborationId?: string
  /** Redacted argv of the spawned process, for the run record. */
  argv: readonly string[]
  /** Environment variable names passed (never values). */
  environmentKeys: readonly string[]
}

/** Final outcome of a run. */
export interface RunResult {
  /** The handle the run was started with, with `status` and `sessionKey` finalized. */
  handle: RunHandle
  /** ISO 8601 completion time. */
  finishedAt: string
  /** Duration in milliseconds. */
  durationMs: number
  /** Process exit code, when the run reached a process exit. */
  exitCode?: number
  /** Signal that terminated the process, when it was signalled. */
  signal?: string
  /** Final assistant text, when the agent produced one. */
  finalText?: string
  /** Token usage, when the agent reported it. */
  usage?: SessionUsage
  /** Classified failure, when the run did not succeed. */
  error?: {
    code: string
    message: string
    remediation?: string
    /** Redacted tail of native stderr, bounded. */
    output?: string
  }
  /** Declared projection gaps for this run's events. */
  notes: readonly string[]
}

/** Every event an adapter can emit for a run. `kind` is the discriminant. */
export type AgentRunEvent =
  /** The process started; the adapter resolved its native session id if it had one early. */
  | {
      kind: 'run.started'
      runId: RunId
      agentId: AgentId
      at: string
      nativeSessionId?: NativeSessionId
    }
  /** The agent told us which native session it is using. */
  | { kind: 'session.bound'; runId: RunId; at: string; nativeSessionId: NativeSessionId; title?: string }
  /** Incremental assistant text. */
  | { kind: 'message.delta'; runId: RunId; at: string; text: string }
  /** Incremental reasoning/thinking text, where the agent exposes it. */
  | { kind: 'reasoning.delta'; runId: RunId; at: string; text: string }
  /** A complete assistant message. */
  | { kind: 'message.completed'; runId: RunId; at: string; text: string }
  /** A tool call began. */
  | {
      kind: 'tool.started'
      runId: RunId
      at: string
      callId?: string
      toolName: string
      input?: string
    }
  /** A tool call ended. */
  | {
      kind: 'tool.completed'
      runId: RunId
      at: string
      callId?: string
      toolName: string
      output?: string
      failed?: boolean
    }
  /** Files the agent changed, as reported by the agent. */
  | { kind: 'files.changed'; runId: RunId; at: string; paths: readonly string[] }
  /** The agent's todo list changed. */
  | { kind: 'todos.updated'; runId: RunId; at: string; todos: readonly { content: string; status: string }[] }
  /** The agent's plan-mode state changed. */
  | { kind: 'plan.updated'; runId: RunId; at: string; active: boolean; phases?: readonly string[] }
  /** Token/usage accounting. */
  | { kind: 'usage.updated'; runId: RunId; at: string; usage: SessionUsage }
  /** An approval or permission request the host must answer. */
  | {
      kind: 'approval.requested'
      runId: RunId
      at: string
      requestId: string
      summary: string
      /** How the host is expected to answer, when the transport allows an answer. */
      answerable: boolean
    }
  /** A non-fatal diagnostic worth surfacing. */
  | { kind: 'warning'; runId: RunId; at: string; message: string }
  /** A native event the adapter does not model; preserved rather than dropped. */
  | { kind: 'unknown'; runId: RunId; at: string; nativeType?: string; native: string }
  /** The agent produced output MutiAgent could not attribute to a known kind. */
  | { kind: 'output'; runId: RunId; at: string; stream: 'stdout' | 'stderr'; text: string }
  /** The run reached a terminal state. Always the last event. */
  | { kind: 'run.finished'; runId: RunId; at: string; result: RunResult }

/** Narrowing helper: whether an event terminates its run. */
export function isTerminalEvent(event: AgentRunEvent): boolean {
  return event.kind === 'run.finished'
}
