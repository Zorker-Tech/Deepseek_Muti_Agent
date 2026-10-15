/**
 * Grok Build's on-disk session store, read in place and never written (ADR-0012).
 *
 * Layout verified against xAI's source: `xai-grok-config/src/paths.rs` owns the
 * `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/` shape (URL-encoded cwd, or
 * `{slug}-{blake3_hex16}` plus a `.cwd` marker when the encoded name exceeds 255
 * bytes); `xai-grok-shell/src/session/storage/mod.rs` names the per-session files, and
 * `summary.json` (`session::persistence::Summary`) is the authoritative metadata.
 * Session ids are UUIDv7.
 *
 * Every read is bounded and tolerates a file another process is appending to; a
 * malformed record costs that record, not the session.
 *
 * @module @zorker/muti-agent-adapter-grok/sessions
 */

import { join } from 'node:path'
import type {
  AgentMessage,
  AgentSession,
  AgentTodo,
  ProjectionNote,
  SessionKey,
  SessionUsage,
} from '@zorker/muti-agent-contracts'
import { agentId, nativeSessionId, sessionKey, todoId } from '@zorker/muti-agent-contracts'
import type {
  FileProbe,
  ListSessionsOptions,
  Logger,
  NativeTaskState,
  ReadTranscriptOptions,
} from '@zorker/muti-agent-core'
import { parseJsonLine } from '@zorker/muti-agent-core'
import { asRecord, locationPaths, planEntries, todoStatus, toolContentText } from './events.ts'

/** Agent id this adapter projects; declared here so this module needs no adapter import. */
const AGENT_ID = 'grok'

/** Fixed file names inside a session directory (xAI `session::storage`). */
export const SUMMARY_FILE = 'summary.json'
export const UPDATES_FILE = 'updates.jsonl'
export const CHAT_HISTORY_FILE = 'chat_history.jsonl'
export const PLAN_FILE = 'plan.json'
export const PLAN_MODE_FILE = 'plan_mode.json'
export const USAGE_FILE = 'usage.json'
export const CWD_MARKER_FILE = '.cwd'

/** Default transcript window: the newest 1 MiB of records. */
const TRANSCRIPT_BYTES = 1024 * 1024

/** Characters kept of one projected field before it is dropped as oversized. */
const FIELD_CHARS = 16 * 1024

/** Resolved Grok Build locations for this machine. */
export interface GrokPaths {
  /** `$GROK_HOME` verbatim when non-empty, else `~/.grok` (grok resolves no XDG path). */
  home: string
  /** Whether {@link home} came from the environment rather than the home default. */
  homeFromEnv: boolean
  /** `<home>/sessions`. */
  sessionRoot: string
  /** `$GROK_AUTH_PATH` when set, else `<home>/auth.json`. */
  credentialPath: string
}

/**
 * Resolve the store locations the same way grok does.
 *
 * @param options - Config home override, host environment and a file probe for `~`.
 * @returns The resolved home, session root and credential path.
 */
export function resolveGrokPaths(options: {
  homeDir?: string
  env: NodeJS.ProcessEnv
  files: FileProbe
}): GrokPaths {
  const env = options.env
  const override = options.homeDir === undefined || options.homeDir === '' ? undefined : options.homeDir
  const fromEnv = override === undefined ? env.GROK_HOME : undefined
  const usedEnv = override === undefined && fromEnv !== undefined && fromEnv !== ''
  const home =
    override !== undefined
      ? options.files.resolvePath(override)
      : usedEnv && fromEnv !== undefined
        ? fromEnv
        : join(env.HOME ?? env.USERPROFILE ?? '', '.grok')
  const authPath = env.GROK_AUTH_PATH
  return {
    home,
    homeFromEnv: usedEnv,
    sessionRoot: join(home, 'sessions'),
    credentialPath: authPath === undefined || authPath === '' ? join(home, 'auth.json') : authPath,
  }
}

/**
 * Encode a cwd into grok's short-form directory name.
 *
 * Mirrors `urlencoding::encode`; the long-path slug-hash fallback is not reproduced
 * because a caller that has to *find* a directory decodes rather than encodes.
 *
 * @param cwd - Absolute working directory.
 * @returns The directory name grok uses for paths that encode within 255 bytes.
 */
export function encodeCwdDirName(cwd: string): string {
  return encodeURIComponent(cwd)
}

