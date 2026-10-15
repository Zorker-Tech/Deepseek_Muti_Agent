/**
 * Every MutiAgent capability, declared once. The three surfaces (native tools, MCP,
 * HTTP) are generated from this registration, so an operation added here appears
 * everywhere with the same validation and the same confirmation gate (ADR-0011).
 *
 * @module @zorker/muti-agent-control-plane/operations/register
 */

import {
  ErrorCodes,
  MutiAgentError,
  SCHEMA_VERSION,
  WIRE_VERSION,
  agentId as brandAgentId,
  nativeSessionId as brandNativeSessionId,
  sessionKey as makeSessionKey,
  s,
  todoId as brandTodoId,
  type AgentPlan,
  type AgentTodo,
  type MeshWorkspace,
  type RunRecord,
  type TodoStatus,
} from '@zorker/muti-agent-contracts'
import {
  AgentParam,
  CollaborationParam,
  ConfirmField,
  NoParams,
  PlanSetParamsSchema,
  RunParam,
  RunStartParamsSchema,
  SessionKeyParam,
  SessionListParamsSchema,
  TodosSetParamsSchema,
  WorktreeCreateParamsSchema,
  WorktreeParam,
  type MeshOperation,
  type OperationCatalog,
} from './catalog.ts'

/** Result of `agents.diagnostics`. */
export interface DiagnosticsReport {
  schemaVersion: number
  wireVersion: number
  pluginVersion: string
  stateDir: string
  isolation: 'worktree' | 'shared-disabled'
  harness: {
    /** Harness services this process could reach, by name. */
    services: readonly string[]
    /** Seams that were absent, with the capability they disable. */
    missing: readonly { service: string, disables: string }[]
  }
  agents: readonly {
    agentId: string
    displayName: string
    installed: boolean
    version?: string
    binaryPath?: string
    reason?: string
    transports: readonly { mode: string, mechanism: string, available: boolean }[]
  }[]
  warnings: readonly string[]
}

/** Result of `mcp.config`. */
export interface McpConfigReport {
  /** The stdio server command an MCP client should launch. */
  stdio: { command: string, args: readonly string[], env: Readonly<Record<string, string>> }
  /** The streamable HTTP endpoint, when the harness serves one. */
  http?: { url: string, headers?: Readonly<Record<string, string>> }
  /** Ready-to-paste configuration per agent, using each agent's own config format. */
  forAgents: readonly {
    agentId: string
    /** Where the snippet belongs. */
    location: string
    /** The configuration fragment, as text. */
    snippet: string
  }[]
}

/** Extra facts the plugin supplies that the domain layer does not know. */
export interface RegistrationContext {
  /** Plugin version string. */
  pluginVersion: string
  /**
   * The effective harness surfaces, read when diagnostics are requested.
   *
   * A function rather than a snapshot: registration is reactive, so the surfaces that are
   * up when a user asks is not the set that existed when the plugin activated.
   */
  surfaces: () => {
    /** Surfaces that are mounted and serving. */
    services: readonly string[]
    /** Surfaces that are not mounted, with what each absence disables. */
    missing: readonly { service: string, disables: string }[]
    /** Surfaces whose registration threw, with the reason. */
    failed: readonly { service: string, reason: string }[]
  }
  /** Absolute path of the stdio MCP entry script, when the plugin knows it. */
  mcpEntry?: string
  /** Streamable HTTP endpoint, when the harness serves one. */
  mcpHttpUrl?: string
}

/**
 * Register every operation.
 *
 * @param catalog - Catalog to fill.
 * @param context - Plugin-supplied facts for the diagnostic operations.
 */
export function registerOperations(catalog: OperationCatalog, context: RegistrationContext): void {
  for (const operation of buildOperations(context, catalog)) catalog.register(operation)
}

/**
 * Build the operation list.
 *
 * @param context - Plugin-supplied facts for the diagnostic operations.
 * @param catalog - The catalog being filled, so `mutiagent.methods` can describe the
 *   live set instead of a snapshot taken before registration finished.
 */
