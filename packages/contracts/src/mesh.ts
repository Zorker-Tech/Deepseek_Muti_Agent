/**
 * Orchestration entities: tasks, worktrees with progress records, conflict
 * reports, and the shared collaboration documents (ADR-0008, ADR-0009).
 *
 * @module @zorker/muti-agent-contracts/mesh
 */

import type { AgentId, CollaborationId, RunId, WorktreeId } from './ids.ts'
import type { AgentPlan, AgentTodo } from './session.ts'

/** One delegated unit of work inside a collaboration. */
export interface MeshTask {
  /** Task id, stable for the life of the collaboration. */
  id: string
  /** Collaboration the task belongs to. */
  collaborationId: CollaborationId
  /** One-line description of the deliverable. */
  title: string
  /** Full instruction handed to the agent. */
  instruction: string
  /** Agent the task is assigned to. */
  assignee: AgentId
  /** Task state. */
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked'
  /** Tasks that must finish first. */
  dependsOn: readonly string[]
  /** Run dispatched for this task, once any. */
  runId?: RunId
  /** Worktree the task executes in, when isolated. */
  worktreeId?: WorktreeId
  /** ISO 8601 creation time. */
  createdAt: string
  /** ISO 8601 last state change. */
  updatedAt: string
  /** Why the task is blocked or failed. */
  note?: string
}

/** Per-file change counts between a worktree's base and its current state. */
export interface FileChangeStat {
  /** Repository-relative path. */
  path: string
  /** Lines added. */
  insertions: number
  /** Lines removed. */
  deletions: number
  /** Change kind as git reports it. */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
  /** Hunk ranges of the working-tree diff, in unified-diff order. */
  hunks?: readonly { start: number; lines: number }[]
}

/** One sampled progress record for a worktree. */
export interface WorktreeProgress {
  /** ISO 8601 time of the sample. */
  at: string
  /** HEAD commit at sample time. */
  head: string
  /** Branch name. */
  branch: string
  /** Commits ahead of the recorded base. */
  ahead: number
  /** Commits behind the base branch, when it can be computed. */
  behind?: number
  /** Changed files with counts. */
  files: readonly FileChangeStat[]
  /** Total insertions/deletions across {@link files}. */
  totals: { insertions: number; deletions: number; files: number }
  /** Whether the owning agent process was alive at sample time. */
  agentAlive: boolean
  /** Whether the worktree has uncommitted changes. */
  dirty: boolean
  /** Declared gaps, e.g. hunks unavailable. */
  notes: readonly string[]
}

/** A git worktree owned by MutiAgent. */
export interface MeshWorkspace {
  /** Worktree id. */
  id: WorktreeId
  /** Absolute path of the worktree. */
  path: string
  /** Absolute path of the repository the worktree belongs to. */
  repoRoot: string
  /** Branch checked out in the worktree. */
  branch: string
  /** Commit the worktree was created from. */
  baseCommit: string
  /** Ref the base commit belongs to, e.g. `main`. */
  baseRef: string
  /** Agent that owns this worktree. */
  agentId: AgentId
  /** Run currently executing here, when any. */
  runId?: RunId
  /** Collaboration the worktree serves, when any. */
  collaborationId?: CollaborationId
  /** Creation time. */
  createdAt: string
  /** Latest sample, when the watcher has taken one. */
  progress?: WorktreeProgress
  /** Lifecycle state. */
  state: 'active' | 'idle' | 'merged' | 'removed' | 'orphan'
  /** Whether a reserved worktree may be reused by a later run. */
  reusable: boolean
}

/** Severity of a detected conflict. */
export type ConflictSeverity = 'info' | 'warning' | 'blocking'

/** One detected conflict between two worktrees. */
export interface ConflictFinding {
  /** How the conflict was detected. */
  kind: 'same-file' | 'same-hunk' | 'feature-boundary' | 'base-drift'
  /** Severity, per the configured conflict policy. */
  severity: ConflictSeverity
  /** First worktree. */
  left: WorktreeId
  /** Second worktree. */
  right: WorktreeId
  /** Paths involved. */
  paths: readonly string[]
  /** Human explanation. */
  detail: string
}

/** A whole-repository conflict and integration report. */
export interface ConflictReport {
  /** Repository the report covers. */
  repoRoot: string
  /** ISO 8601 time of the report. */
  at: string
  /** Worktrees considered. */
  worktrees: readonly WorktreeId[]
  /** Findings, most severe first. */
  findings: readonly ConflictFinding[]
  /** Proposed integration order when findings exist. */
  suggestedOrder?: readonly WorktreeId[]
  /** Declared gaps, e.g. hunk-level detection unavailable without a diff. */
  notes: readonly string[]
}

/** The shared collaboration board. */
export interface SharedTodoDoc {
  /** Collaboration the board belongs to. */
  collaborationId: CollaborationId
  /** Every item, from agents and humans alike. */
  todos: readonly AgentTodo[]
  /** ISO 8601 last change. */
  updatedAt: string
  /** Monotonic revision, bumped on every accepted mutation. */
  revision: number
}

/** A run's redacted record, kept for the mesh panel and for reproducibility. */
export interface RunRecord {
  /** Run id. */
  id: RunId
  /** Collaboration, when any. */
  collaborationId?: CollaborationId
  /** Task, when any. */
  taskId?: string
  /** Target agent. */
  agentId: AgentId
  /** Native session the run wrote into, once the agent revealed it. */
  nativeSessionId?: string
  /** Isolation applied. */
  isolation: 'worktree' | 'shared-cwd'
  /** Worktree, when isolated. */
  worktreeId?: WorktreeId
  /** Working directory. */
  cwd: string
  /** Redacted argv. */
  argv: readonly string[]
  /** Environment variable names only. */
  environmentKeys: readonly string[]
  /** Context blocks injected, verbatim. */
  context: readonly { kind: string; hash: string; text: string }[]
  /** The prompt handed to the agent. */
  prompt: string
  /** Lifecycle state. */
  status: 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'
  /** ISO 8601 start. */
  startedAt: string
  /** ISO 8601 finish. */
  finishedAt?: string
  /** Exit code, when the run reached a process exit. */
  exitCode?: number
  /** Classified error code and message, when the run failed. */
  error?: { code: string; message: string }
  /** Counters useful for a list view without loading events. */
  counters: {
    events: number
    toolCalls: number
    filesChanged: number
  }
}

/** The collaboration aggregate returned to the UI. */
export interface Collaboration {
  /** Collaboration id. */
  id: CollaborationId
  /** Human title. */
  title: string
  /** Repository the collaboration works in. */
  repoRoot: string
  /** Plan document. */
  plan: AgentPlan
  /** Shared todo board. */
  todos: SharedTodoDoc
  /** Tasks. */
  tasks: readonly MeshTask[]
  /** Runs dispatched for this collaboration. */
  runs: readonly RunRecord[]
  /** Worktrees allocated. */
  worktrees: readonly MeshWorkspace[]
  /** Latest conflict report, when a scan has run. */
  conflicts?: ConflictReport
  /** ISO 8601 creation. */
  createdAt: string
  /** ISO 8601 last change. */
  updatedAt: string
}