/**
 * Decode a cwd-level session directory name.
 *
 * @param dirPath - Absolute `<sessionRoot>/<encoded-cwd>` directory.
 * @param files - Read-only probe used for the `.cwd` marker fallback.
 * @returns The original cwd, or `undefined` when neither the name nor the marker yields one.
 */
export async function decodeCwdDirName(dirPath: string, files: FileProbe): Promise<string | undefined> {
  const name = files.baseName(dirPath)
  try {
    const decoded = decodeURIComponent(name)
    // An absolute Unix cwd always decodes to a leading "/"; the slug-hash form never does.
    if (decoded.startsWith('/')) return decoded
  } catch {
    // A name that is not valid percent-encoding is the slug-hash form, not an error.
  }
  const marker = await files.readHead(join(dirPath, CWD_MARKER_FILE), 8 * 1024)
  const cwd = marker.missing ? '' : marker.text.trim()
  return cwd === '' ? undefined : cwd
}

/** The subset of `summary.json` this adapter projects. */
export interface GrokSummary {
  id?: string
  cwd?: string
  sessionSummary?: string
  createdAt?: string
  updatedAt?: string
  numMessages?: number
  numChatMessages?: number
  currentModelId?: string
  parentSessionId?: string
  sessionKind?: string
  hidden?: boolean
  sourceWorkspaceDir?: string
  gitRootDir?: string
  headBranch?: string
  generatedTitle?: string
  titleIsManual?: boolean
  worktreeLabel?: string
  sandboxProfile?: string
  reasoningEffort?: string
  lastTurnSummary?: string
}

/**
 * Parse `summary.json` tolerantly.
 *
 * @param value - Parsed JSON of the file.
 * @returns The projected summary; every field is optional because grok omits unset ones.
 */
