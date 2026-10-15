/**
 * Collaboration: the shared todo board and plan document, plus the deterministic
 * context block that carries them into a delegated run's prompt (ADR-0009).
 *
 * The sharing model is deliberately asymmetric and honest about it:
 *
 * - **Ingest** polls each agent's own store after a turn, so progress from an agent
 *   that knows nothing about MutiAgent is still captured as *observed* items.
 * - **Egress** renders the shared documents into text and injects them at dispatch
 *   time. A foreign agent cannot be pushed to mid-turn, so the effective latency is
 *   one turn — stated in the UI rather than hidden.
 *
 * @module @zorker/muti-agent-core/orchestration/collaboration
 */

import { createHash } from 'node:crypto'
import {
  ErrorCodes,
  MutiAgentError,
  collaborationId as brandCollaboration,
  todoId as brandTodo,
  type AgentPlan,
  type AgentTodo,
  type Collaboration,
  type CollaborationId,
  type InjectedContext,
  type MeshTask,
  type PlanPhase,
  type RunRecord,
  type SharedTodoDoc,
  type TodoStatus,
} from '@zorker/muti-agent-contracts'
import type { Logger } from '../adapter/types.ts'
import type { StateStore } from '../state/store.ts'

/** The persisted collaboration document. */
interface CollaborationDocument {
  version: 1
  collaborations: Record<string, Collaboration>
}

const COLLABORATION_PATH = 'collaborations.json'

/** Request to create a collaboration. */
export interface StartCollaborationRequest {
  title: string
  objective: string
  repoRoot?: string
  actor: string
  tasks?: readonly {
    title: string
    instruction: string
    assignee: string
    dependsOn?: readonly string[]
    isolation?: 'worktree' | 'shared-cwd'
  }[]
}

/** One todo mutation, applied against the board's current revision. */
export interface TodoMutation {
  /** Replace the whole list. */
  kind: 'replace'
  todos: readonly AgentTodo[]
}

/** The payload of the shared-plan context block, exposed for the mesh panel. */
export interface SharedContextPreview {
  /** The rendered block, or `undefined` when the plan mode is observe-only. */
  block?: InjectedContext
  /** Collaboration the preview was rendered for. */
  collaborationId: string
  /** Agent the block targets. */
  agentId: string
}

/**
 * The collaboration store. One document holds every collaboration, so a single
 * atomic write covers a board update; collaborations are small (tens of KB).
 */
export class CollaborationStore {
  /**
   * @param state - MutiAgent's state store.
   * @param log - Logger.
   */
  constructor(
    private readonly state: StateStore,
    private readonly log: Logger,
  ) {}

