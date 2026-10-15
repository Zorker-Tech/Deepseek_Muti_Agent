/**
 * Codex session discovery, transcript projection and native task extraction.
 *
 * Everything here is read-only against `$CODEX_HOME` (ADR-0012): rollouts are read
 * through {@link FileProbe} bounded reads, never written, and a file that cannot be
 * parsed becomes a declared gap (`status: 'unreadable'`, or a {@link ProjectionNote})
 * instead of an exception. Listing reads only the head of each rollout because the
 * store is append-only and the first line, `session_meta`, is authoritative.
 *
 * @module @zorker/muti-agent-adapter-codex/sessions
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  ErrorCodes,
  MutiAgentError,
  nativeSessionId,
  sessionKey as toSessionKey,
  todoId as toTodoId,
  type AgentId,
  type AgentMessage,
  type AgentSession,
  type AgentTodo,
  type NativeSessionId,
  type ProjectionNote,
  type TodoStatus,
} from '@zorker/muti-agent-contracts'
import {
  parseJsonLine,
  resolveHome,
  type FileProbe,
  type ListSessionsOptions,
  type Logger,
  type NativeTaskState,
  type ReadTranscriptOptions,
} from '@zorker/muti-agent-core'

/** Environment variable that relocates Codex's home directory. */
export const CODEX_HOME_ENV = 'CODEX_HOME'

/** Active rollout root, under `$CODEX_HOME`. */
export const CODEX_SESSIONS_DIR = 'sessions'

/** Archived rollout root, under `$CODEX_HOME`. */
export const CODEX_ARCHIVED_SESSIONS_DIR = 'archived_sessions'

/** Append-only thread-title index, under `$CODEX_HOME`. */
export const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

/** Credential file, under `$CODEX_HOME`; only its path is ever reported. */
export const CODEX_CREDENTIAL_FILE = 'auth.json'

/** Home directory used when `CODEX_HOME` is absent or unusable. */
export const CODEX_DEFAULT_HOME_DIR = '.codex'

/** Bytes read from a rollout head when listing sessions. */
export const SESSION_HEAD_BYTES = 64 * 1024

/** Bytes read from a rollout tail when projecting a transcript. */
export const DEFAULT_TRANSCRIPT_TAIL_BYTES = 1024 * 1024

/** Bytes read from a rollout tail when extracting native task state. */
export const DEFAULT_TASK_TAIL_BYTES = 1024 * 1024

/** Bytes read from `session_index.jsonl` when folding titles. */
const SESSION_INDEX_MAX_BYTES = 4 * 1024 * 1024

/** Directory levels visited below each session root. */
const ROLLOUT_MAX_DEPTH = 4

/** Rollout files collected per root, bounding a listing scan. */
const ROLLOUT_MAX_FILES = 5_000

/** Cap on any single text field copied into a canonical message. */
const MAX_MESSAGE_TEXT_BYTES = 16 * 1024

/** Native `plan_update` step statuses, mapped onto the canonical todo vocabulary. */
const PLAN_STATUS: Readonly<Record<string, TodoStatus>> = {
  pending: 'pending',
  inprogress: 'in_progress',
  completed: 'completed',
}

/** Resolved Codex home layout, shared by discovery and credential inspection. */
export interface CodexHome {
  /** Absolute `$CODEX_HOME` root. */
  readonly path: string
  /** Active rollout root. */
  readonly sessionsRoot: string
  /** Archived rollout root. */
  readonly archivedRoot: string
  /** Append-only title index. */
  readonly indexFile: string
  /** Credential file path. */
  readonly credentialFile: string
  /** Whether `$CODEX_HOME` supplied the path rather than the default. */
  readonly fromEnv: boolean
  /** Why a configured `CODEX_HOME` was rejected in favour of the default. */
  readonly fallbackReason?: string
}

/**
 * Resolve Codex's home directory.
 *
 * `$CODEX_HOME` is used only when it names a directory, which is what the CLI itself
 * does; a configured override is honoured verbatim because it is the operator's
 * explicit choice.
 *
 * @param files - Read-only filesystem helpers.
 * @param override - Configured `homeDir`, the highest-priority source.
 * @returns The resolved layout.
 */
export async function resolveCodexHome(files: FileProbe, override?: string): Promise<CodexHome> {
  const resolved = resolveHome({
    ...(override === undefined || override === '' ? {} : { override: files.resolvePath(override) }),
    envName: CODEX_HOME_ENV,
    defaultName: CODEX_DEFAULT_HOME_DIR,
  })
  let path = resolved.path
  let fromEnv = resolved.fromEnv
  let fallbackReason: string | undefined
  if (fromEnv && !(await files.isDirectory(path))) {
    path = join(homedir(), CODEX_DEFAULT_HOME_DIR)
    fromEnv = false
    fallbackReason = `${CODEX_HOME_ENV} is set to ${resolved.path}, which is not a directory; using ${path}`
  }
  // `resolveHome` joins an empty HOME into a relative path; the user's own home is the
  // only sane default when neither HOME nor USERPROFILE is set.
  if (!isAbsolute(path)) path = join(homedir(), CODEX_DEFAULT_HOME_DIR)
  return {
    path,
    sessionsRoot: join(path, CODEX_SESSIONS_DIR),
    archivedRoot: join(path, CODEX_ARCHIVED_SESSIONS_DIR),
    indexFile: join(path, CODEX_SESSION_INDEX_FILE),
    credentialFile: join(path, CODEX_CREDENTIAL_FILE),
    fromEnv,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  }
}

/** One rollout file found on disk. */
export interface RolloutFile {
  /** Absolute path. */
  readonly path: string
  /** File name, which encodes the creation timestamp and the thread id. */
  readonly name: string
  /** Modification time in milliseconds, the session's last-activity time. */
  readonly mtimeMs: number
  /** Size in bytes. */
  readonly size: number
  /** Found under `archived_sessions` rather than `sessions`. */
  readonly archived: boolean
  /** zstd-compressed in place; this adapter cannot decompress it. */
  readonly compressed: boolean
}

/**
 * Whether a directory entry names a rollout.
 *
 * @param name - File name.
 * @returns `true` for `rollout-*.jsonl` and its compressed `rollout-*.jsonl.zst` form.
 */
export function isRolloutFileName(name: string): boolean {
  return name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'))
}

/**
 * Thread id encoded in a rollout file name.
 *
 * A reverted thread's rollout appends `_<rolloutId>` after the stable thread id; only
 * the thread id is returned here.
 *
 * @param name - Rollout file name.
 * @returns The thread id, or `undefined` when the name does not match the convention.
 */
export function threadIdFromFileName(name: string): string | undefined {
  const base = name.endsWith('.zst') ? name.slice(0, -'.zst'.length) : name
  if (!base.startsWith('rollout-') || !base.endsWith('.jsonl')) return undefined
  const core = base.slice('rollout-'.length, -'.jsonl'.length)
  if (core.length <= 20 || core[19] !== '-') return undefined
  const id = core.slice(20).split('_')[0]
  return id === undefined || id === '' ? undefined : id
}

