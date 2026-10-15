/**
 * Canonical validators. Every value that crosses a boundary — the HTTP envelope,
 * an MCP `tools/call` argument, a persisted state file, a subprocess JSON line —
 * is validated with these, so the declared schema and the enforced schema are one
 * declaration (ADR-0002, ADR-0004).
 *
 * @module @zorker/muti-agent-contracts/schemas
 */

import { s, type Schema } from './validate.ts'

/** Validator for a canonical agent id. */
export const AgentIdSchema: Schema<string> = s.string().min(1).describeAs('Canonical agent id, e.g. `codex`.')

/** Validator for one todo status. */
export const TodoStatusSchema: Schema<string> = s
  .string()
  .enumOf(['pending', 'in_progress', 'completed', 'blocked', 'cancelled'])
  .describeAs('Task status.')

/** Validator for one projected todo item. */
export const AgentTodoSchema = s
  .objectOpt(
    {
      id: s.string().min(1).describeAs('Stable canonical id, unique within the collaboration.'),
      content: s.string().describeAs('Short imperative line describing the task.'),
      status: TodoStatusSchema,
      owner: s.string().min(1).describeAs('Owning agent id, or `shared` for a collaboration-level item.'),
      updatedAt: s.string().describeAs('ISO 8601 time of the last change.'),
    },
    {
      blockedBy: s.array(s.string()).describeAs('Ids that must complete before this item starts.'),
      observedIn: s.string().describeAs('Canonical session key the item was observed in.'),
      nativeKey: s.string().describeAs('The item key in its native store, for traceability.'),
    },
  )
  .describeAs('One shared task item.')

/** Validator for a shared todo document. */
export const SharedTodoDocSchema = s
  .objectOpt(
    {
      collaborationId: s.string().min(1),
      todos: s.array(AgentTodoSchema),
      updatedAt: s.string(),
      revision: s.number().int().min(0).describeAs('Monotonic revision, bumped on every accepted mutation.'),
    },
    {},
  )
  .describeAs('The collaboration todo board.')

/** Validator for one plan phase. */
export const PlanPhaseSchema = s
  .objectOpt(
    {
      id: s.string().min(1),
      title: s.string(),
      status: s.string().enumOf(['todo', 'active', 'done']),
    },
    {
      owner: s.string(),
      exitCriteria: s.string(),
    },
  )
  .describeAs('One phase of a shared plan.')

/** Validator for the shared plan document. */
export const AgentPlanSchema = s
  .objectOpt(
    {
      collaborationId: s.string().min(1),
      objective: s.string(),
      phases: s.array(PlanPhaseSchema),
      decisions: s.array(s.string()),
      updatedAt: s.string(),
      mode: s.string().enumOf(['inject', 'observe']),
    },
    {
      activePhaseId: s.string(),
    },
  )
  .describeAs('The collaboration plan document.')

/** Validator for the run-start parameters, shared by HTTP, MCP and native tools. */
export const RunStartParamsSchema = s
  .objectOpt(
    {
      agentId: AgentIdSchema,
      prompt: s.string().min(1).describeAs('The task text handed to the agent.'),
    },
    {
      cwd: s.string().describeAs('Absolute directory to run in; defaults to the current workspace.'),
      collaborationId: s.string().describeAs('Attach the run to a collaboration so todos and plan are shared.'),
      isolation: s.string().enumOf(['worktree', 'shared-cwd']).describeAs('Code isolation mode.'),
      resumeNativeId: s.string().describeAs('Continue this native session instead of starting a new one.'),
      model: s.string(),
      sandbox: s.string(),
      approval: s.string(),
      timeoutMs: s.number().int().min(1),
      env: s.record(s.string()).describeAs('Extra environment entries for this run only.'),
      requestedBy: s.string().describeAs('Who asked for the run; recorded in the run record.'),
    },
  )
  .describeAs('Dispatch one delegated run.')

/** Validator for a worktree creation request. */
export const WorktreeCreateParamsSchema = s
  .objectOpt(
    {
      agentId: AgentIdSchema,
      repoRoot: s.string().describeAs('Absolute path of the repository to branch from.'),
    },
    {
      baseRef: s.string().describeAs('Ref to branch from; defaults to the repository default branch.'),
      label: s.string().describeAs('Short label incorporated into the branch and directory name.'),
      collaborationId: s.string(),
      reuse: s.boolean().describeAs('Reuse an existing idle worktree for this agent instead of creating one.'),
    },
  )
  .describeAs('Allocate an isolated git worktree.')

/** Validator for a `sessions.list` request. */
export const SessionListParamsSchema = s
  .objectOpt(
    {},
    {
      agentIds: s.array(AgentIdSchema),
      cwd: s.string().describeAs('Only sessions created in this working directory.'),
      repoRoot: s.string(),
      query: s.string().describeAs('Substring match against title, cwd and native id.'),
      includeUntracked: s.boolean().describeAs('Include sessions discovered but not yet tracked.'),
      sort: s.string().enumOf(['updated', 'created', 'title']),
      limit: s.number().int().min(1).max(1000),
    },
  )
  .describeAs('List canonical sessions, optionally grouped per agent.')

/** Validator for a `todos.set` request. */
export const TodosSetParamsSchema = s
  .objectOpt(
    {
      collaborationId: s.string().min(1),
      todos: s.array(AgentTodoSchema).describeAs('The complete list, replacing the previous one.'),
    },
    {
      expectedRevision: s.number().int().min(0).describeAs('Reject when the board has moved past this revision.'),
    },
  )
  .describeAs('Replace the shared todo board.')

/** Validator for a `plan.set` request. */
export const PlanSetParamsSchema = s
  .objectOpt(
    {
      collaborationId: s.string().min(1),
      objective: s.string().min(1),
    },
    {
      phases: s.array(PlanPhaseSchema),
      activePhaseId: s.string(),
      decisions: s.array(s.string()),
      mode: s.string().enumOf(['inject', 'observe']),
    },
  )
  .describeAs('Create or replace a collaboration plan.')

/** Validator for a `collaboration.start` request. */
export const CollaborationStartParamsSchema = s
  .objectOpt(
    {
      title: s.string().min(1).describeAs('Human title for the collaboration.'),
      objective: s.string().min(1).describeAs('One-sentence objective, used as the plan objective.'),
    },
    {
      repoRoot: s.string().describeAs('Repository the collaboration works in.'),
      tasks: s
        .array(
          s.objectOpt(
            {
              title: s.string().min(1),
              instruction: s.string().min(1),
              assignee: AgentIdSchema,
            },
            {
              dependsOn: s.array(s.string()),
              isolation: s.string().enumOf(['worktree', 'shared-cwd']),
            },
          ),
        )
        .describeAs('Tasks to create immediately.'),
    },
  )
  .describeAs('Start a collaboration across multiple agents.')

/** Validator for the wire envelope's params field, which is method-specific. */
export const JsonObjectSchema = s
  .record(s.json())
  .describeAs('Method-specific parameter object.')
