/**
 * Run dispatch and the mesh event bus. One place creates worktrees, injects shared
 * context, drives an adapter, fans run events out to every subscriber (SSE, tools,
 * the harness log), and persists a redacted record (ADR-0008, ADR-0009, ADR-0014).
 *
 * @module @zorker/muti-agent-core/orchestration/runs
 */

import {
  ErrorCodes,
  MutiAgentError,
  runId as brandRun,
  type AgentRunEvent,
  type InjectedContext,
  type MeshWorkspace,
  type RunRecord,
  type RunResult,
} from '@zorker/muti-agent-contracts'
import type { Logger } from '../adapter/types.ts'
import type { AgentRegistry } from '../adapter/registry.ts'
import type { Redactor } from '../log.ts'
import type { StateStore } from '../state/store.ts'
import type { WorktreeManager } from '../worktree/manager.ts'
import type { CollaborationStore } from './collaboration.ts'

/** A live run's in-memory state. */
interface LiveRun {
  record: RunRecord
  /** Aborts the adapter's process group and its event pump. */
  cancel: (reason?: string) => void
  /** Resolves when the run reached a terminal state. */
  settled: Promise<RunRecord>
}

/** An event delivered to subscribers, tagged with its run. */
export interface MeshEvent {
  kind: 'run-event' | 'run-record' | 'worktree-progress' | 'todos' | 'plan'
  at: string
  /** Run id for run-scoped events. */
  runId?: string
  /** Canonical event payload. */
  event?: AgentRunEvent
  /** Record snapshot for `run-record`. */
  record?: RunRecord
  /** Worktree snapshot for `worktree-progress`. */
  worktree?: MeshWorkspace
  /** Collaboration id for board-scoped events. */
  collaborationId?: string
  /** Rendered context block, for `plan` events. */
  context?: InjectedContext
}

/** A subscriber: receives every mesh event until it unsubscribes. */
export type MeshSubscriber = (event: MeshEvent) => void

/** Parameters for {@link RunManager.dispatch}. */
export interface DispatchParams {
  agentId: string
  prompt: string
  cwd?: string
  collaborationId?: string
  taskId?: string
  isolation?: 'worktree' | 'shared-cwd'
  resumeNativeId?: string
  model?: string
  sandbox?: string
  approval?: string
  timeoutMs?: number
  env?: Readonly<Record<string, string>>
  requestedBy?: string
  /** Whether to wait for the terminal result before returning. */
  wait?: boolean
}

/** Result of a dispatch: the record as it stands plus the live handle. */
export interface DispatchResult {
  record: RunRecord
  /** Resolves when the run reaches a terminal state. */
  settled: Promise<RunRecord>
  /** Abort the run. */
  cancel: (reason?: string) => void
}

/** Concurrency and retention settings. */
export interface RunManagerOptions {
  /** Maximum simultaneous runs. Excess dispatches queue rather than fail. */
  maxParallel: number
  /** How many finished run records to keep on disk. */
  historyLimit: number
  /** Whether a run's context block is injected. */
  shareContext: boolean
}

/** How many live events a slow subscriber may fall behind before being dropped. */
const SUBSCRIBER_QUEUE_LIMIT = 512

/**
 * Dispatches runs and broadcasts their events.
 *
 * A run is always resolved through the registry, so a caller names an agent id and
 * never a concrete adapter. Isolation is decided here and nowhere else, which is what
 * makes the isolation guarantee uniform across agents (ADR-0008).
 */
export class RunManager {
  private readonly live = new Map<string, LiveRun>()
  private readonly subscribers = new Set<{
    push: MeshSubscriber
    queue: MeshEvent[]
    draining: boolean
  }>()
  private readonly settled: RunRecord[] = []
  private readonly queue: (() => void)[] = []

  /**
   * @param registry - Adapter registry.
   * @param worktrees - Worktree manager, or `undefined` when isolation is disabled.
   * @param collaborations - Collaboration store for shared context and records.
   * @param state - MutiAgent's state store.
   * @param options - Concurrency and retention settings.
   * @param log - Logger.
   * @param redactor - Applied to prompts, argv and outputs before they are persisted.
   */
  constructor(
    private readonly registry: AgentRegistry,
    private readonly worktrees: WorktreeManager | undefined,
    private readonly collaborations: CollaborationStore,
    private readonly state: StateStore,
    private readonly options: RunManagerOptions,
    private readonly log: Logger,
    private readonly redactor: Redactor,
  ) {}