/**
 * Enumerate rollout files under both session roots, newest first.
 *
 * The walk is bounded in depth and file count so a pathological store cannot hang a
 * listing; a caller that needs fewer entries applies its own limit afterwards.
 *
 * @param files - Read-only filesystem helpers.
 * @param home - Resolved home layout.
 * @returns Rollout files, newest modification time first.
 */
export async function listRolloutFiles(files: FileProbe, home: CodexHome): Promise<readonly RolloutFile[]> {
  const roots: readonly { root: string; archived: boolean }[] = [
    { root: home.sessionsRoot, archived: false },
    { root: home.archivedRoot, archived: true },
  ]
  const out: RolloutFile[] = []
  for (const { root, archived } of roots) {
    const entries = await files.findFiles(root, isRolloutFileName, {
      maxDepth: ROLLOUT_MAX_DEPTH,
      maxFiles: ROLLOUT_MAX_FILES,
    })
    for (const entry of entries) {
      out.push({
        path: entry.path,
        name: entry.name,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        archived,
        compressed: entry.name.endsWith('.zst'),
      })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** Session-level metadata parsed from a rollout's first line. */
export interface CodexSessionMeta {
  /** Stable thread id. */
  readonly threadId: string
  /** Root thread id of the session this rollout belongs to. */
  readonly sessionId?: string
  /** Thread this session was forked from. */
  readonly forkedFromId?: string
  /** Parent thread, for a sub-agent rollout. */
  readonly parentThreadId?: string
  /** ISO 8601 creation time. */
  readonly timestamp?: string
  /** Working directory the session was created in. */
  readonly cwd?: string
  /** Codex entry point, verbatim (`cli`, `vscode`, `exec`, `mcp`, …). */
  readonly originator?: string
  /** CLI version that wrote the rollout. */
  readonly cliVersion?: string
  /** Native session source, rendered as one token. */
  readonly source?: string
  /** Native thread source classification, when recorded. */
  readonly threadSource?: string
  /** Nickname of a spawned sub-agent, when recorded. */
  readonly agentNickname?: string
  /** Role of a spawned sub-agent, when recorded. */
  readonly agentRole?: string
  /** Model provider recorded in the header. */
  readonly modelProvider?: string
  /** Git branch recorded in the header. */
  readonly gitBranch?: string
  /** Git commit recorded in the header. */
  readonly gitCommit?: string
  /** Sanitized git remote URL recorded in the header. */
  readonly gitOriginUrl?: string
  /** Model from the first `turn_context` line in the head read, when there was one. */
  readonly model?: string
}

/** Result of reading a rollout head. */
export type CodexHeadRead =
  | { readonly ok: true; readonly meta: CodexSessionMeta }
  | { readonly ok: false; readonly error: string }

/** A JSON object view of an unknown value, or `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A non-empty string field of a record. */
function str(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Render a native `SessionSource` as one token.
 *
 * The native enum is either a string or a single-key object (`{"sub_agent": …}`);
 * nested single-key objects are folded in so `sub_agent:thread_spawn` stays readable.
 *
 * @param value - The native source value.
 * @returns One token, or `undefined` when nothing usable is present.
 */
export function renderSessionSource(value: unknown): string | undefined {
  return renderSourceToken(value, 0)
}

function renderSourceToken(value: unknown, depth: number): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const record = asRecord(value)
  if (record === undefined || depth > 2) return undefined
  const parts: string[] = []
  for (const [key, child] of Object.entries(record)) {
    const nested = renderSourceToken(child, depth + 1)
    parts.push(nested === undefined ? key : `${key}:${nested}`)
  }
  return parts.length === 0 ? undefined : parts.join(',')
}

/** The `session_meta` fields, tolerating both the flattened and the `{meta}` envelope form. */
function sessionMetaFields(payload: unknown): Record<string, unknown> | undefined {
  const record = asRecord(payload)
  if (record === undefined) return undefined
  return asRecord(record.meta) ?? record
}

/**
 * Parse the authoritative metadata out of a rollout head.
 *
 * Lines are scanned in order: the first `session_meta` supplies identity and git
 * state, and the first `turn_context` supplies the model, which is the only cheap way
 * to learn a session's model without reading the rollout tail.
 *
 * @param text - Head text, decoded from the first {@link SESSION_HEAD_BYTES} bytes.
 * @param fallbackThreadId - Id derived from the file name, used when the header is unusable.
 * @returns The metadata, or why it could not be read.
 */
export function parseRolloutHead(text: string, fallbackThreadId: string): CodexHeadRead {
  let meta: Record<string, unknown> | undefined
  let git: Record<string, unknown> | undefined
  let model: string | undefined
  let parseErrors = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      parseErrors += 1
      continue
    }
    const record = asRecord(parsed.value)
    if (record === undefined) continue
    const type = str(record, 'type')
    if (type === 'session_meta' && meta === undefined) {
      meta = sessionMetaFields(record.payload)
      git = asRecord(meta?.git) ?? asRecord(asRecord(record.payload)?.git)
      continue
    }
    if (type === 'turn_context' && model === undefined) {
      model = str(asRecord(record.payload), 'model')
    }
    if (meta !== undefined && model !== undefined) break
  }
  if (meta === undefined) {
    return {
      ok: false,
      error:
        parseErrors > 0
          ? `no parsable session_meta line in the head read (${String(parseErrors)} unparsable line(s))`
          : 'no session_meta line in the head read',
    }
  }
  const source = renderSessionSource(meta.source)
  const sessionId = str(meta, 'session_id')
  const forkedFromId = str(meta, 'forked_from_id')
  const parentThreadId = str(meta, 'parent_thread_id')
  const timestamp = str(meta, 'timestamp')
  const cwd = str(meta, 'cwd')
  const originator = str(meta, 'originator')
  const cliVersion = str(meta, 'cli_version')
  const threadSource = str(meta, 'thread_source')
  const agentNickname = str(meta, 'agent_nickname')
  const agentRole = str(meta, 'agent_role')
  const modelProvider = str(meta, 'model_provider')
  const gitBranch = str(git, 'branch')
  const gitCommit = str(git, 'commit_hash')
  const gitOriginUrl = str(git, 'repository_url')
  return {
    ok: true,
    meta: {
      threadId: str(meta, 'id') ?? sessionId ?? fallbackThreadId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(forkedFromId === undefined ? {} : { forkedFromId }),
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(originator === undefined ? {} : { originator }),
      ...(cliVersion === undefined ? {} : { cliVersion }),
      ...(source === undefined ? {} : { source }),
      ...(threadSource === undefined ? {} : { threadSource }),
      ...(agentNickname === undefined ? {} : { agentNickname }),
      ...(agentRole === undefined ? {} : { agentRole }),
      ...(modelProvider === undefined ? {} : { modelProvider }),
      ...(gitBranch === undefined ? {} : { gitBranch }),
      ...(gitCommit === undefined ? {} : { gitCommit }),
      ...(gitOriginUrl === undefined ? {} : { gitOriginUrl }),
      ...(model === undefined ? {} : { model }),
    },
  }
}

/** One fold of the append-only title index. */
export interface CodexTitleEntry {
  /** Native thread name. */
  readonly title: string
  /** When the name was last set, as recorded by Codex. */
  readonly updatedAt?: string
}

/**
 * Apply one `session_index.jsonl` entry to a title map.
 *
 * The index is append-only and the newest entry for an id wins, so later lines
 * overwrite earlier ones; a line without a usable id or name is ignored.
 *
 * @param index - Map to update, keyed by thread id.
 * @param value - One parsed index line.
 */
export function applySessionIndexEntry(index: Map<string, CodexTitleEntry>, value: unknown): void {
  const record = asRecord(value)
  const id = str(record, 'id')
  const title = str(record, 'thread_name')
  if (id === undefined || title === undefined) return
  const updatedAt = str(record, 'updated_at')
  index.set(id, { title, ...(updatedAt === undefined ? {} : { updatedAt }) })
}

/**
 * Fold the append-only title index.
 *
 * @param files - Read-only filesystem helpers.
 * @param home - Resolved home layout.
 * @returns Titles by thread id, newest entry per id; empty when the index is absent.
 */
export async function readSessionIndex(
  files: FileProbe,
  home: CodexHome,
): Promise<ReadonlyMap<string, CodexTitleEntry>> {
  const index = new Map<string, CodexTitleEntry>()
  await files.readJsonLines(home.indexFile, value => { applySessionIndexEntry(index, value) }, {
    maxBytes: SESSION_INDEX_MAX_BYTES,
  })
  return index
}

/** Everything a session listing needs. */
export interface CodexSessionScan {
  /** Read-only filesystem helpers. */
  readonly files: FileProbe
  /** Structured logger; a bad session is reported here and never thrown. */
  readonly log: Logger
  /** Owning agent id, stamped on every session. */
  readonly agentId: AgentId
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Caller options: cwd filter, limit and abort signal. */
  readonly options: ListSessionsOptions
}

/**
 * Enumerate this machine's Codex sessions.
 *
 * Each rollout contributes one {@link AgentSession}: identity and git state from the
 * `session_meta` head line, the title from `session_index.jsonl`, and the file's
 * modification time as the last-activity time. A rollout that cannot be read comes
 * back as `status: 'unreadable'` with the reason in `notes`, so one damaged file never
 * costs the whole listing.
 *
 * @param scan - Filesystem helpers, home layout and caller options.
 * @returns Sessions, newest first, filtered by `cwd` and capped by `limit`.
 */
export async function listCodexSessions(scan: CodexSessionScan): Promise<readonly AgentSession[]> {
  const titles = await readSessionIndex(scan.files, scan.home)
  const rollouts = await listRolloutFiles(scan.files, scan.home)
  const cwdFilter = scan.options.cwd === undefined ? undefined : scan.files.resolvePath(scan.options.cwd)
  // A thread can briefly have both a plain and a compressed rollout, because Codex
  // compresses in place; one session per key wins, and a readable record beats an
  // unreadable one regardless of which file is newer.
  const byKey = new Map<string, AgentSession>()
  for (const rollout of rollouts) {
    if (scan.options.signal?.aborted === true) break
    if (scan.options.limit !== undefined && byKey.size >= scan.options.limit) break
    const session = await projectSession(scan, rollout, titles)
    if (cwdFilter !== undefined && session.cwd !== cwdFilter) continue
    const existing = byKey.get(session.key)
    if (existing !== undefined && !(existing.status === 'unreadable' && session.status !== 'unreadable')) continue
    byKey.set(session.key, session)
  }
  return [...byKey.values()]
}

/** Project one rollout file into a canonical session, never throwing. */
async function projectSession(
  scan: CodexSessionScan,
  rollout: RolloutFile,
  titles: ReadonlyMap<string, CodexTitleEntry>,
): Promise<AgentSession> {
  const fallbackId = threadIdFromFileName(rollout.name) ?? rollout.name
  if (rollout.compressed) {
    scan.log.warn('codex rollout is zstd-compressed and was listed as unreadable', { path: rollout.path })
    return unreadableSession(scan, rollout, fallbackId, [
      {
        field: '*',
        reason:
          'the rollout is zstd-compressed (rollout-*.jsonl.zst) and this adapter version does not decompress rollouts, so no metadata or transcript is available; open the session in Codex to materialise the plain rollout',
      },
    ])
  }
  const head = await scan.files.readHead(rollout.path, SESSION_HEAD_BYTES)
  if (head.missing) {
    scan.log.warn('codex rollout disappeared during the scan', { path: rollout.path })
    return unreadableSession(scan, rollout, fallbackId, [
      { field: '*', reason: 'the rollout file disappeared while the session list was being built' },
    ])
  }
  const parsed = parseRolloutHead(head.text, fallbackId)
  if (!parsed.ok) {
    scan.log.warn('codex rollout head is unusable', { path: rollout.path, error: parsed.error })
    return unreadableSession(scan, rollout, fallbackId, [
      { field: '*', reason: `the rollout head could not be parsed: ${parsed.error}` },
    ])
  }
  const meta = parsed.meta
  const title = titles.get(meta.threadId)
  const nativeId = nativeSessionId(meta.threadId)
  const notes: ProjectionNote[] = []
  if (title === undefined) {
    notes.push({
      field: 'title',
      reason: 'no entry for this thread in session_index.jsonl, and the first user message is not read during listing',
    })
  }
  notes.push({
    field: 'updatedAt',
    reason:
      title?.updatedAt === undefined
        ? 'the rollout file modification time stands in for the last activity time'
        : 'the session index timestamp is preferred over the rollout file modification time',
  })
  if (meta.model === undefined) {
    notes.push({ field: 'model', reason: 'no turn_context line appeared in the bounded head read' })
  }
  notes.push({ field: 'usage', reason: 'token usage lives in the rollout tail, which listing does not read' })
  notes.push({
    field: 'messageCount',
    reason: 'Codex records no message count for a rollout; counting would require a full read',
  })
  notes.push({
    field: 'repoRoot',
    reason: 'the repository root is not resolved during listing, which would cost one git spawn per session',
  })
  if (meta.timestamp === undefined) {
    notes.push({ field: 'createdAt', reason: 'the session header carries no timestamp' })
  }
  if (meta.cwd === undefined) {
    notes.push({ field: 'cwd', reason: 'the session header carries no working directory' })
  }
  if (meta.gitCommit !== undefined || meta.gitOriginUrl !== undefined) {
    notes.push({
      field: 'branch',
      reason: 'the session header also records a commit sha and a remote url, which the canonical session has no field for',
    })
  }
  const source = archiveAwareSource(meta.source, rollout.archived)
  if (source === undefined) {
    notes.push({ field: 'source', reason: 'the session header carries no session source' })
  } else if (rollout.archived) {
    notes.push({ field: 'source', reason: 'the rollout lives under archived_sessions rather than sessions' })
  }
  if (meta.forkedFromId !== undefined) {
    notes.push({ field: 'parentNativeId', reason: 'taken from the header field forked_from_id' })
  }
  const unprojected = [
    meta.sessionId === undefined || meta.sessionId === meta.threadId ? undefined : 'session_id',
    meta.originator === undefined ? undefined : 'originator',
    meta.cliVersion === undefined ? undefined : 'cli_version',
    meta.threadSource === undefined ? undefined : 'thread_source',
    meta.agentNickname === undefined ? undefined : 'agent_nickname',
    meta.agentRole === undefined ? undefined : 'agent_role',
    meta.modelProvider === undefined ? undefined : 'model_provider',
  ].filter(field => field !== undefined)
  if (unprojected.length > 0) {
    notes.push({
      field: '*',
      reason: `the session header also carries ${unprojected.join(', ')}, which the canonical session has no field for`,
    })
  }
  const parentNativeId = meta.parentThreadId ?? meta.forkedFromId
  return {
    key: toSessionKey(scan.agentId, nativeId),
    agentId: scan.agentId,
    nativeId,
    nativePath: rollout.path,
    ...(title === undefined ? {} : { title: title.title, titleIsNative: true }),
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    ...(meta.gitBranch === undefined ? {} : { branch: meta.gitBranch }),
    ...(meta.model === undefined ? {} : { model: meta.model }),
    ...(meta.timestamp === undefined ? {} : { createdAt: meta.timestamp }),
    updatedAt: title?.updatedAt ?? new Date(rollout.mtimeMs).toISOString(),
    status: 'idle',
    ...(parentNativeId === undefined ? {} : { parentNativeId: nativeSessionId(parentNativeId) }),
    ...(source === undefined ? {} : { source }),
    binding: { runIds: [] },
    notes,
  }
}

/** A session that exists on disk but could not be projected. */
function unreadableSession(
  scan: CodexSessionScan,
  rollout: RolloutFile,
  nativeIdValue: string,
  notes: readonly ProjectionNote[],
): AgentSession {
  return {
    key: toSessionKey(scan.agentId, nativeSessionId(nativeIdValue)),
    agentId: scan.agentId,
    nativeId: nativeSessionId(nativeIdValue),
    nativePath: rollout.path,
    updatedAt: new Date(rollout.mtimeMs).toISOString(),
    status: 'unreadable',
    binding: { runIds: [] },
    notes,
  }
}

/** Render a session source token, noting archival. */
function archiveAwareSource(source: string | undefined, archived: boolean): string | undefined {
  if (!archived) return source
  return source === undefined ? 'archived' : `${source} (archived)`
}

/** A canonical message before the reader assigns its window index. */
export type CodexMessageDraft = Omit<AgentMessage, 'index'>

/** Projection of one rollout line. */
export interface CodexLineProjection {
  /** Canonical messages the line yielded, in order. */
  readonly messages: readonly CodexMessageDraft[]
  /** Native type token for a record that was recognized but yields no message. */
  readonly skipped?: string
}

/**
 * Project one parsed rollout line.
 *
 * A record whose payload this module does not model still produces a message:
 * `kind: 'unknown'`, `role: 'unknown'`, with the payload preserved as text. Only
 * records that are *known* to carry no conversational content (token usage, world
 * state, realtime items, and unmodelled `event_msg` subtypes) yield nothing, and they
 * are reported through {@link CodexLineProjection.skipped} so the reader declares the gap.
 *
 * @param value - One parsed JSONL line.
 * @returns The messages, and the native token of a recognized-but-unprojected record.
 */
export function projectRolloutLine(value: unknown): CodexLineProjection {
  const record = asRecord(value)
  if (record === undefined) {
    return { messages: [unknownMessage(String(value), undefined, 'rollout:non-object')] }
  }
  const timestamp = str(record, 'timestamp')
  const type = str(record, 'type')
  switch (type) {
    case 'session_meta':
      return projectSessionMeta(record.payload, timestamp)
    case 'response_item':
      return projectResponseItem(record.payload, timestamp)
    case 'event_msg':
      return projectEventMsg(record.payload, timestamp)
    case 'turn_context':
      return projectTurnContext(record.payload, timestamp)
    case 'compacted':
      return projectCompacted(record.payload, timestamp)
    case 'inter_agent_communication':
      return {
        messages: [
          {
            role: 'system',
            kind: 'system',
            text: jsonText(record.payload),
            nativeType: 'inter_agent_communication',
            ...optionalTimestamp(timestamp),
          },
        ],
      }
    case 'token_usage':
    case 'token_usage_record':
    case 'world_state':
    case 'retained_context':
    case 'security_risk_score':
    case 'realtime_item':
    case 'inter_agent_communication_metadata':
      return { messages: [], skipped: type }
    default:
      return {
        messages: [
          unknownMessage(
            record.payload === undefined ? jsonText(value) : jsonText(record.payload),
            timestamp,
            type === undefined ? 'rollout:untyped' : `rollout:${type}`,
          ),
        ],
      }
  }
}

/** Project the session header line. */
function projectSessionMeta(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const meta = sessionMetaFields(payload)
  if (meta === undefined) {
    return { messages: [unknownMessage(jsonText(payload), timestamp, 'session_meta')] }
  }
  const id = str(meta, 'id') ?? str(meta, 'session_id')
  const parts: string[] = []
  const cwd = str(meta, 'cwd')
  const originator = str(meta, 'originator')
  const cliVersion = str(meta, 'cli_version')
  if (cwd !== undefined) parts.push(`cwd ${cwd}`)
  if (originator !== undefined) parts.push(`originator ${originator}`)
  if (cliVersion !== undefined) parts.push(`codex ${cliVersion}`)
  const head = id === undefined ? 'Codex session started' : `Codex session ${id} started`
  return {
    messages: [
      {
        role: 'system',
        kind: 'system',
        text: parts.length === 0 ? head : `${head} (${parts.join(', ')})`,
        nativeType: 'session_meta',
        ...optionalTimestamp(timestamp),
      },
    ],
  }
}

/** Project a `turn_context` line: the per-turn model and policy snapshot. */
function projectTurnContext(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const context = asRecord(payload)
  if (context === undefined) return { messages: [], skipped: 'turn_context(no payload)' }
  const parts: string[] = []
  const model = str(context, 'model')
  const sandbox = describePolicyValue(context.sandbox_policy)
  const approval = describePolicyValue(context.approval_policy)
  const effort = describePolicyValue(context.effort)
  if (model !== undefined) parts.push(`model ${model}`)
  if (sandbox !== undefined) parts.push(`sandbox ${sandbox}`)
  if (approval !== undefined) parts.push(`approvals ${approval}`)
  if (effort !== undefined) parts.push(`reasoning ${effort}`)
  return {
    messages: [
      {
        role: 'system',
        kind: 'system',
        text: parts.length === 0 ? 'Codex turn context' : `Codex turn context: ${parts.join(', ')}`,
        nativeType: 'turn_context',
        ...optionalTimestamp(timestamp),
      },
    ],
  }
}

/** Project a compaction marker, whose payload carries the summary text. */
function projectCompacted(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const summary = str(asRecord(payload), 'message')
  return {
    messages: [
      {
        role: 'system',
        kind: 'system',
        text:
          summary === undefined
            ? 'Codex compacted the session context'
            : capText(`Codex compacted the session context:\n${summary}`),
        nativeType: 'compacted',
        ...optionalTimestamp(timestamp),
      },
    ],
  }
}

/** Project a `response_item` payload, which is a model item. */
function projectResponseItem(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const item = asRecord(payload)
  if (item === undefined) {
    return { messages: [unknownMessage(jsonText(payload), timestamp, 'response_item')] }
  }
  const type = str(item, 'type')
  const nativeType = `response_item:${type ?? 'unknown'}`
  switch (normalize(type)) {
    case 'message': {
      const role = str(item, 'role') ?? ''
      const text = collectText(item.content) || str(item, 'text') || ''
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage(roleOf(role), kindOf(role), text, nativeType, timestamp)] }
    }
    case 'agentmessage': {
      const text = collectText(item.content) || str(item, 'text') || ''
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'assistant', text, nativeType, timestamp)] }
    }
    case 'reasoning': {
      const text = collectText(item.summary) || collectText(item.content)
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'reasoning', text, nativeType, timestamp)] }
    }
    case 'functioncall':
    case 'customtoolcall': {
      const name = str(item, 'name') ?? 'tool'
      const input = str(item, 'arguments') ?? str(item, 'input')
      return { messages: [toolCall(name, input, nativeType, timestamp)] }
    }
    case 'localshellcall': {
      const action = asRecord(item.action)
      const command = collectText(action?.command ?? action)
      return { messages: [toolCall('shell', command === '' ? jsonText(item.action) : command, nativeType, timestamp)] }
    }
    case 'functioncalloutput':
    case 'customtoolcalloutput':
      return { messages: [toolResult(str(item, 'name') ?? 'tool', outputText(item.output), nativeType, timestamp)] }
    case 'websearchcall': {
      const query = str(item, 'query') ?? describePolicyValue(item.action)
      return { messages: [toolCall('web_search', query, nativeType, timestamp)] }
    }
    default:
      return { messages: [unknownMessage(jsonText(payload), timestamp, nativeType)] }
  }
}