export function parseGrokSummary(value: unknown): GrokSummary {
  const record = asRecord(value)
  if (record === undefined) return {}
  const info = asRecord(record.info)
  const id = nonEmpty(info?.id)
  const cwd = nonEmpty(info?.cwd)
  const sessionSummary = nonEmpty(record.session_summary)
  const createdAt = isoValue(record.created_at)
  const updatedAt = isoValue(record.updated_at)
  const numMessages = whole(record.num_messages)
  const numChatMessages = whole(record.num_chat_messages)
  const currentModelId = nonEmpty(record.current_model_id)
  const parentSessionId = nonEmpty(record.parent_session_id)
  const sessionKind = nonEmpty(record.session_kind)
  const sourceWorkspaceDir = nonEmpty(record.source_workspace_dir)
  const gitRootDir = nonEmpty(record.git_root_dir)
  const headBranch = nonEmpty(record.head_branch)
  const generatedTitle = nonEmpty(record.generated_title)
  const worktreeLabel = nonEmpty(record.worktree_label)
  const sandboxProfile = nonEmpty(record.sandbox_profile)
  const reasoningEffort = nonEmpty(record.reasoning_effort)
  const lastTurnSummary = nonEmpty(record.last_turn_summary)
  return {
    ...(id === undefined ? {} : { id }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(sessionSummary === undefined ? {} : { sessionSummary }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(numMessages === undefined ? {} : { numMessages }),
    ...(numChatMessages === undefined ? {} : { numChatMessages }),
    ...(currentModelId === undefined ? {} : { currentModelId }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(sessionKind === undefined ? {} : { sessionKind }),
    ...(record.hidden === true ? { hidden: true } : {}),
    ...(sourceWorkspaceDir === undefined ? {} : { sourceWorkspaceDir }),
    ...(gitRootDir === undefined ? {} : { gitRootDir }),
    ...(headBranch === undefined ? {} : { headBranch }),
    ...(generatedTitle === undefined ? {} : { generatedTitle }),
    ...(record.title_is_manual === true ? { titleIsManual: true } : {}),
    ...(worktreeLabel === undefined ? {} : { worktreeLabel }),
    ...(sandboxProfile === undefined ? {} : { sandboxProfile }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(lastTurnSummary === undefined ? {} : { lastTurnSummary }),
  }
}

/** One resolved session directory plus what was recoverable from it. */
export interface GrokSessionDirectory {
  /** Absolute session directory. */
  dir: string
  /** cwd recorded for the session, when resolvable. */
  cwd: string | undefined
  /** `updated_at` of the summary, when readable. */
  updatedAt: string | undefined
  /** `num_messages` as grok reported it, when readable. */
  messageCount: number | undefined
  /** Parsed summary, when readable. */
  summary: GrokSummary | undefined
  /** Declared projection gaps raised while resolving the directory. */
  notes: readonly ProjectionNote[]
}

/**
 * Locate one session's directory by native id.
 *
 * The cwd level is unknown, so every cwd directory is probed for a child of that name;
 * a session directory is valid even when its `summary.json` is currently unreadable.
 *
 * @param params - File probe, resolved paths and the native session id.
 * @returns The resolved directory, or `undefined` when no cwd directory contains it.
 */
export async function findGrokSessionDir(params: {
  files: FileProbe
  paths: GrokPaths
  nativeId: string
}): Promise<GrokSessionDirectory | undefined> {
  const cwdDirs = await params.files.listDir(params.paths.sessionRoot)
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory) continue
    const dir = join(cwdDir.path, params.nativeId)
    if (!(await params.files.isDirectory(dir))) continue
    return projectDirectory({ files: params.files, dir, cwdDir: cwdDir.path })
  }
  return undefined
}

/**
 * Enumerate sessions from `summary.json`, newest first.
 *
 * Hidden sessions are listed with a note rather than filtered out, subagent and forked
 * children are included with their parent and `session_kind`, and an unreadable summary
 * degrades just that session.
 *
 * @param params - File probe, resolved paths, filter options and a logger.
 * @returns One projection per session directory.
 */
export async function listGrokSessions(params: {
  files: FileProbe
  paths: GrokPaths
  options: ListSessionsOptions
  log: Logger
}): Promise<readonly AgentSession[]> {
  const sessions: AgentSession[] = []
  const wantCwd = params.options.cwd === undefined ? undefined : params.files.resolvePath(params.options.cwd)
  const aborted = (): boolean => params.options.signal?.aborted === true
  const cwdDirs = await params.files.listDir(params.paths.sessionRoot)
  for (const cwdDir of cwdDirs) {
    if (aborted()) break
    if (!cwdDir.isDirectory) continue
    const sessionDirs = await params.files.listDir(cwdDir.path)
    for (const sessionDir of sessionDirs) {
      if (aborted()) break
      if (!sessionDir.isDirectory) continue
      const projected = await projectDirectory({ files: params.files, dir: sessionDir.path, cwdDir: cwdDir.path })
      const session = await toAgentSession({ files: params.files, projected })
      if (session === undefined) continue
      if (wantCwd !== undefined && session.cwd !== wantCwd) continue
      sessions.push(session)
    }
  }
  // Newest activity first; a session without a usable timestamp sorts last, then by id.
  sessions.sort((a, b) => {
    const left = a.updatedAt ?? ''
    const right = b.updatedAt ?? ''
    if (left !== right) return left < right ? 1 : -1
    return a.nativeId < b.nativeId ? -1 : 1
  })
  return params.options.limit === undefined ? sessions : sessions.slice(0, params.options.limit)
}

/** A transcript window plus what the reader could not project. */
export interface GrokTranscriptRead {
  messages: readonly AgentMessage[]
  totalMessages?: number
  hasMore: boolean
  notes: readonly ProjectionNote[]
}

/**
 * Read a bounded transcript window.
 *
 * `updates.jsonl` is the authoritative ACP stream; when it is absent or empty the
 * derived `chat_history.jsonl` cache is used instead and the substitution is declared.
 *
 * @param params - File probe, session directory and read limits.
 * @returns The newest messages in ascending window order, plus whether older ones exist.
 */
export async function readGrokTranscript(params: {
  files: FileProbe
  sessionDir: string
  options: ReadTranscriptOptions
  totalMessages?: number
}): Promise<GrokTranscriptRead> {
  const cap = params.options.maxBytes ?? TRANSCRIPT_BYTES
  const notes: ProjectionNote[] = []
  let messages: readonly AgentMessage[]
  let hasMore: boolean

  const updates = await params.files.readTail(join(params.sessionDir, UPDATES_FILE), cap)
  if (updates.missing || updates.text.trim() === '') {
    notes.push({
      field: '*',
      reason:
        'updates.jsonl is absent or empty; the transcript was projected from chat_history.jsonl, a derived model-message cache rather than the authoritative ACP stream',
    })
    const chat = await params.files.readTail(join(params.sessionDir, CHAT_HISTORY_FILE), cap)
    const mapped = mapChatHistory(chat.text)
    messages = mapped.messages
    hasMore = chat.truncated || mapped.malformed > 0
  } else {
    const mapped = mapUpdates(updates.text)
    messages = mapped.messages
    hasMore = updates.truncated || mapped.malformed > 0
    if (mapped.malformed > 0) {
      notes.push({
        field: '*',
        reason: `${String(mapped.malformed)} unparsable or unrecognized record(s) in the read window were skipped`,
      })
    }
  }

  const maxMessages = params.options.maxMessages
  if (maxMessages !== undefined && messages.length > maxMessages) {
    messages = messages.slice(messages.length - maxMessages)
    hasMore = true
  }
  const indexed = messages.map((message, index) => ({ ...message, index }))
  return {
    messages: indexed,
    ...(params.totalMessages === undefined ? {} : { totalMessages: params.totalMessages }),
    hasMore,
    notes,
  }
}

/**
 * Read grok's native todo and plan-mode state.
 *
 * `plan.json` holds an ordered `todos` map; `plan_mode.json` holds the lifecycle state,
 * which has no per-item status of its own.
 *
 * @param params - File probe, session directory and the canonical session key, when known.
 * @returns The observed state, or `undefined` when the session recorded neither file.
 */
export async function readGrokNativeTasks(params: {
  files: FileProbe
  sessionDir: string
  observedIn?: SessionKey
}): Promise<NativeTaskState | undefined> {
  const planPath = join(params.sessionDir, PLAN_FILE)
  const modePath = join(params.sessionDir, PLAN_MODE_FILE)
  const planRead = await params.files.readJson<unknown>(planPath)
  const modeRead = await params.files.readJson<unknown>(modePath)
  const planMissing = planRead.ok === false && planRead.missing
  const modeMissing = modeRead.ok === false && modeRead.missing
  if (planMissing && modeMissing) return undefined

  const notes: ProjectionNote[] = []
  const fingerprint = await params.files.fingerprint(planPath)
  const updatedAt = fingerprint.mtimeMs > 0 ? new Date(fingerprint.mtimeMs).toISOString() : new Date(0).toISOString()

  let todos: readonly AgentTodo[] = []
  if (planRead.ok) {
    todos = todosFromPlan(planRead.value, updatedAt, params.observedIn)
  } else if (!planRead.missing) {
    notes.push({ field: 'todos', reason: `plan.json could not be parsed: ${planRead.error}` })
  }
  if (!planMissing) {
    notes.push({
      field: 'todos',
      reason: "grok's todo model carries no dependency edges, so every item has an empty blockedBy",
    })
  }

  let modeState: string | undefined
  if (modeRead.ok) {
    const record = asRecord(modeRead.value)
    modeState = record === undefined ? undefined : nonEmpty(record.state)
  } else if (!modeRead.missing) {
    notes.push({ field: 'plan', reason: `plan_mode.json could not be parsed: ${modeRead.error}` })
  }
  if (modeState !== undefined && modeState !== 'Active' && modeState !== 'Inactive') {
    notes.push({
      field: 'plan',
      reason: `plan_mode.json records the transient state "${modeState}", which is not a durable activity signal`,
    })
  }

  return {
    todos,
    ...(modeState === undefined ? {} : { plan: { active: modeState === 'Active', items: todos.map(todo => todo.content) } }),
    notes,
  }
}

/**
 * Deterministic id for a native todo key.
 *
 * FNV-1a over UTF-16 code units: dependency-free, stable across runs and platforms.
 *
 * @param nativeKey - The native todo id.
 * @returns An eight-character hexadecimal digest.
 */
export function stableKeyId(nativeKey: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < nativeKey.length; index += 1) {
    hash ^= nativeKey.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Read a session directory into its projected metadata. */
async function projectDirectory(params: {
  files: FileProbe
  dir: string
  cwdDir: string
}): Promise<GrokSessionDirectory> {
  const notes: ProjectionNote[] = []
  const read = await params.files.readJson<unknown>(join(params.dir, SUMMARY_FILE))
  const summary = read.ok ? parseGrokSummary(read.value) : undefined
  if (read.ok === false) {
    notes.push({
      field: '*',
      reason: read.missing
        ? 'summary.json is absent; only the directory name and its timestamps are projected'
        : `summary.json could not be parsed: ${read.error}`,
    })
  }

  let cwd = summary?.cwd
  if (cwd === undefined) {
    cwd = await decodeCwdDirName(params.cwdDir, params.files)
    if (cwd !== undefined) {
      notes.push({
        field: 'cwd',
        reason:
          'cwd recovered from the session directory name or its .cwd marker; summary.json did not carry info.cwd',
      })
    }
  }
  return {
    dir: params.dir,
    cwd,
    updatedAt: summary?.updatedAt,
    messageCount: summary?.numMessages ?? summary?.numChatMessages,
    summary,
    notes,
  }
}

/** Project one resolved directory onto `AgentSession`, or drop it when it cannot be identified. */
async function toAgentSession(params: {
  files: FileProbe
  projected: GrokSessionDirectory
}): Promise<AgentSession | undefined> {
  const { projected } = params
  const native = projected.summary?.id ?? params.files.baseName(projected.dir)
  if (native === '') return undefined
  const nativeId = nativeSessionId(native)
  const notes: ProjectionNote[] = [...projected.notes]
  const summary = projected.summary

  if (summary === undefined) {
    notes.push({ field: '*', reason: 'the session is readable only as a directory; its summary was not parsable' })
  }
  if (summary?.hidden === true) {
    notes.push({
      field: '*',
      reason: 'grok marks this session hidden (hidden: true); it is listed here but is normally not shown',
    })
  }
  if (summary?.sandboxProfile !== undefined) {
    notes.push({
      field: 'sandboxProfile',
      reason: `grok created this session with sandbox profile "${summary.sandboxProfile}" and refuses to resume it under a different explicit profile; no canonical session field carries it`,
    })
  }
  if (summary?.worktreeLabel !== undefined) {
    notes.push({
      field: 'source',
      reason: `grok labels this its own worktree "${summary.worktreeLabel}"; MutiAgent always creates the worktree itself and passes --cwd instead`,
    })
  }
  if (summary?.sourceWorkspaceDir !== undefined) {
    notes.push({
      field: 'cwd',
      reason: `grok recorded a source workspace of ${summary.sourceWorkspaceDir} for this worktree session`,
    })
  }
  if (summary?.titleIsManual === true) {
    notes.push({ field: 'title', reason: 'the title was set by a manual rename, not by automatic titling' })
  }

  const usageRead = await readUsageFile(params.files, projected.dir)
  if (usageRead.present && usageRead.usage === undefined) {
    notes.push({ field: 'usage', reason: 'usage.json is present but could not be projected' })
  }

  const title = summary?.generatedTitle ?? summary?.sessionSummary
  return {
    key: sessionKey(agentId(AGENT_ID), nativeId),
    agentId: agentId(AGENT_ID),
    nativeId,
    nativePath: projected.dir,
    ...(title === undefined ? {} : { title, titleIsNative: true }),
    ...(projected.cwd === undefined ? {} : { cwd: projected.cwd }),
    ...(summary?.gitRootDir === undefined ? {} : { repoRoot: summary.gitRootDir }),
    ...(summary?.headBranch === undefined ? {} : { branch: summary.headBranch }),
    ...(summary?.currentModelId === undefined ? {} : { model: summary.currentModelId }),
    ...(summary?.createdAt === undefined ? {} : { createdAt: summary.createdAt }),
    ...(projected.updatedAt === undefined ? {} : { updatedAt: projected.updatedAt }),
    status: summary === undefined ? 'unreadable' : 'idle',
    ...(projected.messageCount === undefined ? {} : { messageCount: projected.messageCount }),
    ...(summary?.parentSessionId === undefined ? {} : { parentNativeId: nativeSessionId(summary.parentSessionId) }),
    ...(summary?.sessionKind === undefined ? {} : { source: summary.sessionKind }),
    ...(usageRead.usage === undefined ? {} : { usage: usageRead.usage }),
    // MutiAgent-side binding state is not knowable from the native store.
    binding: { runIds: [] },
    notes,
  }
}

/** Project `usage.json` (`session` object, camelCase, cost in 1e-10 USD ticks). */
async function readUsageFile(
  files: FileProbe,
  sessionDir: string,
): Promise<{ present: boolean; usage: SessionUsage | undefined }> {
  const read = await files.readJson<unknown>(join(sessionDir, USAGE_FILE))
  if (!read.ok) return { present: !read.missing, usage: undefined }
  const record = asRecord(read.value)
  const session = record === undefined ? undefined : asRecord(record.session)
  if (session === undefined) return { present: true, usage: undefined }
  const ticks = number(session.costUsdTicks)
  const costUsd = ticks === undefined ? undefined : ticks / 10_000_000_000
  const input = number(session.inputTokens)
  const output = number(session.outputTokens)
  const cached = number(session.cachedReadTokens)
  const reasoning = number(session.reasoningTokens)
  const total = number(session.totalTokens)
  const usage: SessionUsage = {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(costUsd === undefined ? {} : { costUsd }),
  }
  return { present: true, usage: Object.keys(usage).length === 0 ? undefined : usage }
}

/** Project `plan.json`'s `todos` map, preserving file order. */
function todosFromPlan(value: unknown, updatedAt: string, observedIn?: SessionKey): readonly AgentTodo[] {
  const record = asRecord(value)
  const todos = record === undefined ? undefined : asRecord(record.todos)
  if (todos === undefined) return []
  const out: AgentTodo[] = []
  for (const [key, raw] of Object.entries(todos)) {
    const item = asRecord(raw)
    if (item === undefined) continue
    out.push({
      id: todoId(`grok-${stableKeyId(key)}`),
      content: nonEmpty(item.content) ?? key,
      status: todoStatus(item.status),
      owner: agentId(AGENT_ID),
      blockedBy: [],
      updatedAt,
      ...(observedIn === undefined ? {} : { observedIn }),
      nativeKey: key,
    })
  }
  return out
}

/** Map `updates.jsonl` lines (ACP envelopes, xAI extension envelopes, legacy raw notifications). */
function mapUpdates(text: string): { messages: readonly AgentMessage[]; malformed: number } {
  const messages: AgentMessage[] = []
  const toolNames = new Map<string, string>()
  let malformed = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const parsed = parseJsonLine(raw)
    if (!parsed.ok) {
      malformed += 1
      continue
    }
    const message = messageFromUpdate(parsed.value, toolNames)
    if (message === undefined) malformed += 1
    else messages.push(message)
  }
  return { messages, malformed }
}

/** Project one persisted ACP/xAI session update. */
function messageFromUpdate(value: unknown, toolNames: Map<string, string>): AgentMessage | undefined {
  const envelope = asRecord(value)
  if (envelope === undefined) return undefined
  const method = nonEmpty(envelope.method)
  const params = method === undefined ? envelope : asRecord(envelope.params)
  if (params === undefined) return undefined
  const update = asRecord(params.update)
  if (update === undefined) return undefined
  const nativeType = nonEmpty(update.sessionUpdate) ?? method ?? 'unknown'
  const timestamp = timestampOf(envelope, params)

  switch (nativeType) {
    case 'user_message_chunk':
      return item('user', 'user', blockText(update.content), timestamp, nativeType)
    case 'agent_message_chunk':
      return item('assistant', 'assistant', blockText(update.content), timestamp, nativeType)
    case 'agent_thought_chunk':
      return item('assistant', 'reasoning', blockText(update.content), timestamp, nativeType)
    case 'tool_call': {
      const callId = nonEmpty(update.toolCallId)
      const name = nonEmpty(update.toolName) ?? nonEmpty(update.title) ?? 'tool'
      if (callId !== undefined) toolNames.set(callId, name)
      const input = bounded(update.rawInput)
      const paths = locationPaths(update.locations)
      return {
        index: 0,
        role: 'assistant',
        kind: 'tool-call',
        nativeType,
        tool: { name, ...(input === undefined ? {} : { input }) },
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(paths.length === 0 ? {} : { paths }),
      }
    }
    case 'tool_call_update': {
      const callId = nonEmpty(update.toolCallId)
      const name = (callId === undefined ? undefined : toolNames.get(callId)) ?? 'tool'
      const output = bounded(toolContentText(update.content) ?? update.rawOutput)
      const paths = locationPaths(update.locations)
      return {
        index: 0,
        role: 'tool',
        kind: 'tool-result',
        nativeType,
        tool: { name, ...(output === undefined ? {} : { output }), failed: update.status === 'failed' },
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(paths.length === 0 ? {} : { paths }),
      }
    }
    case 'plan': {
      const entries = planEntries(update.entries)
      const text = entries.map(entry => `${entry.status}: ${entry.content}`).join('\n')
      return item('assistant', 'plan', text === '' ? undefined : text, timestamp, nativeType)
    }
    case 'current_mode_update':
      return item('system', 'plan', nonEmpty(update.modeId), timestamp, nativeType)
    default:
      return item('unknown', 'unknown', undefined, timestamp, nativeType)
  }
}

/** Map `chat_history.jsonl` lines (the derived model-message cache). */
function mapChatHistory(text: string): { messages: readonly AgentMessage[]; malformed: number } {
  const messages: AgentMessage[] = []
  let malformed = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const parsed = parseJsonLine(raw)
    const record = parsed.ok ? asRecord(parsed.value) : undefined
    if (record === undefined) {
      malformed += 1
      continue
    }
    const type = nonEmpty(record.type) ?? 'unknown'
    switch (type) {
      case 'system':
        messages.push(item('system', 'system', contentText(record.content), undefined, type))
        break
      case 'user':
        messages.push(item('user', 'user', contentText(record.content), undefined, type))
        break
      case 'assistant': {
        messages.push(item('assistant', 'assistant', contentText(record.content), undefined, type))
        const calls = Array.isArray(record.tool_calls) ? record.tool_calls : []
        for (const call of calls) {
          const entry = asRecord(call)
          if (entry === undefined) continue
          const input = bounded(entry.arguments)
          messages.push({
            index: 0,
            role: 'assistant',
            kind: 'tool-call',
            nativeType: 'assistant.tool_calls',
            tool: { name: nonEmpty(entry.name) ?? 'tool', ...(input === undefined ? {} : { input }) },
          })
        }
        break
      }
      case 'tool_result': {
        const output = bounded(contentText(record.content))
        messages.push({
          index: 0,
          role: 'tool',
          kind: 'tool-result',
          nativeType: type,
          tool: { name: 'tool', ...(output === undefined ? {} : { output }), failed: false },
        })
        break
      }
      case 'reasoning':
        messages.push(item('assistant', 'reasoning', contentText(record.content), undefined, type))
        break
      default:
        messages.push(item('unknown', 'unknown', undefined, undefined, type))
        break
    }
  }
  return { messages, malformed }
}

/** Build a plain transcript item. */
function item(
  role: AgentMessage['role'],
  kind: AgentMessage['kind'],
  text: string | undefined,
  timestamp: string | undefined,
  nativeType: string,
): AgentMessage {
  return {
    index: 0,
    role,
    kind,
    nativeType,
    ...(text === undefined ? {} : { text }),
    ...(timestamp === undefined ? {} : { timestamp }),
  }
}

/** Text of an ACP content block, which is either a string or `{type:'text', text}`. */
function blockText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const record = asRecord(value)
  return record === undefined ? undefined : nonEmpty(record.text)
}