  /** Register a subscriber and receive its unsubscribe function. */
  subscribe(push: MeshSubscriber): () => void {
    const entry = { push, queue: [] as MeshEvent[], draining: false }
    this.subscribers.add(entry)
    return () => { this.subscribers.delete(entry) }
  }

  /** Every live run's record. */
  active(): readonly RunRecord[] {
    return [...this.live.values()].map(entry => entry.record)
  }

  /**
   * Recent finished runs, newest first.
   *
   * @param limit - Maximum records to return.
   */
  async history(limit = 50): Promise<readonly RunRecord[]> {
    const persisted = await this.state.readJson<RunRecord[]>('runs/history.json')
    const all = [...this.active(), ...(persisted ?? []), ...this.settled]
    const seen = new Set<string>()
    const out: RunRecord[] = []
    for (const record of all) {
      const key = String(record.id)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(record)
      if (out.length >= limit) break
    }
    return out
  }

  /** One run by id, live or historical. */
  async get(id: string): Promise<RunRecord | undefined> {
    const live = this.live.get(id)
    if (live !== undefined) return live.record
    const history = await this.history(500)
    return history.find(record => String(record.id) === id)
  }

  /**
   * Dispatch a run.
   *
   * Isolation, context injection and worktree allocation all happen before the
   * adapter is called, so an adapter never has to know about collaboration.
   *
   * @param params - Target agent, prompt, working directory and options.
   * @returns The initial record, its settlement promise, and a cancel function.
   * @throws {MutiAgentError} when the agent is unknown, isolation cannot be satisfied,
   *   or the adapter cannot start the process.
   */
  async dispatch(params: DispatchParams): Promise<DispatchResult> {
    const adapter = this.registry.get(params.agentId)
    if (adapter === undefined) {
      throw new MutiAgentError(
        ErrorCodes.harnessServiceMissing,
        `agent "${params.agentId}" is not available in this process`,
        {
          details: { agentId: params.agentId, registered: this.registry.ids().join(',') },
          remediation: 'Check the agent is installed and enabled in plugin settings.',
        },
      )
    }

    const requestedCwd = params.cwd ?? process.cwd()
    const isolation = params.isolation ?? (this.worktrees !== undefined ? 'worktree' : 'shared-cwd')
    let cwd = requestedCwd
    let worktreeId: string | undefined

    if (isolation === 'worktree') {
      if (this.worktrees === undefined) {
        throw new MutiAgentError(
          ErrorCodes.worktreeGitUnavailable,
          'worktree isolation is not available because the worktree manager is disabled',
          { remediation: 'Enable worktree isolation in settings, or dispatch with isolation=shared-cwd.' },
        )
      }
      const worktree = await this.worktrees.allocate({
        agentId: params.agentId,
        repoRoot: requestedCwd,
        ...(params.collaborationId === undefined ? {} : { collaborationId: params.collaborationId }),
        label: params.taskId ?? params.agentId,
        reuse: true,
      })
      cwd = worktree.path
      worktreeId = String(worktree.id)
    }

    const id = brandRun(`run-${randomToken()}`)
    const context: InjectedContext[] = []
    if (this.options.shareContext && params.collaborationId !== undefined) {
      const block = await this.collaborations.contextBlock(params.collaborationId, params.agentId)
      if (block !== undefined) context.push(block)
    }
    const prompt = this.redactor.apply(renderPrompt(params.prompt, context))

    const argv: readonly string[] = adapter.nativeLaunchCommand().slice(0, 1)
    const record: RunRecord = {
      id,
      agentId: params.agentId as RunRecord['agentId'],
      isolation,
      cwd,
      argv,
      environmentKeys: [],
      context: context.map(item => ({ kind: item.kind, hash: item.hash, text: item.text })),
      prompt,
      status: 'preparing',
      startedAt: new Date().toISOString(),
      counters: { events: 0, toolCalls: 0, filesChanged: 0 },
      ...(params.collaborationId === undefined
        ? {}
        : { collaborationId: params.collaborationId as NonNullable<RunRecord['collaborationId']> }),
      ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
      ...(worktreeId === undefined ? {} : { worktreeId: worktreeId as NonNullable<RunRecord['worktreeId']> }),
    }

    await this.acquireSlot()
    if (worktreeId !== undefined && this.worktrees !== undefined) {
      await this.worktrees.bindRun(worktreeId, String(id))
    }

    let run: Awaited<ReturnType<typeof adapter.run>>
    try {
      run = await adapter.run({
        runId: String(id),
        cwd,
        prompt,
        isolation,
        ...(params.resumeNativeId === undefined ? {} : { resumeNativeId: params.resumeNativeId }),
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.sandbox === undefined ? {} : { sandbox: params.sandbox }),
        ...(params.approval === undefined ? {} : { approval: params.approval }),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(params.env === undefined ? {} : { env: params.env }),
      })
    } catch (cause) {
      this.releaseSlot()
      if (worktreeId !== undefined && this.worktrees !== undefined) {
        await this.worktrees.bindRun(worktreeId, undefined)
      }
      throw cause
    }