/** Project an `event_msg` payload, which is a structured engine event. */
function projectEventMsg(payload: unknown, timestamp: string | undefined): CodexLineProjection {
  const event = asRecord(payload)
  if (event === undefined) {
    return { messages: [unknownMessage(jsonText(payload), timestamp, 'event_msg')] }
  }
  const type = str(event, 'type')
  const nativeType = `event_msg:${type ?? 'unknown'}`
  switch (normalize(type)) {
    case 'error': {
      const message = str(event, 'message') ?? jsonText(event)
      return { messages: [textMessage('system', 'error', message, nativeType, timestamp)] }
    }
    case 'warning':
    case 'guardianwarning': {
      const message = str(event, 'message') ?? jsonText(event)
      return { messages: [textMessage('system', 'system', message, nativeType, timestamp)] }
    }
    case 'itemstarted':
    case 'itemupdated':
    case 'itemcompleted': {
      const item = asRecord(event.item)
      if (item === undefined) return { messages: [], skipped: nativeType }
      return projectTurnItem(item, nativeType, timestamp)
    }
    case 'planupdate': {
      const text = renderPlanSteps(event.plan)
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'plan', text, nativeType, timestamp)] }
    }
    case 'usermessage':
    case 'userinput': {
      const text = str(event, 'message') ?? collectText(event.content)
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('user', 'user', text, nativeType, timestamp)] }
    }
    case 'agentmessage': {
      const text = str(event, 'message') ?? str(event, 'text') ?? ''
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'assistant', text, nativeType, timestamp)] }
    }
    case 'agentreasoning':
    case 'agentreasoningdelta': {
      const text = str(event, 'text') ?? str(event, 'delta') ?? ''
      if (text === '') return { messages: [], skipped: nativeType }
      return { messages: [textMessage('assistant', 'reasoning', text, nativeType, timestamp)] }
    }
    case 'execcommandbegin': {
      const command = collectText(event.command)
      return { messages: [toolCall('shell', command === '' ? jsonText(event.command) : command, nativeType, timestamp)] }
    }
    case 'execcommandend': {
      const output = [str(event, 'stdout'), str(event, 'stderr')].filter(part => part !== undefined).join('\n')
      const exitCode = event.exit_code
      return {
        messages: [
          toolResult('shell', output, nativeType, timestamp, typeof exitCode === 'number' ? exitCode !== 0 : undefined),
        ],
      }
    }
    default:
      return { messages: [], skipped: nativeType }
  }
}