  /** Every collaboration, newest first. */
  async list(): Promise<readonly Collaboration[]> {
    const document = await this.documents()
    return Object.values(document.collaborations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * One collaboration.
   *
   * @param id - Collaboration id.
   * @throws {MutiAgentError} `mesh/collaboration-not-found`.
   */
  async get(id: string): Promise<Collaboration> {
    const document = await this.documents()
    const found = document.collaborations[id]
    if (found === undefined) {
      throw new MutiAgentError(ErrorCodes.meshCollaborationNotFound, `no collaboration with id ${id}`, {
        details: { id },
        remediation: 'List collaborations to find a valid id, or start one first.',
      })
    }
    return found
  }

  /** Create a collaboration with an initial plan and optional tasks. */
  async start(request: StartCollaborationRequest): Promise<Collaboration> {
    const id = brandCollaboration(`collab-${randomToken()}`)
    const now = new Date().toISOString()
    const phases: PlanPhase[] = [
      { id: 'phase-1', title: 'prepare', status: 'active' },
      { id: 'phase-2', title: 'execute', status: 'todo' },
      { id: 'phase-3', title: 'integrate', status: 'todo' },
    ]
    const collaboration: Collaboration = {
      id,
      title: request.title,
      repoRoot: request.repoRoot ?? process.cwd(),
      plan: {
        collaborationId: String(id),
        objective: request.objective,
        phases,
        activePhaseId: 'phase-1',
        decisions: [],
        updatedAt: now,
        mode: 'inject',
      },
      todos: { collaborationId: id, todos: [], updatedAt: now, revision: 1 },
      tasks: (request.tasks ?? []).map((task, index) => ({
        id: `task-${String(index + 1)}`,
        collaborationId: id,
        title: task.title,
        instruction: task.instruction,
        assignee: task.assignee as MeshTask['assignee'],
        status: task.dependsOn !== undefined && task.dependsOn.length > 0 ? 'blocked' : 'queued',
        dependsOn: task.dependsOn ?? [],
        createdAt: now,
        updatedAt: now,
      })),
      runs: [],
      worktrees: [],
      createdAt: now,
      updatedAt: now,
    }
    await this.mutate(current => ({ ...current, [String(id)]: collaboration }))
    this.state.appendJournal({
      at: now,
      kind: 'collaboration.started',
      id: String(id),
      actor: request.actor,
      detail: { title: request.title, tasks: collaboration.tasks.length },
    })
    return collaboration
  }

  /**
   * Replace the shared todo board.
   *
   * @param id - Collaboration id.
   * @param todos - The complete new list.
   * @param options - Expected revision; a mismatch is refused rather than applied.
   * @param actor - Who is mutating.
   * @returns The updated board.
   * @throws {MutiAgentError} `schema/todo-conflict` on a stale revision.
   */
  async setTodos(
    id: string,
    todos: readonly AgentTodo[],
    options: { expectedRevision?: number } = {},
    actor = 'user',
  ): Promise<SharedTodoDoc> {
    const collaboration = await this.get(id)
    if (options.expectedRevision !== undefined && options.expectedRevision !== collaboration.todos.revision) {
      throw new MutiAgentError(
        ErrorCodes.schemaTodoConflict,
        `the todo board moved to revision ${String(collaboration.todos.revision)}`,
        {
          details: { requested: options.expectedRevision, current: collaboration.todos.revision },
          remediation: 'Re-read the board, re-apply your change, then write again.',
        },
      )
    }
    const now = new Date().toISOString()
    const seen = new Set<string>()
    for (const todo of todos) {
      const key = String(todo.id)
      if (seen.has(key)) {
        throw new MutiAgentError(ErrorCodes.schemaInvalid, `duplicate todo id ${key}`, {
          details: { id: key },
        })
      }
      seen.add(key)
    }
    const board: SharedTodoDoc = {
      collaborationId: collaboration.id,
      todos: todos.map(todo => ({ ...todo, updatedAt: now })),
      updatedAt: now,
      revision: collaboration.todos.revision + 1,
    }
    await this.mutate(current => ({
      ...current,
      [id]: { ...collaboration, todos: board, updatedAt: now },
    }))
    this.state.appendJournal({
      at: now,
      kind: 'collaboration.todos',
      id,
      actor,
      detail: { count: todos.length, revision: board.revision },
    })
    return board
  }

  /**
   * Merge observed items into the board without overwriting authored ones.
   *
   * Observation is read-only in spirit: an item seen in an agent's native store may
   * update another item's *status*, but never its content, and a native status never
   * resurrects an item the board considers done.
   *
   * @param id - Collaboration id.
   * @param observed - Items projected from an agent's store.
   * @returns The updated board, or the unchanged board when nothing changed.
   */
  async observeTodos(id: string, observed: readonly AgentTodo[]): Promise<SharedTodoDoc> {
    const collaboration = await this.get(id)
    const now = new Date().toISOString()
    const byId = new Map(collaboration.todos.todos.map(todo => [String(todo.id), todo]))
    let changed = false
    for (const item of observed) {
      const existing = byId.get(String(item.id))
      if (existing === undefined) {
        byId.set(String(item.id), item)
        changed = true
        continue
      }
      if (existing.status !== item.status && existing.owner === 'shared') {
        byId.set(String(item.id), { ...existing, status: item.status, updatedAt: now })
        changed = true
      }
    }
    if (!changed) return collaboration.todos
    const board: SharedTodoDoc = {
      collaborationId: collaboration.id,
      todos: [...byId.values()],
      updatedAt: now,
      revision: collaboration.todos.revision + 1,
    }
    await this.mutate(current => ({ ...current, [id]: { ...collaboration, todos: board, updatedAt: now } }))
    return board
  }

  /** Create or replace a collaboration's plan. */
  async setPlan(
    id: string,
    patch: {
      objective?: string
      phases?: readonly PlanPhase[]
      activePhaseId?: string
      decisions?: readonly string[]
      mode?: AgentPlan['mode']
    },
    actor = 'user',
  ): Promise<AgentPlan> {
    const collaboration = await this.get(id)
    const now = new Date().toISOString()
    const plan: AgentPlan = {
      collaborationId: collaboration.plan.collaborationId,
      objective: patch.objective ?? collaboration.plan.objective,
      phases: patch.phases ?? collaboration.plan.phases,
      ...(patch.activePhaseId !== undefined
        ? { activePhaseId: patch.activePhaseId }
        : collaboration.plan.activePhaseId === undefined
          ? {}
          : { activePhaseId: collaboration.plan.activePhaseId }),
      decisions: patch.decisions ?? collaboration.plan.decisions,
      updatedAt: now,
      mode: patch.mode ?? collaboration.plan.mode,
    }
    await this.mutate(current => ({ ...current, [id]: { ...collaboration, plan, updatedAt: now } }))
    this.state.appendJournal({ at: now, kind: 'collaboration.plan', id, actor })
    return plan
  }

  /**
   * Move the plan to a phase, refusing a transition whose predecessors are unfinished.
   *
   * @param id - Collaboration id.
   * @param phaseId - Phase to activate.
   * @param actor - Who is advancing the plan.
   * @throws {MutiAgentError} `mesh/invalid-transition` when earlier phases are open.
   */
  async advancePhase(id: string, phaseId: string, actor = 'user'): Promise<AgentPlan> {
    const collaboration = await this.get(id)
    const index = collaboration.plan.phases.findIndex(phase => phase.id === phaseId)
    if (index === -1) {
      throw new MutiAgentError(ErrorCodes.meshInvalidTransition, `no phase ${phaseId} in this plan`, {
        details: { id, phaseId },
      })
    }
    const open = collaboration.plan.phases.slice(0, index).filter(phase => phase.status !== 'done')
    if (open.length > 0) {
      throw new MutiAgentError(
        ErrorCodes.meshInvalidTransition,
        `phase ${phaseId} cannot start while ${open.map(phase => phase.id).join(', ')} is open`,
        {
          details: { id, phaseId, open: open.map(phase => phase.id).join(',') },
          remediation: 'Mark the earlier phases done first, or reorder the plan.',
        },
      )
    }
    const phases = collaboration.plan.phases.map((phase, position) => {
      if (position < index) return { ...phase, status: 'done' as const }
      if (position === index) return { ...phase, status: 'active' as const }
      return phase
    })
    return this.setPlan(id, { phases, activePhaseId: phaseId }, actor)
  }

  /** Add or replace one task. */
  async upsertTask(id: string, task: MeshTask): Promise<MeshTask> {
    const collaboration = await this.get(id)
    const now = new Date().toISOString()
    const existing = collaboration.tasks.findIndex(candidate => candidate.id === task.id)
    const tasks = existing === -1 ? [...collaboration.tasks, task] : collaboration.tasks.map((candidate, index) =>
      index === existing ? { ...task, updatedAt: now } : candidate)
    await this.mutate(current => ({ ...current, [id]: { ...collaboration, tasks, updatedAt: now } }))
    return task
  }

  /** Record a finished run on the collaboration. */
  async recordRun(id: string, run: RunRecord): Promise<void> {
    const collaboration = await this.get(id)
    const now = new Date().toISOString()
    const runs = [run, ...collaboration.runs.filter(candidate => String(candidate.id) !== String(run.id))].slice(0, 200)
    const tasks = collaboration.tasks.map(task => {
      if (task.runId === undefined || String(task.runId) !== String(run.id)) return task
      const status: MeshTask['status'] =
        run.status === 'succeeded' ? 'succeeded' : run.status === 'cancelled' ? 'cancelled' : 'failed'
      return { ...task, status, updatedAt: now, ...(run.error === undefined ? {} : { note: run.error.message }) }
    })
    await this.mutate(current => ({ ...current, [id]: { ...collaboration, runs, tasks, updatedAt: now } }))
  }

  /**
   * Render the collaboration's shared documents as prompt context.
   *
   * The block is deterministic (stable ordering, no timestamps inside) so that two
   * dispatches of the same board produce byte-identical text and the run's recorded
   * context can be verified by hash.
   *
   * @param id - Collaboration id.
   * @param owner - Agent the block is rendered for, used to mark its own items.
   * @returns The context block, or `undefined` when sharing is set to observe-only
   *   and there is nothing to inject.
   */
  async contextBlock(id: string, owner: string): Promise<InjectedContext | undefined> {
    const collaboration = await this.get(id)
    if (collaboration.plan.mode === 'observe') return undefined
    const lines: string[] = []
    lines.push('# Shared collaboration context')
    lines.push('')
    lines.push(`Objective: ${collaboration.plan.objective}`)
    const active = collaboration.plan.phases.find(phase => phase.status === 'active')
    if (active !== undefined) {
      lines.push(`Current phase: ${active.title}${active.exitCriteria === undefined ? '' : ` (done when: ${active.exitCriteria})`}`)
    }
    const upcoming = collaboration.plan.phases.filter(phase => phase.status === 'todo').map(phase => phase.title)
    if (upcoming.length > 0) lines.push(`Remaining phases: ${upcoming.join(' -> ')}`)
    if (collaboration.plan.decisions.length > 0) {
      lines.push('')
      lines.push('Decisions already made (do not revisit):')
      for (const decision of collaboration.plan.decisions) lines.push(`- ${decision}`)
    }

    const todos = [...collaboration.todos.todos].sort((a, b) => {
      const rank = (status: TodoStatus): number => (status === 'in_progress' ? 0 : status === 'pending' ? 1 : 2)
      return rank(a.status) - rank(b.status) || a.content.localeCompare(b.content)
    })
    if (todos.length > 0) {
      lines.push('')
      lines.push('Shared task board (yours are marked `*`):')
      for (const todo of todos) {
        const mine = String(todo.owner) === owner ? '*' : ' '
        const blocked = todo.blockedBy.length > 0 ? ` [blocked by ${todo.blockedBy.join(', ')}]` : ''
        lines.push(`- ${mine} [${todo.status}] (${String(todo.owner)}) ${todo.content}${blocked}`)
      }
    }

    const siblings = collaboration.tasks.filter(task => task.assignee !== owner && task.status !== 'cancelled')
    if (siblings.length > 0) {
      lines.push('')
      lines.push('Other agents in this collaboration:')
      for (const task of siblings) {
        lines.push(`- ${String(task.assignee)}: ${task.title} [${task.status}]`)
      }
      lines.push('')
      lines.push(
        'Stay inside your own worktree. If you must change a file another agent is likely to touch, say so explicitly in your final message.',
      )
    }

    const text = lines.join('\n')
    return { kind: 'shared-plan', text, hash: contentHash(text) }
  }

  /** Load, mutate and persist the whole document under one lock. */
  private async mutate(transform: (current: Record<string, Collaboration>) => Record<string, Collaboration>): Promise<void> {
    await this.state.updateJson<CollaborationDocument>(COLLABORATION_PATH, { version: 1, collaborations: {} }, current => ({
      version: 1,
      collaborations: transform(current.collaborations),
    }))
  }

  private async documents(): Promise<CollaborationDocument> {
    const document = await this.state.readJson<CollaborationDocument>(COLLABORATION_PATH)
    if (document === undefined) return { version: 1, collaborations: {} }
    if (document.version !== 1) {
      this.log.warn('collaboration document has an unexpected version', { version: document.version })
    }
    return document
  }
}

/** Deterministic content hash used for context-block idempotence. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Deterministic todo id for an item observed in a native store.
 *
 * @param agentId - Owning agent.
 * @param nativeKey - The item's key in its native store.
 * @param content - Item text, mixed in so a reused native key produces a new id.
 */
export function observedTodoId(agentId: string, nativeKey: string, content: string): AgentTodo['id'] {
  return brandTodo(`obs-${contentHash(`${agentId}\u0000${nativeKey}\u0000${content}`).slice(0, 12)}`)
}

/** Build a canonical todo item with sensible defaults. */
export function makeTodo(options: {
  id: string
  content: string
  status: TodoStatus
  owner: string
  blockedBy?: readonly string[]
}): AgentTodo {
  return {
    id: brandTodo(options.id),
    content: options.content,
    status: options.status,
    owner: options.owner as AgentTodo['owner'],
    blockedBy: (options.blockedBy ?? []) as readonly AgentTodo['id'][],
    updatedAt: new Date().toISOString(),
  }
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Re-export so callers need one import for collaboration types. */
export type { Collaboration, CollaborationId, MeshTask, SharedTodoDoc, AgentPlan }