    const running: RunRecord = {
      ...record,
      argv: run.argv,
      environmentKeys: run.environmentKeys,
      status: 'running',
    }
    this.publish({ kind: 'run-record', at: new Date().toISOString(), runId: String(id), record: running })

    const settled = this.pump(id, running, run)
    const liveRun: LiveRun = {
      record: running,
      cancel: reason => { run.cancel(reason) },
      settled,
    }
    this.live.set(String(id), liveRun)
    if (params.wait === true) await settled
    return {
      record: running,
      settled,
      cancel: liveRun.cancel,
    }
  }

  /**
   * Cancel a live run.
   *
   * @param id - Run id.
   * @param reason - Recorded on the terminal event.
   * @returns Whether a live run was found and signalled.
   */
  cancel(id: string, reason = 'cancelled by request'): boolean {
    const live = this.live.get(id)
    if (live === undefined) return false
    live.cancel(reason)
    return true
  }

  /**
   * Wait for every live run to settle.
   *
   * @param timeoutMs - Optional bound; timed-out runs are simply not awaited further.
   */
  async drain(timeoutMs?: number): Promise<void> {
    const pending = [...this.live.values()].map(entry => entry.settled)
    if (pending.length === 0) return
    if (timeoutMs === undefined) {
      await Promise.allSettled(pending)
      return
    }
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>(resolve => { setTimeout(resolve, timeoutMs).unref?.() }),
    ])
  }

  /** Consume an adapter run, publish events, and persist the terminal record. */
  private async pump(
    id: RunRecord['id'],
    initial: RunRecord,
    run: Awaited<ReturnType<import('../adapter/types.ts').AgentAdapter['run']>>,
  ): Promise<RunRecord> {
    let record = initial
    let result: RunResult | undefined
    try {
      for await (const event of run.events) {
        record = applyEvent(record, event)
        this.publish({
          kind: 'run-event',
          at: event.at,
          runId: String(id),
          event: this.redactor.applyDeep(event),
          record,
        })
        if (event.kind === 'run.finished') result = event.result
      }
    } catch (cause) {
      // The adapter contract says the stream ends with a terminal event; reaching
      // here means it did not, which must still produce a usable record.
      this.log.warn(`run ${String(id)} stream ended without a terminal event`, {
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }

    if (result === undefined) {
      try {
        result = await run.result
      } catch {
        result = undefined
      }
    }

    const finishedAt = result?.finishedAt ?? new Date().toISOString()
    const finalStatus: RunRecord['status'] = result?.error === undefined
      ? result === undefined ? 'failed' : 'succeeded'
      : statusFromErrorCode(result.error.code)
    const finished: RunRecord = {
      ...record,
      status: finalStatus,
      finishedAt,
      ...(result?.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result?.error === undefined
        ? {}
        : {
            error: {
              code: result.error.code,
              message: result.error.message,
              ...(result.error.output === undefined ? {} : { output: result.error.output }),
            },
          }),
    }
    this.live.delete(String(id))
    this.releaseSlot()
    this.settled.unshift(finished)
    if (this.settled.length > this.options.historyLimit) this.settled.length = this.options.historyLimit

    await this.persist(finished)
    if (finished.worktreeId !== undefined && this.worktrees !== undefined) {
      await this.worktrees.bindRun(String(finished.worktreeId), undefined)
      const sample = await this.worktrees.sample(String(finished.worktreeId), false)
      const worktree = await this.worktrees.get(String(finished.worktreeId))
      if (worktree !== undefined) {
        this.publish({
          kind: 'worktree-progress',
          at: finishedAt,
          worktree,
          ...(sample === undefined ? {} : {}),
        })
      }
    }
    if (finished.collaborationId !== undefined) {
      await this.collaborations.recordRun(String(finished.collaborationId), finished)
      this.publish({
        kind: 'run-record',
        at: finishedAt,
        runId: String(id),
        record: finished,
        collaborationId: String(finished.collaborationId),
      })
    }
    this.state.appendJournal({
      at: finishedAt,
      kind: 'run.finished',
      id: String(id),
      actor: 'orchestrator',
      detail: { agent: String(finished.agentId), status: finished.status, exitCode: finished.exitCode ?? -1 },
    })
    return finished
  }

  /** Persist the finished record, keeping bounded history. */
  private async persist(record: RunRecord): Promise<void> {
    await this.state.writeJson(`runs/${String(record.id)}.json`, record)
    const history = await this.state.readJson<RunRecord[]>('runs/history.json')
    const next = [record, ...(history ?? []).filter(item => String(item.id) !== String(record.id))]
    await this.state.writeJson('runs/history.json', next.slice(0, this.options.historyLimit))
  }

  /** Broadcast to subscribers, dropping events for a subscriber that cannot keep up. */
  private publish(event: MeshEvent): void {
    for (const entry of this.subscribers) {
      if (entry.queue.length >= SUBSCRIBER_QUEUE_LIMIT) {
        // A stalled SSE client must not grow the host's memory; the client re-reads
        // state on reconnect, so dropping is safe and is reported once per stream by
        // the gateway.
        entry.queue.splice(0, entry.queue.length)
      }
      entry.queue.push(event)
      if (entry.draining) continue
      entry.draining = true
      queueMicrotask(() => {
        entry.draining = false
        const batch = entry.queue.splice(0, entry.queue.length)
        for (const item of batch) {
          try {
            entry.push(item)
          } catch (cause) {
            this.log.warn('mesh subscriber threw', {
              error: cause instanceof Error ? cause.message : String(cause),
            })
            this.subscribers.delete(entry)
            break
          }
        }
      })
    }
  }

  /** Wait for a concurrency slot. */
  private async acquireSlot(): Promise<void> {
    if (this.live.size < this.options.maxParallel) return
    await new Promise<void>(resolve => { this.queue.push(resolve) })
  }

  /** Release a slot and wake the next waiter. */
  private releaseSlot(): void {
    const next = this.queue.shift()
    if (next !== undefined) next()
  }
}

/** Fold one event into the run record, so a list view needs no event replay. */
function applyEvent(record: RunRecord, event: AgentRunEvent): RunRecord {
  const counters = { ...record.counters, events: record.counters.events + 1 }
  if (event.kind === 'tool.started') counters.toolCalls += 1
  if (event.kind === 'files.changed') counters.filesChanged += event.paths.length
  const next: RunRecord = { ...record, counters }
  if (event.kind === 'run.started' && event.nativeSessionId !== undefined) {
    return { ...next, nativeSessionId: String(event.nativeSessionId) }
  }
  if (event.kind === 'session.bound') return { ...next, nativeSessionId: String(event.nativeSessionId) }
  return next
}

/** Compose the prompt handed to an agent: injected context first, then the task. */
export function renderPrompt(prompt: string, context: readonly InjectedContext[]): string {
  if (context.length === 0) return prompt
  const blocks = context.map(item => item.text.trim()).filter(text => text !== '')
  if (blocks.length === 0) return prompt
  return `${blocks.join('\n\n')}\n\n---\n\n${prompt}`
}

function statusFromErrorCode(code: string): RunRecord['status'] {
  if (code === ErrorCodes.runCancelled) return 'cancelled'
  if (code === ErrorCodes.runTimeout) return 'timeout'
  return 'failed'
}

function randomToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