export function buildOperations(
  context: RegistrationContext,
  catalog?: OperationCatalog,
): readonly MeshOperation<never, unknown>[] {
  const operations: MeshOperation<never, unknown>[] = []

  const add = <P, R>(operation: MeshOperation<P, R>): void => {
    operations.push(operation as unknown as MeshOperation<never, unknown>)
  }

  // ---------------------------------------------------------------- catalog ----

  add({
    id: 'mutiagent.methods',
    summary: 'List every MutiAgent method with its parameters, authority and JSON Schema.',
    params: NoParams,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: false,
    run: async () => ({
      schemaVersion: SCHEMA_VERSION,
      wireVersion: WIRE_VERSION,
      pluginVersion: context.pluginVersion,
      methods: catalog?.describe() ?? [],
    }),
  })

  add({
    id: 'agents.diagnostics',
    summary: 'Report what MutiAgent can reach on this machine: services, agents and warnings.',
    params: NoParams,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx) => {
      const descriptors = await ctx.service.registry.describe()
      const warnings = ctx.service.registry.inspectCapabilities()
      return {
        schemaVersion: SCHEMA_VERSION,
        wireVersion: WIRE_VERSION,
        pluginVersion: context.pluginVersion,
        stateDir: ctx.service.stateRoot,
        isolation: ctx.service.worktrees === undefined ? 'shared-disabled' : 'worktree',
        harness: context.surfaces(),
        agents: descriptors.map(entry => ({
          agentId: String(entry.descriptor.id),
          displayName: entry.descriptor.displayName,
          installed: entry.descriptor.detection.installed,
          ...(entry.descriptor.detection.version === undefined ? {} : { version: entry.descriptor.detection.version }),
          ...(entry.descriptor.detection.binaryPath === undefined
            ? {}
            : { binaryPath: entry.descriptor.detection.binaryPath }),
          ...(entry.descriptor.detection.reason === undefined ? {} : { reason: entry.descriptor.detection.reason }),
          transports: entry.descriptor.transports.map(transport => ({
            mode: transport.mode,
            mechanism: transport.mechanism,
            available: transport.available,
          })),
        })),
        warnings,
      }
    },
  })

  add({
    id: 'agents.list',
    summary: 'List every integrated agent with its capabilities, detection result and transports.',
    params: NoParams,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx) => ({ agents: await ctx.service.registry.describe() }),
  })

  // --------------------------------------------------------------- sessions ----

  add({
    id: 'sessions.list',
    summary: 'List canonical sessions across agents, filtered and sorted.',
    params: SessionListParamsSchema,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ({
      sessions: await ctx.service.sessions.list({
        ...(params.agentIds === undefined ? {} : { agentIds: params.agentIds }),
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.repoRoot === undefined ? {} : { repoRoot: params.repoRoot }),
        ...(params.query === undefined ? {} : { query: params.query }),
        ...(params.includeUntracked === undefined ? {} : { includeUntracked: params.includeUntracked }),
        ...(params.sort === undefined ? {} : { sort: params.sort as 'updated' | 'created' | 'title' }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }),
    }),
  })

  add({
    id: 'sessions.partitions',
    summary: 'Per-agent session partitions, ready for the sidebar, plus index freshness.',
    params: SessionListParamsSchema,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => ({
      partitions: await ctx.service.sessions.partitions({
        ...(params.agentIds === undefined ? {} : { agentIds: params.agentIds }),
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.repoRoot === undefined ? {} : { repoRoot: params.repoRoot }),
        ...(params.query === undefined ? {} : { query: params.query }),
        ...(params.includeUntracked === undefined ? {} : { includeUntracked: params.includeUntracked }),
        ...(params.sort === undefined ? {} : { sort: params.sort as 'updated' | 'created' | 'title' }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }),
      summary: await ctx.service.sessions.summary(),
    }),
  })

  add({
    id: 'sessions.refresh',
    summary: 'Re-scan the agents\' own session stores and update the index.',
    params: s.objectOpt({}, {
      agentIds: s.array(AgentParam).describeAs('Agents to scan; omitted scans all of them.'),
    }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const requested = params.agentIds ?? ctx.service.registry.ids()
      const outcomes: { agentId: string, ok: boolean, found: number, error?: string }[] = []
      for (const agentId of requested) {
        const outcome = await ctx.service.sessions.refresh(agentId, {
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
        outcomes.push({
          agentId: outcome.agentId,
          ok: outcome.ok,
          found: outcome.found,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        })
      }
      return { outcomes }
    },
  })

  add({
    id: 'sessions.transcript',
    summary: 'Read a bounded transcript window for one session.',
    params: s.objectOpt({ key: SessionKeyParam }, {
      maxMessages: s.number().int().min(1).max(2000).describeAs('Messages to return, counted from the end.'),
    }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ctx.service.sessions.transcript(params.key, {
      ...(params.maxMessages === undefined ? {} : { maxMessages: params.maxMessages }),
    }),
  })

  add({
    id: 'sessions.native_tasks',
    summary: 'Read an agent\'s own todo list and plan state for a session.',
    params: s.object({ key: SessionKeyParam }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const state = await ctx.service.sessions.nativeTasks(params.key)
      if (state === undefined) {
        return { todos: [], notes: [], available: false }
      }
      return {
        todos: state.todos,
        ...(state.plan === undefined ? {} : { plan: state.plan }),
        notes: state.notes,
        available: true,
      }
    },
  })

  add({
    id: 'sessions.import',
    summary: 'Track (import) discovered sessions so they appear in the sidebar.',
    params: s.objectOpt({ keys: s.array(SessionKeyParam).min(1).describeAs('Session keys to track.') }, {
      actor: s.string().describeAs('Who or what is importing, recorded in the audit journal.'),
    }),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const tracked: string[] = []
      const alreadyTracked: string[] = []
      const existing = await ctx.service.sessions.tracking()
      for (const key of params.keys) {
        if (key in existing.tracked) {
          alreadyTracked.push(key)
          continue
        }
        await ctx.service.sessions.track(key, params.actor ?? ctx.actor.id)
        tracked.push(key)
      }
      return { tracked, alreadyTracked }
    },
  })

  add({
    id: 'sessions.untrack',
    summary: 'Stop tracking sessions, removing them from the sidebar without touching their files.',
    params: s.object({ keys: s.array(SessionKeyParam).min(1) }),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => {
      const untracked: string[] = []
      for (const key of params.keys) {
        if (await ctx.service.sessions.untrack(key, ctx.actor.id)) untracked.push(key)
      }
      return { untracked }
    },
  })

  // ------------------------------------------------------------------- runs ----

  add({
    id: 'runs.start',
    summary: 'Dispatch a task to one agent, in an isolated worktree by default.',
    params: RunStartParamsSchema,
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const result = await ctx.service.runs.dispatch({
        agentId: params.agentId,
        prompt: params.prompt,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.collaborationId === undefined ? {} : { collaborationId: params.collaborationId }),
        ...(params.isolation === undefined ? {} : { isolation: params.isolation as 'worktree' | 'shared-cwd' }),
        ...(params.resumeNativeId === undefined ? {} : { resumeNativeId: params.resumeNativeId }),
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.sandbox === undefined ? {} : { sandbox: params.sandbox }),
        ...(params.approval === undefined ? {} : { approval: params.approval }),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(params.env === undefined ? {} : { env: params.env }),
        requestedBy: params.requestedBy ?? ctx.actor.id,
      })
      return { run: result.record }
    },
  })

  add({
    id: 'runs.cancel',
    summary: 'Stop a running agent by terminating its process group.',
    params: s.objectOpt({ runId: RunParam }, {
      reason: s.string().describeAs('Reason recorded on the run.'),
    }),
    scope: 'dangerous',
    danger: 'needs-confirm',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const cancelled = ctx.service.runs.cancel(params.runId, params.reason ?? `cancelled by ${ctx.actor.id}`)
      const run = await ctx.service.runs.get(params.runId)
      return { cancelled, ...(run === undefined ? {} : { run }) }
    },
  })

  add({
    id: 'runs.wait',
    summary: 'Wait for a run to reach a terminal state, then return its record.',
    params: s.objectOpt({ runId: RunParam }, {
      waitMs: s.number().int().min(1000).max(3_600_000).describeAs('Maximum time to wait, in milliseconds.'),
    }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const first = await ctx.service.runs.get(params.runId)
      if (first === undefined) {
        throw new MutiAgentError(ErrorCodes.meshTaskNotFound, `no run with id ${params.runId}`, {
          details: { runId: params.runId },
        })
      }
      const deadline = Date.now() + (params.waitMs ?? 600_000)
      let record = first
      while (isLive(record) && Date.now() < deadline) {
        await delay(500)
        record = (await ctx.service.runs.get(params.runId)) ?? record
      }
      return record
    },
  })

  add({
    id: 'runs.list',
    summary: 'List recent runs, newest first, live ones included.',
    params: s.objectOpt({}, {
      limit: s.number().int().min(1).max(500).describeAs('Maximum records to return.'),
    }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ({ runs: await ctx.service.runs.history(params.limit ?? 50) }),
  })

  add({
    id: 'runs.get',
    summary: 'Read one run record, live or historical.',
    params: s.object({ runId: RunParam }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => {
      const record = await ctx.service.runs.get(params.runId)
      if (record === undefined) {
        throw new MutiAgentError(ErrorCodes.meshTaskNotFound, `no run with id ${params.runId}`, {
          details: { runId: params.runId },
        })
      }
      return record
    },
  })

  add({
    id: 'runs.interrupt',
    summary: 'Interrupt a run mid-turn when the agent supports it; otherwise reported as unavailable.',
    params: s.object({ runId: RunParam }),
    scope: 'dangerous',
    danger: 'needs-confirm',
    exposeAsTool: false,
    run: async (ctx, params) => {
      const record = await ctx.service.runs.get(params.runId)
      if (record === undefined) {
        throw new MutiAgentError(ErrorCodes.meshTaskNotFound, `no run with id ${params.runId}`, {
          details: { runId: params.runId },
        })
      }
      const capabilities = ctx.service.registry.capabilities(String(record.agentId))
      if (capabilities?.interrupt !== true) {
        throw new MutiAgentError(
          ErrorCodes.runNotRunning,
          `${String(record.agentId)} cannot be interrupted mid-turn in this adapter version`,
          {
            details: { agentId: String(record.agentId) },
            remediation: 'Cancel the run instead, or wait for the current turn to finish.',
          },
        )
      }
      return { cancelled: ctx.service.runs.cancel(params.runId, 'interrupted') }
    },
  })

  // -------------------------------------------------------------- worktrees ----

  add({
    id: 'worktrees.create',
    summary: 'Allocate an isolated git worktree for an agent.',
    params: WorktreeCreateParamsSchema,
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      if (ctx.service.worktrees === undefined) {
        throw new MutiAgentError(
          ErrorCodes.worktreeGitUnavailable,
          'worktree isolation is disabled in settings',
          { remediation: 'Enable worktree isolation, then retry.' },
        )
      }
      return {
        worktree: await ctx.service.worktrees.allocate({
          agentId: params.agentId,
          repoRoot: params.repoRoot,
          ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef }),
          ...(params.label === undefined ? {} : { label: params.label }),
          ...(params.collaborationId === undefined ? {} : { collaborationId: params.collaborationId }),
          ...(params.reuse === undefined ? {} : { reuse: params.reuse }),
        }),
      }
    },
  })

  add({
    id: 'worktrees.list',
    summary: 'List worktrees MutiAgent owns, with the latest progress sample for each.',
    params: s.objectOpt({}, {
      repoRoot: s.string().describeAs('Only worktrees belonging to this repository.'),
    }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      if (ctx.service.worktrees === undefined) return { worktrees: [] }
      if (params.repoRoot === undefined) {
        return { worktrees: await ctx.service.worktrees.list() }
      }
      return { worktrees: await ctx.service.worktrees.listForRepo(params.repoRoot) }
    },
  })

  add({
    id: 'worktrees.conflicts',
    summary: 'Compare active worktrees and report code and functional conflicts before a merge.',
    params: s.object({ repoRoot: s.string().describeAs('Repository to analyse.') }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const report = await ctx.service.worktreeReport(params.repoRoot)
      if (report === undefined) {
        throw new MutiAgentError(
          ErrorCodes.worktreeGitUnavailable,
          'worktree isolation is disabled, so there is nothing to compare',
          { remediation: 'Enable worktree isolation in settings.' },
        )
      }
      return report.conflicts
    },
  })

  add({
    id: 'worktrees.remove',
    summary: 'Remove a worktree MutiAgent owns. Unmerged work requires force.',
    params: s.objectOpt({ worktreeId: WorktreeParam }, {
      force: s.boolean().describeAs('Discard uncommitted and unmerged work. Irreversible.'),
    }),
    scope: 'dangerous',
    danger: 'irreversible',
    exposeAsTool: true,
    run: async (ctx, params) => {
      if (ctx.service.worktrees === undefined) {
        throw new MutiAgentError(ErrorCodes.worktreeGitUnavailable, 'worktree isolation is disabled')
      }
      if (params.force === true) {
        ctx.service.state.appendJournal({
          at: new Date().toISOString(),
          kind: 'worktree.removed-forced',
          id: params.worktreeId,
          actor: ctx.actor.id,
        })
      }
      return {
        worktree: await ctx.service.worktrees.remove(params.worktreeId, {
          ...(params.force === undefined ? {} : { force: params.force }),
        }),
      }
    },
  })

  add({
    id: 'worktrees.mark_integrated',
    summary: 'Record that a worktree\'s work has been merged, so it stops reading as outstanding.',
    params: s.objectOpt({ worktreeId: WorktreeParam }, {
      merged: s.boolean().describeAs('Set false to mark it outstanding again.'),
    }),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => {
      if (ctx.service.worktrees === undefined) {
        throw new MutiAgentError(ErrorCodes.worktreeGitUnavailable, 'worktree isolation is disabled')
      }
      if (params.merged === false) {
        const current = await ctx.service.worktrees.get(params.worktreeId)
        if (current === undefined) {
          throw new MutiAgentError(ErrorCodes.worktreeNotFound, `no worktree ${params.worktreeId}`)
        }
        const worktree = await ctx.service.worktrees.sample(params.worktreeId, false)
        void worktree
        return { worktree: { ...current, state: 'idle' } }
      }
      const worktree = await ctx.service.worktrees.markIntegrated(params.worktreeId)
      if (worktree === undefined) {
        throw new MutiAgentError(ErrorCodes.worktreeNotFound, `no worktree ${params.worktreeId}`, {
          details: { worktreeId: params.worktreeId },
        })
      }
      return { worktree }
    },
  })

  // --------------------------------------------------------- collaborations ----

  add({
    id: 'collaborations.start',
    summary: 'Start a collaboration so several agents share one plan and one todo board.',
    params: s.objectOpt(
      {
        title: s.string().min(1).describeAs('Human title.'),
        objective: s.string().min(1).describeAs('One-sentence objective, used as the plan objective.'),
      },
      {
        repoRoot: s.string().describeAs('Repository the collaboration works in.'),
        tasks: s.array(
          s.objectOpt(
            {
              title: s.string().min(1),
              instruction: s.string().min(1),
              assignee: AgentParam,
            },
            {
              dependsOn: s.array(s.string()),
              isolation: s.string().enumOf(['worktree', 'shared-cwd']),
            },
          ),
        ),
      },
    ),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ({
      collaboration: await ctx.service.collaborations.start({
        title: params.title,
        objective: params.objective,
        actor: ctx.actor.id,
        ...(params.repoRoot === undefined ? {} : { repoRoot: params.repoRoot }),
        ...(params.tasks === undefined
          ? {}
          : {
              tasks: params.tasks.map(task => ({
                title: task.title,
                instruction: task.instruction,
                assignee: task.assignee,
                ...(task.dependsOn === undefined ? {} : { dependsOn: task.dependsOn }),
                ...(task.isolation === undefined
                  ? {}
                  : { isolation: task.isolation as 'worktree' | 'shared-cwd' }),
              })),
            }),
      }),
    }),
  })

  add({
    id: 'collaborations.list',
    summary: 'List collaborations with their plan, board, tasks, runs and worktrees.',
    params: NoParams,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx) => ({ collaborations: await ctx.service.collaborations.list() }),
  })

  add({
    id: 'collaborations.get',
    summary: 'Read one collaboration.',
    params: s.object({ collaborationId: CollaborationParam }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => ctx.service.collaborations.get(params.collaborationId),
  })

  add({
    id: 'todos.set',
    summary: 'Replace a collaboration\'s shared todo board.',
    params: TodosSetParamsSchema,
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ({
      todos: await ctx.service.collaborations.setTodos(
        params.collaborationId,
        toCanonicalTodos(params.todos),
        { ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }) },
        ctx.actor.id,
      ),
    }),
  })

  add({
    id: 'todos.get',
    summary: 'Read a collaboration\'s shared todo board.',
    params: s.object({ collaborationId: CollaborationParam }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => (await ctx.service.collaborations.get(params.collaborationId)).todos,
  })

  add({
    id: 'todos.observe',
    summary: 'Fold an agent\'s own todo state into the shared board without overwriting authored items.',
    params: s.object({
      collaborationId: CollaborationParam,
      agentId: AgentParam,
      sessionKey: SessionKeyParam,
    }),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => {
      const native = await ctx.service.sessions.nativeTasks(params.sessionKey)
      if (native === undefined || native.todos.length === 0) {
        return { todos: (await ctx.service.collaborations.get(params.collaborationId)).todos, observed: 0 }
      }
      const observed: AgentTodo[] = native.todos.map(todo => ({
        id: todo.id as AgentTodo['id'],
        content: todo.content,
        status: normalizeTodoStatus(todo.status),
        owner: params.agentId as AgentTodo['owner'],
        blockedBy: [],
        updatedAt: new Date().toISOString(),
        observedIn: makeSessionKey(
          brandAgentId(params.agentId),
          brandNativeSessionId(params.sessionKey.split(':')[1] ?? ''),
        ),
        ...(todo.nativeKey === undefined ? {} : { nativeKey: todo.nativeKey }),
      }))
      return {
        todos: await ctx.service.collaborations.observeTodos(params.collaborationId, observed),
        observed: observed.length,
      }
    },
  })

  add({
    id: 'plan.set',
    summary: 'Create or replace a collaboration\'s plan.',
    params: PlanSetParamsSchema,
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ({
      plan: await ctx.service.collaborations.setPlan(
        params.collaborationId,
        {
          objective: params.objective,
          ...(params.phases === undefined ? {} : { phases: params.phases as AgentPlan['phases'] }),
          ...(params.activePhaseId === undefined ? {} : { activePhaseId: params.activePhaseId }),
          ...(params.decisions === undefined ? {} : { decisions: params.decisions }),
          ...(params.mode === undefined ? {} : { mode: params.mode as AgentPlan['mode'] }),
        },
        ctx.actor.id,
      ),
    }),
  })

  add({
    id: 'plan.get',
    summary: 'Read a collaboration\'s plan.',
    params: s.object({ collaborationId: CollaborationParam }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => (await ctx.service.collaborations.get(params.collaborationId)).plan,
  })

  add({
    id: 'plan.advance',
    summary: 'Activate a plan phase once its predecessors are done.',
    params: s.object({ collaborationId: CollaborationParam, phaseId: s.string().min(1) }),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ({
      plan: await ctx.service.collaborations.advancePhase(params.collaborationId, params.phaseId, ctx.actor.id),
    }),
  })

  add({
    id: 'plan.context_preview',
    summary: 'Show exactly what shared context a delegated agent will receive.',
    params: s.object({ collaborationId: CollaborationParam, agentId: AgentParam }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => {
      const block = await ctx.service.collaborations.contextBlock(params.collaborationId, params.agentId)
      return block === undefined ? {} : { context: block.text, hash: block.hash }
    },
  })

  add({
    id: 'collaborations.dispatch_task',
    summary: 'Dispatch one collaboration task to its assigned agent.',
    params: s.objectOpt(
      { collaborationId: CollaborationParam, taskId: s.string().min(1) },
      { wait: s.boolean().describeAs('Wait for the run to finish before returning.') },
    ),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const collaboration = await ctx.service.collaborations.get(params.collaborationId)
      const task = collaboration.tasks.find(candidate => candidate.id === params.taskId)
      if (task === undefined) {
        throw new MutiAgentError(ErrorCodes.meshTaskNotFound, `no task ${params.taskId} in this collaboration`, {
          details: { collaborationId: params.collaborationId, taskId: params.taskId },
        })
      }
      if (task.status === 'running' || task.status === 'succeeded') {
        throw new MutiAgentError(
          ErrorCodes.meshInvalidTransition,
          `task ${params.taskId} is already ${task.status}`,
          { details: { taskId: params.taskId, status: task.status } },
        )
      }
      const blockedBy = collaboration.tasks.filter(
        candidate => task.dependsOn.includes(candidate.id) && candidate.status !== 'succeeded',
      )
      if (blockedBy.length > 0) {
        throw new MutiAgentError(
          ErrorCodes.meshInvalidTransition,
          `task ${params.taskId} is blocked by ${blockedBy.map(candidate => candidate.id).join(', ')}`,
          { details: { taskId: params.taskId, blockedBy: blockedBy.map(candidate => candidate.id).join(',') } },
        )
      }
      const result = await ctx.service.runs.dispatch({
        agentId: String(task.assignee),
        prompt: task.instruction,
        cwd: collaboration.repoRoot,
        collaborationId: params.collaborationId,
        taskId: task.id,
        requestedBy: ctx.actor.id,
        ...(params.wait === undefined ? {} : { wait: params.wait }),
      })
      await ctx.service.collaborations.upsertTask(params.collaborationId, {
        ...task,
        status: 'running',
        runId: result.record.id,
        updatedAt: new Date().toISOString(),
        ...(result.record.worktreeId === undefined ? {} : { worktreeId: result.record.worktreeId }),
      })
      return { run: result.record, task: { ...task, status: 'running', runId: result.record.id } }
    },
  })

  // ------------------------------------------------------------ credentials ----

  add({
    id: 'credentials.list',
    summary: 'Sign-in state for every agent, with what MutiAgent can change and what it cannot.',
    params: NoParams,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx) => ({ credentials: await ctx.service.credentials.rows() }),
  })

  add({
    id: 'credentials.status',
    summary: 'Sign-in state for one agent.',
    params: s.object({ agentId: AgentParam }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ({
      credentials: (await ctx.service.credentials.rows()).filter(row => row.agentId === params.agentId),
    }),
  })

  add({
    id: 'credentials.login',
    summary: 'Start an agent\'s own sign-in flow. The plugin never stores the credential.',
    params: s.objectOpt(
      {
        agentId: AgentParam,
        flow: s
          .string()
          .enumOf(['oauth-loopback', 'device-code', 'api-key', 'interactive'])
          .describeAs('Which sign-in flow to start.'),
      },
      {
        secret: s.string().describeAs('API key for an api-key flow. Sent on stdin and never persisted.'),
      },
    ),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => ({
      result: await ctx.service.credentials.login(
        params.agentId,
        params.flow as 'oauth-loopback' | 'device-code' | 'api-key' | 'interactive',
        params.secret,
      ),
    }),
  })

  add({
    id: 'credentials.logout',
    summary: 'Sign out of one agent by revoking the credential through its own CLI.',
    params: s.object({ agentId: AgentParam }),
    scope: 'dangerous',
    danger: 'needs-confirm',
    exposeAsTool: true,
    run: async (ctx, params) => ({
      result: await ctx.service.credentials.logout(params.agentId),
    }),
  })

  // ---------------------------------------------------------------- models ----

  add({
    id: 'models.list',
    summary: 'Read each agent\'s model and provider catalog from its own configuration files.',
    params: s.objectOpt({}, {
      agentIds: s.array(AgentParam).describeAs('Agents to read; omitted reads every registered agent.'),
    }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => ({
      catalogs: await ctx.service.modelCatalogs(params.agentIds),
    }),
  })

  // ----------------------------------------------------------- preferences ----

  add({
    id: 'preferences.get',
    summary: 'Read the operator preferences MutiAgent persists, notably the default agent.',
    params: NoParams,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: true,
    run: async ctx => {
      const preferences = await ctx.service.preferences()
      // A binding is only settled once its conversation has begun, so the caller needs to
      // know which of them have — otherwise a UI would show a locked control for a session
      // that can still be changed, or offer a change the host will refuse.
      return {
        ...preferences,
        startedSessions: ctx.service.startedSessions(Object.keys(preferences.agentBySession ?? {})),
      }
    },
  })

  add({
    id: 'preferences.set',
    summary: 'Store operator preferences, such as the agent a delegated run defaults to.',
    params: s.objectOpt(
      {},
      {
        preferredAgent: AgentParam.describeAs('Agent a delegated run defaults to when the caller names none.'),
        sessionAgent: s
          .objectOpt(
            {
              sessionId: s.string().min(1).describeAs('Harness session id whose composer made the choice.'),
              agentId: s
                .string()
                .min(1)
                .describeAs('Agent for this session, or the reserved "harness" for no delegation.'),
            },
            {},
          )
          .describeAs(
            'Bind one conversation to an agent. The binding is fixed once set: a later call '
            + 'naming a different agent for the same session is refused with session/agent-locked.',
          ),
        preferredModel: s
          .objectOpt(
            {
              agentId: AgentParam,
              model: s.string().min(1).describeAs('Model id as the agent accepts it on its command line.'),
            },
            {},
          )
          .describeAs('Record the model an agent should run by default.'),
      },
    ),
    scope: 'mutate',
    danger: 'safe',
    exposeAsTool: true,
    run: async (ctx, params) => {
      const patch: {
        preferredAgent?: string
        agentBySession?: Record<string, string>
        preferredModelByAgent?: Record<string, string>
      } = {}
      if (params.preferredAgent !== undefined) patch.preferredAgent = params.preferredAgent
      if (params.sessionAgent !== undefined) {
        const current = await ctx.service.preferences()
        patch.agentBySession = {
          ...current.agentBySession,
          [params.sessionAgent.sessionId]: params.sessionAgent.agentId,
        }
      }
      if (params.preferredModel !== undefined) {
        const current = await ctx.service.preferences()
        patch.preferredModelByAgent = {
          ...current.preferredModelByAgent,
          [params.preferredModel.agentId]: params.preferredModel.model,
        }
      }
      const stored = await ctx.service.setPreferences(patch, ctx.actor.id)
      // The same shape `preferences.get` answers, so a caller that just wrote a binding
      // learns whether it settled from the write itself rather than a second round trip.
      return {
        ...stored,
        startedSessions: ctx.service.startedSessions(Object.keys(stored.agentBySession ?? {})),
      }
    },
  })

  // ------------------------------------------------------------- native UI ----

  add({
    id: 'agents.launch_command',
    summary: 'Command that opens an agent\'s own interactive UI, optionally resuming a session.',
    params: s.objectOpt({ agentId: AgentParam }, {
      nativeSessionId: s.string().describeAs('Native session id to resume.'),
    }),
    scope: 'read',
    danger: 'safe',
    exposeAsTool: false,
    run: async (ctx, params) => {
      const adapter = ctx.service.registry.get(params.agentId)
      if (adapter === undefined) {
        throw new MutiAgentError(ErrorCodes.harnessServiceMissing, `agent "${params.agentId}" is not available`, {
          details: { agentId: params.agentId },
        })
      }
      return {
        argv: adapter.nativeLaunchCommand(
          params.nativeSessionId === undefined ? undefined : (params.nativeSessionId as never),
        ),
        note: 'MutiAgent launches an agent\'s own UI rather than driving it, because a TUI is not an API.',
      }
    },
  })

  add({
    id: 'mcp.config',
    summary: 'Ready-to-paste MCP client configuration for each integrated agent.',
    params: NoParams,
    scope: 'read',
    danger: 'safe',
    exposeAsTool: false,
    run: async () => buildMcpConfig(context),
  })

  return operations
}

/** Confirmation is an envelope flag; declare it once so the surfaces reject it as a field. */
void ConfirmField

/**
 * Project validated wire todos onto canonical items, branding ids and normalizing the
 * status vocabulary. Done explicitly rather than by a structural cast so an unknown
 * status cannot reach the board as a branded value.
 *
 * @param todos - Validated items from the request.
 * @returns Canonical items.
 */
function toCanonicalTodos(todos: readonly {
  id: string
  content: string
  status: string
  owner: string
  updatedAt: string
  blockedBy?: readonly string[]
  observedIn?: string
  nativeKey?: string
}[]): readonly AgentTodo[] {
  return todos.map(todo => ({
    id: brandTodoId(todo.id),
    content: todo.content,
    status: normalizeTodoStatus(todo.status),
    owner: todo.owner as AgentTodo['owner'],
    blockedBy: (todo.blockedBy ?? []).map(brandTodoId),
    updatedAt: todo.updatedAt,
    ...(todo.observedIn === undefined
      ? {}
      : { observedIn: todo.observedIn as NonNullable<AgentTodo['observedIn']> }),
    ...(todo.nativeKey === undefined ? {} : { nativeKey: todo.nativeKey }),
  }))
}

function normalizeTodoStatus(status: string): TodoStatus {
  switch (status) {
    case 'in_progress':
    case 'completed':
    case 'blocked':
    case 'cancelled':
      return status
    default:
      return 'pending'
  }
}

function isLive(record: RunRecord): boolean {
  return record.status === 'running' || record.status === 'preparing'
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() })
}

function buildMcpConfig(context: RegistrationContext): McpConfigReport {
  const entry = context.mcpEntry ?? '<muti-agent-plugin>/lib/mcp-stdio.js'
  const stdio = { command: 'node', args: [entry], env: {} as Record<string, string> }
  const forAgents: McpConfigReport['forAgents'][number][] = [
    {
      agentId: 'codex',
      location: 'config.toml',
      snippet: `[mcp_servers.mutiagent]\ncommand = "node"\nargs = ["${entry}"]\n`,
    },
    {
      agentId: 'grok',
      location: '~/.grok/config.toml',
      snippet: `[mcp_servers.mutiagent]\ncommand = "node"\nargs = ["${entry}"]\n`,
    },
    {
      agentId: 'pi',
      location: '~/.pi/agent/mcp.json',
      snippet: JSON.stringify(
        { mcpServers: { mutiagent: { command: 'node', args: [entry], exposure: 'deferred' } } },
        null,
        2,
      ),
    },
  ]
  const report: McpConfigReport = { stdio, forAgents }
  if (context.mcpHttpUrl !== undefined) report.http = { url: context.mcpHttpUrl }
  return report
}

/** Re-export the worktree type for the surfaces that echo it. */
export type { MeshWorkspace }