/** Project a `TurnItem`, the item family shared by rollout events and the app server. */
function projectTurnItem(
  item: Record<string, unknown>,
  nativeType: string,
  timestamp: string | undefined,
): CodexLineProjection {
  const type = str(item, 'type')
  const token = `${nativeType}:${type ?? 'unknown'}`
  switch (normalize(type)) {
    case 'usermessage': {
      const text = collectText(item.content)
      if (text === '') return { messages: [], skipped: token }
      return { messages: [textMessage('user', 'user', text, token, timestamp)] }
    }
    case 'agentmessage': {
      const text = str(item, 'text') ?? collectText(item.content)
      if (text === '') return { messages: [], skipped: token }
      return { messages: [textMessage('assistant', 'assistant', text, token, timestamp)] }
    }
    case 'reasoning': {
      const text = collectText(item.summary_text) || collectText(item.summary) || collectText(item.raw_content)
      if (text === '') return { messages: [], skipped: token }
      return { messages: [textMessage('assistant', 'reasoning', text, token, timestamp)] }
    }
    case 'plan': {
      const text = str(item, 'text') ?? ''
      if (text === '') return { messages: [], skipped: token }
      return { messages: [textMessage('assistant', 'plan', text, token, timestamp)] }
    }
    case 'commandexecution': {
      const status = normalize(str(item, 'status'))
      if (status === 'inprogress') {
        const command = str(item, 'command') ?? jsonText(item.command)
        return { messages: [toolCall('shell', command, token, timestamp)] }
      }
      return {
        messages: [
          toolResult(
            'shell',
            str(item, 'aggregated_output'),
            token,
            timestamp,
            status === 'failed' || status === 'declined',
          ),
        ],
      }
    }
    case 'functioncalloutput':
      return { messages: [toolResult(str(item, 'name') ?? 'tool', outputText(item.output), token, timestamp)] }
    case 'dynamictoolcall':
    case 'mcptoolcall':
    case 'collabagenttoolcall': {
      const name = str(item, 'name') ?? str(item, 'tool') ?? 'mcp'
      const input = item.arguments === undefined ? str(item, 'prompt') : jsonText(item.arguments)
      return { messages: [toolCall(name, input, token, timestamp)] }
    }
    case 'filechange': {
      const paths = collectPaths(item.changes)
      if (paths.length === 0) return { messages: [], skipped: token }
      return { messages: [{ role: 'tool', kind: 'file-change', paths, nativeType: token, ...optionalTimestamp(timestamp) }] }
    }
    case 'websearch': {
      const query = str(item, 'query') ?? jsonText(item.action)
      return { messages: [toolCall('web_search', query, token, timestamp)] }
    }
    case 'contextcompaction':
      return { messages: [textMessage('system', 'system', 'Codex compacted the session context', token, timestamp)] }
    default:
      return { messages: [], skipped: token }
  }
}

