/**
 * Canonical session, transcript and task types. Every adapter projects its native
 * records onto these; loss is declared through {@link ProjectionNote} rather than
 * silently dropped (ADR-0002, ADR-0012).
 *
 * @module @zorker/muti-agent-contracts/session
 */

import type { AgentId, NativeSessionId, SessionKey, TodoId } from './ids.ts'

/** A declared gap between a native record and the canonical projection. */
export interface ProjectionNote {
  /** Canonical field the note is about, or `'*'` for the whole object. */
  field: string
  /** Why the value is absent, approximated or lossy. */
  reason: string
}

/** Lifecycle state of a session as far as MutiAgent can observe it. */
export type SessionStatus =
  /** Readable, no run in flight. */
  | 'idle'
  /** A MutiAgent-dispatched run is executing in this session. */
  | 'running'
  /** The native file or directory is gone. */
  | 'missing'
  /** The native store exists but could not be parsed. */
  | 'unreadable'

/** Which MutiAgent actor a session is bound to. */
export interface SessionBinding {
  /** Collaboration this session participates in, when any. */
  collaborationId?: string
  /** Worktree the session's runs execute in, when isolated. */
  worktreeId?: string
  /** Run ids dispatched into this session, oldest first. */
  runIds: readonly string[]
}

/**
 * Canonical session summary: enough to list, filter, sort and route a session
 * without reading its transcript.
 */
export interface AgentSession {
  /** `<agentId>:<nativeId>`. */
  key: SessionKey
  /** Owning agent. */
  agentId: AgentId
  /** The agent's own identifier, verbatim; the value to pass back on resume. */
  nativeId: NativeSessionId
  /** Absolute path of the native record on disk, when it has one. */
  nativePath?: string
  /** Title, from the agent's own naming, else derived from the first user message. */
  title?: string
  /** Whether {@link title} is the agent's own name rather than derived. */
  titleIsNative?: boolean
  /** Absolute working directory the session was created in. */
  cwd?: string
  /** Repository root inferred from {@link cwd}, when it is inside a git repository. */
  repoRoot?: string
  /** Git branch recorded by the agent, when it recorded one. */
  branch?: string
  /** Model id used by the session, verbatim. */
  model?: string
  /** ISO 8601 creation time. */
  createdAt?: string
  /** ISO 8601 last activity time. */
  updatedAt?: string
  /** Observed status. */
  status: SessionStatus
  /** Message count as the agent reports it, when it reports one. */
  messageCount?: number
  /** Parent session for a forked or subagent session. */
  parentNativeId?: NativeSessionId
  /** What created the session, in the agent's own vocabulary. */
  source?: string
  /** Token usage totals, when the agent records them. */
  usage?: SessionUsage
  /** MutiAgent-side binding state. */
  binding: SessionBinding
  /** Declared projection gaps. */
  notes: readonly ProjectionNote[]
}

/** Token accounting for one session or one run. */
export interface SessionUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  /** Reported cost in USD when the agent computes one. */
  costUsd?: number
}

/** Kind of one canonical transcript item. */
export type MessageKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'file-change'
  | 'plan'
  | 'error'
  | 'system'
  | 'unknown'

/** One normalized transcript item. */
export interface AgentMessage {
  /** Stable id within the session when the native store provides one. */
  id?: string
  /** Ordering index within the read window, ascending. */
  index: number
  /** Which side of the conversation produced it. */
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown'
  /** Normalized kind. */
  kind: MessageKind
  /** Plain text content, when the item has any. */
  text?: string
  /** ISO 8601 timestamp, when recorded. */
  timestamp?: string
  /** Tool details for `tool-call` / `tool-result`. */
  tool?: {
    name: string
    /** Serialized input, verbatim from the native record. */
    input?: string
    /** Serialized output, verbatim, possibly truncated. */
    output?: string
    /** Whether the native record marks the call as failed. */
    failed?: boolean
  }
  /** Paths touched, for `file-change`. */
  paths?: readonly string[]
  /** Usage attributed to this item, when the native store records per-item usage. */
  usage?: SessionUsage
  /** Native record type, for traceability. */
  nativeType?: string
  /** Whether {@link text} or {@link tool} was truncated by a read cap. */
  truncated?: boolean
}

/** A transcript read: a bounded window plus whether more exists. */
export interface AgentTranscript {
  /** Session this transcript belongs to. */
  key: SessionKey
  /** Messages in ascending order. */
  messages: readonly AgentMessage[]
  /** Total messages the native store holds, when knowable from metadata. */
  totalMessages?: number
  /** Whether older messages exist before {@link messages}[0]. */
  hasMore: boolean
  /** Declared projection gaps. */
  notes: readonly ProjectionNote[]
}

/** Canonical todo status, matching the harness's own vocabulary. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'

/** One task item, from any agent's todo model. */
export interface AgentTodo {
  /** Stable id. Foreign items get a deterministic id derived from their native key. */
  id: TodoId
  /** Short imperative line. */
  content: string
  /** Current status. */
  status: TodoStatus
  /** Agent that owns the item, or `'shared'` for a collaboration-level item. */
  owner: AgentId | 'shared'
  /** Ids that must complete first. */
  blockedBy: readonly TodoId[]
  /** ISO 8601 last change time. */
  updatedAt: string
  /** Session the item was observed in, when it came from a native store. */
  observedIn?: SessionKey
  /** Native key of the item, for traceability. */
  nativeKey?: string
}

/** One phase of a shared plan. */
export interface PlanPhase {
  /** Stable id within the plan. */
  id: string
  /** Phase title. */
  title: string
  /** State of the phase. */
  status: 'todo' | 'active' | 'done'
  /** Agent responsible for the phase, when assigned. */
  owner?: AgentId | 'shared'
  /** What must be true for the phase to be done. */
  exitCriteria?: string
}

/** The collaboration's authoritative plan document. */
export interface AgentPlan {
  /** Collaboration this plan belongs to. */
  collaborationId: string
  /** One-sentence objective. */
  objective: string
  /** Ordered phases. */
  phases: readonly PlanPhase[]
  /** Id of the phase currently being worked. */
  activePhaseId?: string
  /** Append-only decisions log; each entry is one line. */
  decisions: readonly string[]
  /** ISO 8601 last change time. */
  updatedAt: string
  /** How this plan document is treated for delegated agents (ADR-0009). */
  mode: 'inject' | 'observe'
}

/** A session-grouped view the UI renders directly: one partition per agent. */
export interface AgentSessionPartition {
  /** Agent this partition belongs to. */
  agentId: AgentId
  /** Display name, so the client needs no descriptor lookup to render a header. */
  displayName: string
  /** Whether the agent is installed and usable here. */
  installed: boolean
  /** Sessions in this partition, already sorted by the request's sort order. */
  sessions: readonly AgentSession[]
  /** Sessions this agent has that could be tracked but are not yet. */
  untrackedCount: number
  /** Why the partition is empty, when it is. */
  note?: string
}
