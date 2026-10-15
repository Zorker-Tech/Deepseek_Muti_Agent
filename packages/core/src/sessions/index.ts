/**
 * The cross-agent session index. It links to foreign sessions rather than copying
 * them (ADR-0012): each record stores the canonical projection, the native path and
 * a fingerprint, and the authoritative transcript stays where its agent wrote it.
 *
 * The index also decides what "imported" means: a session becomes *tracked* when the
 * user (or an agent) asks for it, and only tracked sessions appear by default in the
 * sidebar. Tracking writes nothing outside MutiAgent's own state directory.
 *
 * @module @zorker/muti-agent-core/sessions/index
 */

import {
  ErrorCodes,
  MutiAgentError,
  sessionKey as makeSessionKey,
  type AgentSession,
  type AgentSessionPartition,
  type AgentTranscript,
  type ProjectionNote,
} from '@zorker/muti-agent-contracts'
import type { Logger } from '../adapter/types.ts'
import type { AgentRegistry } from '../adapter/registry.ts'
import type { StateStore } from '../state/store.ts'

/** A cached scan result for one agent. */
interface AgentIndexCache {
  agentId: string
  scannedAt: string
  /** Sessions keyed by native id, so a re-scan merges instead of replacing. */
  sessions: Record<string, AgentSession>
}

/** One tracked session's bookkeeping. */
export interface TrackedSession {
  /** Canonical session key. */
  key: string
  /** Agent that owns the session. */
  agentId: string
  /** ISO 8601 time tracking started. */
  trackedAt: string
  /** Who or what started tracking, for the audit journal. */
  trackedBy: string
  /** Optional user-supplied note. */
  note?: string
}

/** Persisted tracking document. */
interface TrackingDocument {
  version: 1
  tracked: Record<string, TrackedSession>
}

const TRACKING_PATH = 'sessions/tracked.json'

/** How a session listing should be filtered and ordered. */
export interface SessionQuery {
  agentIds?: readonly string[]
  cwd?: string
  repoRoot?: string
  query?: string
  includeUntracked?: boolean
  onlyTracked?: boolean
  sort?: 'updated' | 'created' | 'title'
  limit?: number
}

/** Result of a refresh, reported so a caller can tell "nothing found" from "could not look". */
export interface RefreshOutcome {
  agentId: string
  ok: boolean
  found: number
  added: number
  removed: number
  /** Undefined when `ok` is true. */
  error?: string
  durationMs: number
}

/** Summary of the whole index, for the panel header. */
export interface IndexSummary {
  agents: readonly {
    agentId: string
    displayName: string
    installed: boolean
    total: number
    tracked: number
    lastScan?: string
    error?: string
  }[]
  totalTracked: number
  lastRefresh?: string
}

/**
 * The session index and its freshness policy. A scan is incremental in intent: an
 * agent's own store is enumerated on every refresh (there is no portable
 * change-notification), but only metadata is read, and a session whose fingerprint is
 * unchanged keeps its cached projection.
 */
export class SessionIndex {
  private readonly cache = new Map<string, AgentIndexCache>()
  private lastRefresh: string | undefined

  /**
   * @param registry - Adapter registry to enumerate agents from.
   * @param state - MutiAgent's state store.
   * @param log - Logger.
   */
  constructor(
    private readonly registry: AgentRegistry,
    private readonly state: StateStore,
    private readonly log: Logger,
  ) {}

  /** Load cached scans from disk. Called once at activation; the UI works immediately after. */
  async load(): Promise<void> {
    for (const agentId of this.registry.ids()) {
      const cached = await this.state.readJson<AgentIndexCache>(`index/${agentId}.json`)
      if (cached !== undefined && cached.sessions !== undefined) {
        this.cache.set(agentId, cached)
      }
    }
  }