/** Collect file paths out of a native change list. */
function collectPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  for (const entry of value) {
    const path = str(asRecord(entry), 'path')
    if (path !== undefined) paths.push(path)
    else if (typeof entry === 'string') paths.push(entry)
  }
  return paths
}

/** Render a native plan step list as readable plan text. */
function renderPlanSteps(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const lines: string[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const step = str(record, 'step') ?? str(record, 'text')
    if (step === undefined) continue
    // The native status token is rendered verbatim; the canonical vocabulary is applied
    // separately by the task reader.
    const marker = record.completed === true ? 'completed' : str(record, 'status') ?? 'pending'
    lines.push(`- [${marker}] ${step}`)
  }
  return lines.join('\n')
}

/** The `output` of a native function-call output, which is a string or a content list. */
function outputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const record = asRecord(value)
  if (record === undefined) return undefined
  const items = collectText(record.content_items)
  if (items !== '') return items
  return str(record, 'content')
}

/** Render a native policy value (sandbox policy, approval policy, effort) as one token. */
function describePolicyValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const record = asRecord(value)
  if (record === undefined) return undefined
  const token = str(record, 'type') ?? str(record, 'kind') ?? str(record, 'mode')
  if (token !== undefined) return token
  const keys = Object.keys(record)
  return keys.length === 0 ? undefined : keys.join(',')
}