/** Text of a chat-history `content` field, which is a string or a `ContentPart` array. */
function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  const parts = Array.isArray(value) ? value : []
  const pieces: string[] = []
  for (const part of parts) {
    const record = asRecord(part)
    const piece = record === undefined ? undefined : nonEmpty(record.text)
    if (piece !== undefined) pieces.push(piece)
  }
  return pieces.length === 0 ? undefined : pieces.join('\n')
}

/** Cap one projected field so a single record cannot dominate the window. */
function bounded(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const serialized = typeof value === 'string' ? value : safeJson(value)
  if (serialized === undefined || serialized === '') return undefined
  return serialized.length > FIELD_CHARS ? serialized.slice(0, FIELD_CHARS) : serialized
}

/** JSON text, or `undefined` when the value cannot be serialized. */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** ISO timestamp of an update, from the envelope's seconds or the `_meta` millisecond clock. */
function timestampOf(envelope: Record<string, unknown>, params: Record<string, unknown>): string | undefined {
  const meta = asRecord(params._meta)
  const millis = meta === undefined ? undefined : number(meta.agentTimestampMs)
  if (millis !== undefined && millis > 0) return new Date(millis).toISOString()
  const seconds = number(envelope.timestamp)
  if (seconds !== undefined && seconds > 0) return new Date(seconds * 1000).toISOString()
  return undefined
}

/** A non-empty string field. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A finite number field. */
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A non-negative integer field. */
function whole(value: unknown): number | undefined {
  const parsed = number(value)
  return parsed === undefined || parsed < 0 ? undefined : Math.trunc(parsed)
}

/** An RFC3339 timestamp kept verbatim, when it parses. */
function isoValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
}