  /**
   * Enumerate one agent's sessions and merge them into the cache.
   *
   * @param agentId - Agent to scan.
   * @param options - Scan limits and a cancellation signal.
   * @returns What the scan found, including a per-agent failure instead of a throw.
   */
  async refresh(agentId: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<RefreshOutcome> {
    const startedAt = Date.now()
    const adapter = this.registry.get(agentId)
    const previous = this.cache.get(agentId)
    if (adapter === undefined) {
      return {
        agentId,
        ok: false,
        found: 0,
        added: 0,
        removed: 0,
        error: `agent "${agentId}" is not registered`,
        durationMs: Date.now() - startedAt,
      }
    }
    try {
      const sessions = await adapter.listSessions({
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const merged: Record<string, AgentSession> = {}
      let added = 0
      for (const session of sessions) {
        const nativeId = String(session.nativeId)
        const before = previous?.sessions[nativeId]
        merged[nativeId] = mergeSession(before, session)
        if (before === undefined) added += 1
      }
      // A session absent from this scan is not deleted from the index: a store that
      // is temporarily unreadable must not erase a user's tracked list. It is
      // marked missing instead, and pruned only when a listing asks for it.
      let removed = 0
      for (const [nativeId, before] of Object.entries(previous?.sessions ?? {})) {
        if (nativeId in merged) continue
        merged[nativeId] = { ...before, status: 'missing' }
        removed += 1
      }
      const cache: AgentIndexCache = { agentId, scannedAt: new Date().toISOString(), sessions: merged }
      this.cache.set(agentId, cache)
      await this.state.writeJson(`index/${agentId}.json`, cache)
      this.lastRefresh = cache.scannedAt
      return { agentId, ok: true, found: sessions.length, added, removed, durationMs: Date.now() - startedAt }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.log.warn(`session scan for ${agentId} failed`, { error: message })
      return {
        agentId,
        ok: false,
        found: 0,
        added: 0,
        removed: 0,
        error: message,
        durationMs: Date.now() - startedAt,
      }
    }
  }

  /**
   * Refresh every registered agent.
   *
   * @param options - Scan limits and a cancellation signal.
   * @returns One outcome per agent, including failures.
   */
  async refreshAll(options: { limit?: number; signal?: AbortSignal } = {}): Promise<readonly RefreshOutcome[]> {
    const outcomes: RefreshOutcome[] = []
    for (const agentId of this.registry.ids()) {
      if (options.signal?.aborted === true) break
      // Sequential on purpose: these scans read the disk and must not stampede a
      // machine that is already running agents.
      outcomes.push(await this.refresh(agentId, options))
    }
    return outcomes
  }

  /** Every indexed session, tracked or not, newest first. */
  all(): readonly AgentSession[] {
    const out: AgentSession[] = []
    for (const cache of this.cache.values()) {
      for (const session of Object.values(cache.sessions)) out.push(session)
    }
    out.sort((a, b) => timestampOf(b) - timestampOf(a))
    return out
  }

  /**
   * Query the index.
   *
   * @param query - Filters, ordering and limit.
   * @returns Matching sessions, plus the tracked set applied when requested.
   */
  async list(query: SessionQuery = {}): Promise<readonly AgentSession[]> {
    const tracking = await this.tracking()
    const trackedKeys = Object.keys(tracking.tracked)
    const onlyTracked = query.onlyTracked ?? query.includeUntracked !== true
    let sessions = this.all()

    if (query.agentIds !== undefined && query.agentIds.length > 0) {
      const allowed = new Set(query.agentIds)
      sessions = sessions.filter(session => allowed.has(String(session.agentId)))
    }
    if (onlyTracked) sessions = sessions.filter(session => trackedKeys.includes(String(session.key)))
    if (query.cwd !== undefined) sessions = sessions.filter(session => session.cwd === query.cwd)
    if (query.repoRoot !== undefined) sessions = sessions.filter(session => session.repoRoot === query.repoRoot)
    if (query.query !== undefined && query.query.trim() !== '') {
      const needle = query.query.trim().toLowerCase()
      sessions = sessions.filter(session => searchableText(session).includes(needle))
    }

    const sort = query.sort ?? 'updated'
    sessions = [...sessions].sort((a, b) => {
      if (sort === 'title') return (a.title ?? '').localeCompare(b.title ?? '')
      if (sort === 'created') return timestampOf(b, 'createdAt') - timestampOf(a, 'createdAt')
      return timestampOf(b) - timestampOf(a)
    })
    if (query.limit !== undefined) sessions = sessions.slice(0, query.limit)
    return sessions
  }

  /**
   * Build the per-agent partitions the sidebar renders: one bucket per registered
   * agent, always present even when empty, so the UI never has to infer a partition
   * from an empty list (ADR-0007).
   *
   * @param query - Filters applied inside every partition.
   * @returns Partitions in registry order, each with its own session list and counts.
   */
  async partitions(query: SessionQuery = {}): Promise<readonly AgentSessionPartition[]> {
    const tracking = await this.tracking()
    const trackedKeys = new Set(Object.keys(tracking.tracked))
    const descriptors = new Map(
      (await this.registry.describe()).map(entry => [String(entry.descriptor.id), entry.descriptor]),
    )
    // `limit` caps the rows a partition displays, never the population its counts are
    // derived from: a truncated cross-agent list would make every agent's session count
    // and untracked count depend on how many rows the caller asked to see.
    const { limit, ...filters } = query
    const all = await this.list({ ...filters, onlyTracked: false })
    const partitions: AgentSessionPartition[] = []

    for (const agentId of this.registry.ids()) {
      const descriptor = descriptors.get(agentId)
      const own = all.filter(session => String(session.agentId) === agentId)
      const includeUntracked = query.includeUntracked ?? false
      const visible = includeUntracked ? own : own.filter(session => trackedKeys.has(String(session.key)))
      const capped = limit === undefined ? visible : visible.slice(0, limit)
      const cache = this.cache.get(agentId)
      const partition: AgentSessionPartition = {
        agentId: agentId as AgentSessionPartition['agentId'],
        displayName: descriptor?.displayName ?? agentId,
        installed: descriptor?.detection.installed ?? false,
        sessions: capped,
        untrackedCount: own.filter(session => !trackedKeys.has(String(session.key))).length,
      }
      const note = partitionNote(descriptor?.detection, own.length, cache?.scannedAt)
      if (note !== undefined) partition.note = note
      partitions.push(partition)
    }
    return partitions
  }

  /**
   * Read a bounded transcript window for one session.
   *
   * @param key - Canonical session key.
   * @param options - Window limits.
   * @returns The transcript, with the adapter's declared projection notes.
   * @throws {MutiAgentError} `session/not-found` when the key or its session is unknown.
   */
  async transcript(
    key: string,
    options: { maxMessages?: number; maxBytes?: number } = {},
  ): Promise<AgentTranscript> {
    const session = await this.find(key)
    if (session === undefined) {
      throw new MutiAgentError(ErrorCodes.sessionNotFound, `no indexed session with key ${key}`, {
        details: { key },
        remediation: 'Refresh the session index, then retry.',
      })
    }
    const adapter = this.registry.get(String(session.agentId))
    if (adapter === undefined) {
      throw new MutiAgentError(
        ErrorCodes.harnessServiceMissing,
        `agent "${String(session.agentId)}" is not available in this process`,
        { details: { key } },
      )
    }
    const read = await adapter.readTranscript(session.nativeId, options)
    return {
      key: session.key,
      messages: read.messages,
      ...(read.totalMessages === undefined ? {} : { totalMessages: read.totalMessages }),
      hasMore: read.hasMore,
      notes: read.notes,
    }
  }

  /**
   * Read the agent's own todo/plan state for a session.
   *
   * @param key - Canonical session key.
   * @returns The observed state, or `undefined` when the agent records none.
   */
  async nativeTasks(key: string): Promise<
    | {
        todos: readonly { id: string; content: string; status: string; nativeKey?: string }[]
        plan?: { active: boolean; items: readonly string[] }
        notes: readonly ProjectionNote[]
      }
    | undefined
  > {
    const session = await this.find(key)
    if (session === undefined) return undefined
    const adapter = this.registry.get(String(session.agentId))
    if (adapter === undefined) return undefined
    const state = await adapter.readNativeTasks(session.nativeId)
    if (state === undefined) return undefined
    return {
      todos: state.todos.map(todo => ({
        id: String(todo.id),
        content: todo.content,
        status: todo.status,
        ...(todo.nativeKey === undefined ? {} : { nativeKey: todo.nativeKey }),
      })),
      ...(state.plan === undefined ? {} : { plan: state.plan }),
      notes: state.notes,
    }
  }

  /** Find one indexed session by canonical key. */
  async find(key: string): Promise<AgentSession | undefined> {
    const at = key.indexOf(':')
    if (at <= 0) return undefined
    const agentId = key.slice(0, at)
    const nativeId = key.slice(at + 1)
    return this.cache.get(agentId)?.sessions[nativeId]
  }

  /** Mark a session as tracked ("imported"). */
  async track(key: string, actor = 'user', note?: string): Promise<TrackedSession> {
    const session = await this.find(key)
    if (session === undefined) {
      throw new MutiAgentError(ErrorCodes.sessionNotFound, `cannot track unknown session ${key}`, {
        details: { key },
        remediation: 'Refresh the session index first so the session is discoverable.',
      })
    }
    const entry: TrackedSession = {
      key,
      agentId: String(session.agentId),
      trackedAt: new Date().toISOString(),
      trackedBy: actor,
      ...(note === undefined ? {} : { note }),
    }
    const document = await this.state.updateJson<TrackingDocument>(TRACKING_PATH, { version: 1, tracked: {} }, current => ({
      version: 1,
      tracked: { ...current.tracked, [key]: entry },
    }))
    this.state.appendJournal({ at: entry.trackedAt, kind: 'session.tracked', id: key, actor })
    return document.tracked[key] ?? entry
  }

  /** Stop tracking a session. Returns whether it was tracked. */
  async untrack(key: string, actor = 'user'): Promise<boolean> {
    let existed = false
    await this.state.updateJson<TrackingDocument>(TRACKING_PATH, { version: 1, tracked: {} }, current => {
      if (!(key in current.tracked)) return current
      existed = true
      const next = { ...current.tracked }
      delete next[key]
      return { version: 1, tracked: next }
    })
    if (existed) {
      this.state.appendJournal({ at: new Date().toISOString(), kind: 'session.untracked', id: key, actor })
    }
    return existed
  }

  /** Every tracked session record. */
  async tracking(): Promise<TrackingDocument> {
    return (await this.state.readJson<TrackingDocument>(TRACKING_PATH)) ?? { version: 1, tracked: {} }
  }

  /** Index summary for the panel header and the catalog operation. */
  async summary(): Promise<IndexSummary> {
    const tracking = await this.tracking()
    const descriptors = await this.registry.describe()
    const lastScanByAgent = new Map(
      [...this.cache.entries()].map(([agentId, cache]) => [agentId, cache.scannedAt] as const),
    )
    const agents = descriptors.map(entry => {
      const agentId = String(entry.descriptor.id)
      const total = Object.keys(this.cache.get(agentId)?.sessions ?? {}).length
      const tracked = Object.values(tracking.tracked).filter(item => item.agentId === agentId).length
      const summary: IndexSummary['agents'][number] = {
        agentId,
        displayName: entry.descriptor.displayName,
        installed: entry.descriptor.detection.installed,
        total,
        tracked,
      }
      const lastScan = lastScanByAgent.get(agentId)
      if (lastScan !== undefined) summary.lastScan = lastScan
      if (!entry.descriptor.detection.installed && entry.descriptor.detection.reason !== undefined) {
        summary.error = entry.descriptor.detection.reason
      }
      return summary
    })
    return {
      agents,
      totalTracked: Object.keys(tracking.tracked).length,
      ...(this.lastRefresh === undefined ? {} : { lastRefresh: this.lastRefresh }),
    }
  }

  /** Drop cached data for an agent, forcing a full re-read on the next refresh. */
  async invalidate(agentId?: string): Promise<void> {
    if (agentId === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(agentId)
  }
}

/**
 * Merge a fresh projection over a cached one.
 *
 * User-visible stability matters more than freshness for identity fields: a title
 * that the agent regenerates must not flicker in the sidebar, so a native title
 * wins only when the cache has none or the agent marked it manual.
 */
function mergeSession(before: AgentSession | undefined, after: AgentSession): AgentSession {
  if (before === undefined) return after
  const keepTitle = before.title !== undefined && (after.titleIsNative !== true || before.titleIsNative === true)
  return {
    ...after,
    ...(keepTitle && before.title !== undefined && after.title !== undefined ? { title: before.title } : {}),
    binding: before.binding,
  }
}

function timestampOf(session: AgentSession, field: 'updatedAt' | 'createdAt' = 'updatedAt'): number {
  const value = field === 'createdAt' ? session.createdAt : session.updatedAt
  if (value === undefined) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function searchableText(session: AgentSession): string {
  return [session.title, session.cwd, String(session.nativeId), session.model, session.branch]
    .filter((part): part is string => part !== undefined)
    .join(' ')
    .toLowerCase()
}

function partitionNote(
  detection: { installed: boolean; reason?: string } | undefined,
  total: number,
  lastScan: string | undefined,
): string | undefined {
  if (detection === undefined) return 'this agent is not registered in this process'
  if (!detection.installed) return detection.reason ?? 'the agent binary was not found'
  if (lastScan === undefined) return 'not scanned yet'
  if (total === 0) return 'no sessions found in this agent\'s store'
  return undefined
}

/** Re-export the key builder so callers do not import two modules for one concept. */
export { makeSessionKey }