/** Canonical role for a native message role. */
function roleOf(role: string): AgentMessage['role'] {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'system':
    case 'developer':
      return 'system'
    case 'tool':
      return 'tool'
    default:
      return 'unknown'
  }
}

/** Canonical kind for a native message role. */
function kindOf(role: string): AgentMessage['kind'] {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'tool':
      return 'tool-result'
    default:
      return 'system'
  }
}

/**
 * A canonical text field, with the cap flag the contract asks for.
 *
 * @param text - Native text.
 * @returns The text, and whether the field cap cut it.
 */
function capped(text: string): { text: string; truncated: boolean } {
  return text.length <= MAX_MESSAGE_TEXT_BYTES ? { text, truncated: false } : { text: capText(text), truncated: true }
}

/** A `truncated` field, present only when something was cut. */
function truncatedFlag(truncated: boolean): { truncated?: boolean } {
  return truncated ? { truncated: true } : {}
}

/**
 * Build a plain text message draft.
 *
 * @param role - Canonical role.
 * @param kind - Canonical kind.
 * @param text - Native text, capped by the field limit.
 * @param nativeType - Native type token, for traceability.
 * @param timestamp - Native timestamp, when the record carried one.
 * @returns The draft.
 */
function textMessage(
  role: AgentMessage['role'],
  kind: AgentMessage['kind'],
  text: string,
  nativeType: string,
  timestamp: string | undefined,
): CodexMessageDraft {
  const body = capped(text)
  return {
    role,
    kind,
    text: body.text,
    ...truncatedFlag(body.truncated),
    nativeType,
    ...optionalTimestamp(timestamp),
  }
}

/**
 * Build a tool-call draft.
 *
 * @param name - Native tool name.
 * @param input - Serialized native input, when there is one.
 * @param nativeType - Native type token.
 * @param timestamp - Native timestamp, when the record carried one.
 * @returns The draft.
 */
function toolCall(
  name: string,
  input: string | undefined,
  nativeType: string,
  timestamp: string | undefined,
): CodexMessageDraft {
  const body = input === undefined || input === '' ? undefined : capped(input)
  return {
    role: 'assistant',
    kind: 'tool-call',
    nativeType,
    tool: body === undefined ? { name } : { name, input: body.text },
    ...(body === undefined ? {} : truncatedFlag(body.truncated)),
    ...optionalTimestamp(timestamp),
  }
}

/**
 * Build a tool-result draft.
 *
 * @param name - Native tool name.
 * @param output - Native output, when there is one.
 * @param nativeType - Native type token.
 * @param timestamp - Native timestamp, when the record carried one.
 * @param failed - Whether the native record marks the call as failed.
 * @returns The draft.
 */
function toolResult(
  name: string,
  output: string | undefined,
  nativeType: string,
  timestamp: string | undefined,
  failed?: boolean,
): CodexMessageDraft {
  const body = output === undefined || output === '' ? undefined : capped(output)
  return {
    role: 'tool',
    kind: 'tool-result',
    nativeType,
    tool: {
      name,
      ...(body === undefined ? {} : { output: body.text }),
      ...(failed === undefined ? {} : { failed }),
    },
    ...(body === undefined ? {} : truncatedFlag(body.truncated)),
    ...optionalTimestamp(timestamp),
  }
}

/**
 * Build an `unknown` message draft preserving a native payload.
 *
 * @param text - Raw or serialized native content.
 * @param timestamp - Native timestamp, when the record carried one.
 * @param nativeType - Native type token.
 * @returns The draft.
 */
function unknownMessage(text: string, timestamp: string | undefined, nativeType: string): CodexMessageDraft {
  const body = capped(text)
  return {
    role: 'unknown',
    kind: 'unknown',
    text: body.text,
    ...truncatedFlag(body.truncated),
    nativeType,
    ...optionalTimestamp(timestamp),
  }
}

/**
 * A `timestamp` field, or nothing when the record carries none.
 *
 * @param timestamp - Native timestamp.
 * @returns The spreadable field.
 */
function optionalTimestamp(timestamp: string | undefined): { timestamp?: string } {
  return timestamp === undefined ? {} : { timestamp }
}

/**
 * Serialize a native value to text for an `unknown` message.
 *
 * @param value - Native value.
 * @returns Bounded text.
 */
function jsonText(value: unknown): string {
  try {
    return capText(JSON.stringify(value) ?? String(value))
  } catch {
    return String(value)
  }
}

/**
 * Normalize a native type token for comparison.
 *
 * @param value - Native type token, or `undefined`.
 * @returns The comparable, separator-free lowercase form.
 */
function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Concatenate the text parts of a native content list.
 *
 * @param value - Native content, a string or a list of typed parts.
 * @returns The joined text.
 */
function collectText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      parts.push(entry)
      continue
    }
    const record = asRecord(entry)
    if (record === undefined) continue
    const token = normalize(str(record, 'type'))
    const text = str(record, 'text')
    if (text !== undefined && (token === 'text' || token === 'inputtext' || token === 'outputtext' || token === 'summarytext')) {
      parts.push(text)
    } else if (token === 'image' || token === 'inputimage' || token === 'localimage') {
      parts.push('[image]')
    } else if (token === 'audio' || token === 'inputaudio' || token === 'localaudio') {
      parts.push('[audio]')
    }
  }
  return parts.join('\n')
}

/**
 * Truncate native text to the transcript field cap.
 *
 * @param text - Native text.
 * @returns The text, cut and marked when it was longer.
 */
function capText(text: string): string {
  if (text.length <= MAX_MESSAGE_TEXT_BYTES) return text
  return `${text.slice(0, MAX_MESSAGE_TEXT_BYTES)}\n[truncated by muti-agent at ${MAX_MESSAGE_TEXT_BYTES} characters]`
}

/** Result of projecting a transcript window. */
export interface CodexTranscript {
  /** Messages in ascending index order. */
  readonly messages: readonly AgentMessage[]
  /** Whether earlier content exists outside the read window. */
  readonly hasMore: boolean
  /** Declared projection gaps. */
  readonly notes: readonly ProjectionNote[]
}

/** Everything a transcript read needs. */
export interface CodexTranscriptRead {
  /** Read-only filesystem helpers. */
  readonly files: FileProbe
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Native session (thread) id to read. */
  readonly nativeId: NativeSessionId
  /** Caller options: message cap and byte cap. */
  readonly options: ReadTranscriptOptions
  /** Tail bytes to read when the caller caps nothing. */
  readonly defaultTailBytes: number
}

/**
 * Read a bounded transcript window from the tail of a rollout.
 *
 * @param read - Filesystem helpers, home layout and caller options.
 * @returns The messages, whether older content exists, and every declared gap.
 * @throws {MutiAgentError} `session/not-found` when no rollout carries this id, and
 *   `session/unreadable` when the rollout is zstd-compressed, because this adapter
 *   version cannot decompress one.
 */
export async function readCodexTranscript(read: CodexTranscriptRead): Promise<CodexTranscript> {
  const located = await locateRollout(read.files, read.home, read.nativeId)
  if (located === undefined) {
    throw new MutiAgentError(
      ErrorCodes.sessionNotFound,
      `no Codex rollout for session ${String(read.nativeId)} under ${read.home.path}`,
      {
        details: { agent: 'codex', nativeId: String(read.nativeId), home: read.home.path },
        remediation: 'Refresh the session list; the rollout may have been archived elsewhere or deleted.',
      },
    )
  }
  if (located.compressed) {
    throw new MutiAgentError(
      ErrorCodes.sessionUnreadable,
      `Codex session ${String(read.nativeId)} is stored zstd-compressed (${located.path})`,
      {
        details: { agent: 'codex', nativeId: String(read.nativeId), path: located.path },
        remediation:
          'This adapter version does not decompress rollouts. Open the session in Codex, which materialises the plain rollout, then read it again.',
      },
    )
  }
  const maxBytes = Math.max(1, read.options.maxBytes ?? read.defaultTailBytes)
  const tail = await read.files.readTail(located.path, maxBytes)
  if (tail.missing) {
    throw new MutiAgentError(
      ErrorCodes.sessionNotFound,
      `Codex rollout ${located.path} disappeared before it could be read`,
      {
        details: { agent: 'codex', nativeId: String(read.nativeId), path: located.path },
        remediation: 'Refresh the session list; the file was removed or replaced while it was being read.',
      },
    )
  }
  const drafts: CodexMessageDraft[] = []
  const skipped = new Map<string, number>()
  let unparsable = 0
  for (const line of tail.text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      unparsable += 1
      drafts.push({ role: 'unknown', kind: 'unknown', text: capText(line), nativeType: 'rollout:unparsable' })
      continue
    }
    const projection = projectRolloutLine(parsed.value)
    for (const message of projection.messages) drafts.push(message)
    if (projection.skipped !== undefined) {
      skipped.set(projection.skipped, (skipped.get(projection.skipped) ?? 0) + 1)
    }
  }
  const maxMessages = read.options.maxMessages
  const dropped = maxMessages !== undefined && maxMessages > 0 && drafts.length > maxMessages ? drafts.length - maxMessages : 0
  const window = dropped === 0 ? drafts : drafts.slice(dropped)
  const messages: AgentMessage[] = window.map((draft, index) => ({ index, ...draft }))
  const notes: ProjectionNote[] = []
  if (tail.droppedPartialLine || tail.truncated) {
    notes.push({
      field: 'messages',
      reason: `only the last ${String(maxBytes)} bytes of the rollout were read; older messages are outside the window`,
    })
  }
  if (dropped > 0) {
    notes.push({
      field: 'messages',
      reason: `only the last ${String(maxMessages ?? 0)} messages were returned; ${String(dropped)} earlier message(s) are outside the window`,
    })
  }
  if (unparsable > 0) {
    notes.push({
      field: '*',
      reason: `${String(unparsable)} rollout line(s) in the window were not valid JSON; each is preserved as an \`unknown\` message holding the raw line`,
    })
  }
  if (skipped.size > 0) {
    const rendered = [...skipped.entries()].map(([type, count]) => `${type} x${String(count)}`).join(', ')
    notes.push({
      field: '*',
      reason: `records that carry no conversational content were not projected: ${rendered}`,
    })
  }
  notes.push({
    field: 'usage',
    reason: 'Codex records token usage on token_usage lines and turn boundaries, not per message, so no message carries usage',
  })
  return { messages, hasMore: tail.truncated || tail.droppedPartialLine || dropped > 0, notes }
}

/** A rollout file located for a session id. */
interface LocatedRollout {
  readonly path: string
  readonly compressed: boolean
}

/**
 * Find the rollout file for a session id.
 *
 * Codex encodes the thread id in the rollout file name (with an optional rollout id
 * suffix for reverted threads), which makes a name lookup sufficient and cheap.
 *
 * @param files - Read-only filesystem helpers.
 * @param home - Resolved home layout.
 * @param nativeId - Native thread id.
 * @returns The newest matching rollout, or `undefined`.
 */
async function locateRollout(
  files: FileProbe,
  home: CodexHome,
  nativeId: NativeSessionId,
): Promise<LocatedRollout | undefined> {
  const needle = String(nativeId)
  if (needle === '') return undefined
  const matches: RolloutFile[] = []
  for (const { root, archived } of [
    { root: home.sessionsRoot, archived: false },
    { root: home.archivedRoot, archived: true },
  ]) {
    const entries = await files.findFiles(root, name => isRolloutFileName(name) && name.includes(needle), {
      maxDepth: ROLLOUT_MAX_DEPTH,
      maxFiles: ROLLOUT_MAX_FILES,
    })
    for (const entry of entries) {
      matches.push({
        path: entry.path,
        name: entry.name,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        archived,
        compressed: entry.name.endsWith('.zst'),
      })
    }
  }
  // A plain rollout wins over a compressed one: the compressed form is unreadable here,
  // and during in-place compression both can exist for the same thread.
  matches.sort((a, b) => (a.compressed === b.compressed ? b.mtimeMs - a.mtimeMs : a.compressed ? 1 : -1))
  const best = matches[0]
  return best === undefined ? undefined : { path: best.path, compressed: best.compressed }
}

/** Everything a native task read needs. */
export interface CodexNativeTaskRead {
  /** Read-only filesystem helpers. */
  readonly files: FileProbe
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Owning agent id, stamped on every todo. */
  readonly agentId: AgentId
  /** Native thread id. */
  readonly nativeId: NativeSessionId
  /** Bytes read from the rollout tail; the latest task state is at the end of the file. */
  readonly tailBytes: number
}

/**
 * Read Codex's own todo and plan state for a session.
 *
 * Codex records its checklist twice: as `plan_update` events (and the equivalent
 * `update_plan` tool call) carrying `{step, status}` items, and, in plan mode, as
 * `plan` items carrying the plan text. The latest record in the read window wins.
 *
 * @param read - Filesystem helpers, home layout and the session to read.
 * @returns The observed state, or `undefined` when the session records neither.
 */
export async function readCodexNativeTasks(read: CodexNativeTaskRead): Promise<NativeTaskState | undefined> {
  const located = await locateRollout(read.files, read.home, read.nativeId)
  if (located === undefined) return undefined
  if (located.compressed) {
    return {
      todos: [],
      notes: [
        {
          field: '*',
          reason: 'the rollout is zstd-compressed and this adapter version cannot decompress it, so no task state was read',
        },
      ],
    }
  }
  const tail = await read.files.readTail(located.path, Math.max(1, read.tailBytes))
  if (tail.missing) return undefined
  const observedAt = new Date().toISOString()
  let todos: AgentTodo[] | undefined
  let planItems: readonly string[] | undefined
  let unparsable = 0
  for (const line of tail.text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      unparsable += 1
      continue
    }
    const record = asRecord(parsed.value)
    if (record === undefined) continue
    const timestamp = str(record, 'timestamp') ?? observedAt
    for (const candidate of extractTaskCandidates(str(record, 'type'), asRecord(record.payload))) {
      if (candidate.kind === 'plan') planItems = candidate.items
      else todos = makeTodos(read, candidate.items, timestamp)
    }
  }
  if (todos === undefined && planItems === undefined) return undefined
  const notes: ProjectionNote[] = []
  if (todos !== undefined) {
    notes.push({
      field: 'status',
      reason: 'Codex checklists carry pending, in-progress and completed only; blocked and cancelled are unreachable',
    })
    notes.push({
      field: 'updatedAt',
      reason: "the timestamp of the record that carried the checklist stands in for each item's own last change time",
    })
    notes.push({ field: 'blockedBy', reason: 'Codex expresses no dependencies between checklist items, so blockedBy is empty' })
  }
  if (planItems !== undefined) {
    notes.push({
      field: 'plan.active',
      reason:
        'whether plan mode is still active is not recorded; `active` reflects only that a plan item exists in the read window',
    })
  }
  if (unparsable > 0) {
    notes.push({
      field: '*',
      reason: `${String(unparsable)} rollout line(s) in the read window were not valid JSON and could not contribute task state`,
    })
  }
  return {
    todos: todos ?? [],
    ...(planItems === undefined ? {} : { plan: { active: true, items: planItems } }),
    notes,
  }
}

/** One checklist item as the native record carried it. */
interface TaskItem {
  readonly content: string
  readonly status: TodoStatus
  readonly nativeKey: string
}

/** Task state one native record contributed. */
type TaskCandidate =
  | { readonly kind: 'todos'; readonly items: readonly TaskItem[] }
  | { readonly kind: 'plan'; readonly items: readonly string[] }

/** Extract the task state a single rollout record contributes, if any. */
function extractTaskCandidates(
  type: string | undefined,
  payload: Record<string, unknown> | undefined,
): readonly TaskCandidate[] {
  if (payload === undefined) return []
  const out: TaskCandidate[] = []
  if (type === 'response_item') {
    if (normalize(str(payload, 'type')) === 'functioncall' && normalize(str(payload, 'name')) === 'updateplan') {
      const items = planUpdateItems(str(payload, 'arguments'))
      if (items.length > 0) out.push({ kind: 'todos', items })
    }
    return out
  }
  if (type === 'event_msg') {
    const eventType = normalize(str(payload, 'type'))
    if (eventType === 'planupdate' || eventType === 'turnplanupdated') {
      const items = planUpdateItems(payload.plan)
      if (items.length > 0) out.push({ kind: 'todos', items })
    } else if (eventType === 'todolist') {
      const items = todoListItems(payload.items)
      if (items.length > 0) out.push({ kind: 'todos', items })
    }
    const item = asRecord(payload.item)
    const itemType = normalize(str(item, 'type'))
    if (itemType === 'todolist') {
      const items = todoListItems(item?.items)
      if (items.length > 0) out.push({ kind: 'todos', items })
    } else if (itemType === 'plan') {
      const text = str(item, 'text')
      if (text !== undefined) out.push({ kind: 'plan', items: [text] })
    }
    return out
  }
  const itemType = normalize(str(payload, 'type'))
  if (itemType === 'todolist') {
    const items = todoListItems(payload.items)
    if (items.length > 0) out.push({ kind: 'todos', items })
  }
  if (itemType === 'plan') {
    const text = str(payload, 'text')
    if (text !== undefined) out.push({ kind: 'plan', items: [text] })
  }
  return out
}

/** Parse a `{plan: [{step, status}]}` payload, from an event or from tool-call arguments. */
function planUpdateItems(value: unknown): TaskItem[] {
  const parsed = typeof value === 'string' ? parseJsonLine(value) : undefined
  const source = parsed === undefined ? value : parsed.ok ? parsed.value : undefined
  const plan = Array.isArray(source) ? source : asRecord(source)?.plan
  if (!Array.isArray(plan)) return []
  const items: TaskItem[] = []
  for (const entry of plan) {
    const item = asRecord(entry)
    const content = str(item, 'step') ?? str(item, 'text')
    if (content === undefined) continue
    items.push({ content, status: todoStatus(item), nativeKey: 'update_plan' })
  }
  return items
}

/** Parse a `todo_list` item list of `{text, completed}` entries. */
function todoListItems(value: unknown): TaskItem[] {
  if (!Array.isArray(value)) return []
  const items: TaskItem[] = []
  for (const entry of value) {
    const item = asRecord(entry)
    const content = str(item, 'text') ?? str(item, 'step')
    if (content === undefined) continue
    items.push({ content, status: todoStatus(item), nativeKey: 'todo_list' })
  }
  return items
}

/** Native item status, mapped onto the canonical todo vocabulary. */
function todoStatus(item: Record<string, unknown> | undefined): TodoStatus {
  if (item?.completed === true) return 'completed'
  return PLAN_STATUS[normalize(str(item, 'status'))] ?? 'pending'
}

/**
 * Build canonical todos with ids that are stable across reads.
 *
 * @param read - The task read, for session identity and ownership.
 * @param items - Native items, in list order.
 * @param timestamp - Timestamp of the record that carried the list.
 * @returns Canonical todos.
 */
function makeTodos(read: CodexNativeTaskRead, items: readonly TaskItem[], timestamp: string): AgentTodo[] {
  const seen = new Map<string, number>()
  return items.map(item => {
    const base = codexTodoId(String(read.nativeId), item.nativeKey, item.content)
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return {
      // Identical content inside one list is the only case that needs a suffix, so the
      // common item keeps one id no matter how the list is reordered.
      id: toTodoId(occurrence === 1 ? base : `${base}-${String(occurrence)}`),
      content: item.content,
      status: item.status,
      owner: read.agentId,
      blockedBy: [],
      updatedAt: timestamp,
      observedIn: toSessionKey(read.agentId, read.nativeId),
      nativeKey: item.nativeKey,
    }
  })
}

/**
 * Derive a todo id that survives re-reads.
 *
 * The id hashes the owning session, the native key and the item's content, so the same
 * checklist item keeps its id across reads.
 *
 * @param nativeId - Owning session's native id.
 * @param nativeKey - Native key of the item (`update_plan`, `todo_list`).
 * @param content - Item content.
 * @returns The canonical todo id value.
 */
export function codexTodoId(nativeId: string, nativeKey: string, content: string): string {
  return `codex-${hashText(`${nativeId}\u0000${nativeKey}\u0000${content}`)}`
}

/**
 * FNV-1a over the UTF-16 code units of a string, as 8 hex digits.
 *
 * Implemented here rather than imported so the adapter adds no dependency; it is a
 * stability device for ids, not a security primitive.
 *
 * @param text - Text to hash.
 * @returns Eight lowercase hex digits.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
