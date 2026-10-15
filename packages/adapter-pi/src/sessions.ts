/**
 * Pi's session store: discovery, the header/entry record model, branch-following
 * transcript reading, and the (absent) native task model. Everything here is
 * read-only and bounded, because the store belongs to another process that may be
 * appending to it right now (ADR-0012).
 *
 * Layout, verified against pi 1.2.0 source and binary:
 *
 *   <agent-dir>/sessions/--<flattened-cwd>--/<ISO-with-:-and-.-replaced>-<sessionId>.jsonl
 *
 * where `<agent-dir>` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, the flattened cwd is
 * `'--' + absoluteCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'`, and the root
 * is `<agent-dir>/sessions`. A session directory override (the adapter's `sessionDir`
 * setting, then `$PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in pi's `settings.json`)
 * is **not** a second root: it is the directory that directly holds the session files,
 * replacing the per-cwd subdirectory for every project, so that directory is read flat.
 *
 * Pi's own enumeration accepts any subdirectory name (not only the `--…--` shape) and,
 * with an override, reads flat only. This reader scans both the override directory and
 * the default root's subdirectories, because a machine that switched layouts keeps
 * sessions in both, and the directory name is only a hint for the cwd: the header's own
 * `cwd` field is authoritative.
 *
 * The file is a JSONL header line followed by append-only entries that form a tree.
 * A branch switch appends an entry whose `parentId` is not the previous line's `id`,
 * so the live conversation is the chain ending at the **last** line, never the file
 * order.
 *
 * @module @zorker/muti-agent-adapter-pi/sessions
 */

import { resolve as resolvePath } from 'node:path'
import {
  nativeSessionId,
  sessionKey,
  type AgentId,
  type AgentMessage,
  type AgentSession,
  type MessageKind,
  type NativeSessionId,
  type ProjectionNote,
  type SessionUsage,
} from '@zorker/muti-agent-contracts'
import {
  parseJsonLine,
  resolveHome,
  type AdapterContext,
  type ListSessionsOptions,
  type NativeTaskState,
  type ReadTranscriptOptions,
} from '@zorker/muti-agent-core'

/** Session file format version this reader was verified against. */
export const PI_SESSION_VERSION = 3

/** How many session directories a single scan will look at. */
const MAX_SCAN_DIRECTORIES = 200
/** Per-directory file cap, so one runaway project cannot starve the scan. */
const MAX_SCAN_FILES_PER_DIRECTORY = 400
/** Global file cap for one scan. */
const MAX_SCAN_FILES = 1_500
/** Cap on header probes during a by-id lookup, whose fast path is the file name. */
const MAX_HEADER_PROBES = 300
/** Bytes read to obtain the header line of a large session file. */
const HEADER_READ_BYTES = 64 * 1024
/** A file at or below this size is read whole; a larger one is read head + tail. */
const SMALL_FILE_BYTES = 256 * 1024
/** Default byte window for one transcript read. */
const DEFAULT_TRANSCRIPT_BYTES = 512 * 1024
/** Lower bound on a transcript window, so a caller cannot ask for an unusable read. */
const MIN_TRANSCRIPT_BYTES = 64 * 1024
/** Upper bound on a transcript window; the file probe caps reads too. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
/** Characters of a raw native entry retained for diagnostics. */
const MAX_RAW_CHARS = 4_000

/**
 * Adapter settings Pi accepts under `AdapterRuntimeConfig.settings`. Unknown keys
 * are ignored rather than rejected, so a newer host can carry settings this adapter
 * version does not know yet.
 */
export interface PiAdapterSettings {
  /**
   * Session directory override. Pi treats this as the one directory that directly
   * holds session files for every project, replacing the per-cwd subdirectory.
   */
  sessionDir?: string
  /**
   * Whether a credential supplied by the host environment is forwarded to a run.
   * Off by default: ADR-0014 makes credential passthrough an explicit per-adapter
   * opt-in, and the `minimal`/`inherit-agent` env derivation filters provider keys.
   */
  inheritCredentialEnv: boolean
}

/**
 * Validate this adapter's settings.
 *
 * @param settings - Raw settings from the host configuration.
 * @returns The validated settings, with defaults applied.
 */
export function parsePiSettings(settings: Readonly<Record<string, unknown>>): PiAdapterSettings {
  const rawDir = settings.sessionDir
  const rawInherit = settings.inheritCredentialEnv
  const sessionDir = typeof rawDir === 'string' && rawDir.trim() !== '' ? rawDir.trim() : undefined
  return {
    ...(sessionDir === undefined ? {} : { sessionDir }),
    inheritCredentialEnv: typeof rawInherit === 'boolean' ? rawInherit : false,
  }
}

/** Where a machine keeps Pi's configuration and sessions. */
export interface PiStoreLayout {
  /** Resolved agent config directory (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
  agentDir: string
  /** Root holding one directory per project, plus any stray session files. */
  defaultSessionsRoot: string
  /** Flat session directory in force, when the adapter, the host or pi configured one. */
  sessionDirOverride?: string
  /** Whether the override came from the adapter's own `sessionDir` setting. */
  sessionsDirFromSetting: boolean
  /** Whether the agent directory came from the environment rather than the default. */
  agentDirFromEnv: boolean
  /** `auth.json`, for display and read-only status inspection. */
  credentialPath: string
  /** `settings.json`, read for `sessionDir`. */
  settingsPath: string
}

/**
 * Resolve the store layout from the adapter settings, the host environment and pi's
 * own settings file, in that precedence order.
 *
 * @param ctx - Adapter context (configuration and read-only file helpers).
 * @param env - Host environment; injected for testability.
 * @returns The resolved layout.
 */
export async function resolvePiStore(
  ctx: AdapterContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiStoreLayout> {
  const settings = parsePiSettings(ctx.config.settings)
  const home = resolveHome({
    ...(ctx.config.homeDir === undefined ? {} : { override: ctx.config.homeDir }),
    envName: 'PI_CODING_AGENT_DIR',
    defaultName: '.pi/agent',
    env,
  })
  const agentDir = ctx.files.resolvePath(home.path)
  const settingsPath = `${agentDir}/settings.json`
  const envDir = env.PI_CODING_AGENT_SESSION_DIR
  const override =
    settings.sessionDir ??
    (envDir === undefined || envDir.trim() === '' ? undefined : envDir.trim()) ??
    (await readSettingsSessionDir(ctx, settingsPath))
  return {
    agentDir,
    defaultSessionsRoot: `${agentDir}/sessions`,
    ...(override === undefined ? {} : { sessionDirOverride: ctx.files.resolvePath(override) }),
    sessionsDirFromSetting: settings.sessionDir !== undefined,
    agentDirFromEnv: home.fromEnv,
    credentialPath: `${agentDir}/auth.json`,
    settingsPath,
  }
}

/** Read `sessionDir` from pi's own settings.json, tolerating every failure. */
async function readSettingsSessionDir(ctx: AdapterContext, settingsPath: string): Promise<string | undefined> {
  const parsed = await ctx.files.readJson<unknown>(settingsPath)
  if (!parsed.ok || !isRecord(parsed.value)) return undefined
  return readString(parsed.value, 'sessionDir')
}

// ---------------------------------------------------------------------------
// Native record narrowing. Pi's files are foreign JSON: every field is read
// through these guards, so a format change degrades a field, never a crash.
// ---------------------------------------------------------------------------

/**
 * Whether a decoded JSON value is a plain object.
 *
 * @param value - Value to test.
 * @returns `true` for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a string field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent or not a string.
 */
export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read a finite number field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent or not a finite number.
 */
export function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read a boolean field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent or not a boolean.
 */
export function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Read an object field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The nested object, or `undefined`.
 */
export function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key]
  return isRecord(value) ? value : undefined
}

/**
 * Read an array field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The array, or `undefined`.
 */
export function readArray(source: Record<string, unknown>, key: string): readonly unknown[] | undefined {
  const value = source[key]
  return Array.isArray(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Store records
// ---------------------------------------------------------------------------

/** The first line of a Pi session file. */
export interface PiSessionHeader {
  /** Session id, verbatim. */
  id: string
  /** Creation time, verbatim ISO 8601. */
  timestamp: string
  /** Absolute working directory the session was started in; empty on very old files. */
  cwd: string
  /** Path of the session this one was forked from, when it was. */
  parentSession?: string
  /** Native format version; absent on v1 files. */
  version?: number
}

/**
 * Parse a session header.
 *
 * @param value - Decoded JSON of the first line.
 * @returns The header, or `undefined` when the line is not a session header.
 */
export function readPiSessionHeader(value: unknown): PiSessionHeader | undefined {
  if (!isRecord(value) || readString(value, 'type') !== 'session') return undefined
  const id = readString(value, 'id')
  if (id === undefined || id === '') return undefined
  const timestamp = readString(value, 'timestamp')
  const cwd = readString(value, 'cwd')
  const version = readNumber(value, 'version')
  const parentSession = readString(value, 'parentSession')
  return {
    id,
    timestamp: timestamp ?? '',
    cwd: cwd ?? '',
    ...(version === undefined ? {} : { version: Math.trunc(version) }),
    ...(parentSession === undefined || parentSession === '' ? {} : { parentSession }),
  }
}

/** One parsed session entry, in file order, with its bounded raw line. */
export interface PiNativeEntry {
  /** Entry id, verbatim. */
  id: string
  /** Parent entry id; `null` at a branch root or for the first entry. */
  parentId: string | null
  /** Entry timestamp, verbatim ISO 8601 (empty when the file omits it). */
  timestamp: string
  /** Entry type, verbatim. */
  type: string
  /** Decoded record, for field access. */
  record: Record<string, unknown>
  /** Raw JSONL line, truncated for diagnostics only. */
  raw: string
}

/**
 * Parse one session entry.
 *
 * @param value - Decoded JSON of a non-header line.
 * @param raw - The raw line, retained bounded for `unknown` projections.
 * @returns The entry, or `undefined` when the line is not an entry.
 */
export function readPiEntry(value: unknown, raw: string): PiNativeEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = readString(value, 'id')
  const type = readString(value, 'type')
  if (id === undefined || id === '' || type === undefined || type === '') return undefined
  const parentId = value.parentId
  return {
    id,
    parentId: typeof parentId === 'string' ? parentId : null,
    timestamp: readString(value, 'timestamp') ?? '',
    type,
    record: value,
    raw: raw.length > MAX_RAW_CHARS ? raw.slice(0, MAX_RAW_CHARS) : raw,
  }
}

/** One bounded read of a session file. */
export interface PiSessionView {
  /** Session header, when the read window contained it. */
  header?: PiSessionHeader
  /** Entries in the read window, in file order. */
  entries: readonly PiNativeEntry[]
  /** Whether earlier file content was outside the window. */
  windowTruncated: boolean
  /** Whether the window dropped a leading partial line. */
  droppedPartialLine: boolean
  /** File size at read time, or `-1` when absent. */
  size: number
  /** File modification time in milliseconds. */
  mtimeMs: number
  /** JSON lines in the window that did not parse as a header or an entry. */
  malformed: number
  /** Whether the file was absent. */
  missing: boolean
  /** Declared gaps produced while reading. */
  notes: readonly ProjectionNote[]
}

interface WindowAccumulator {
  header: PiSessionHeader | undefined
  sawFirstLine: boolean
  entries: PiNativeEntry[]
  malformed: number
}

/**
 * Read a bounded view of one session file: the whole file when it is small, else the
 * header plus a tail window. Read-only, and capped so a large session is never read
 * into memory whole.
 *
 * @param ctx - Adapter context.
 * @param path - Absolute session file path.
 * @param maxBytes - Desired window size.
 * @returns The view; `missing: true` when the file is gone.
 */
export async function readPiSessionView(
  ctx: AdapterContext,
  path: string,
  maxBytes: number,
): Promise<PiSessionView> {
  const cap = Math.max(MIN_TRANSCRIPT_BYTES, Math.min(maxBytes, MAX_TRANSCRIPT_BYTES))
  const fingerprint = await ctx.files.fingerprint(path)
  if (fingerprint.size < 0) return missingView(-1, 0)

  const notes: ProjectionNote[] = []
  const accumulator: WindowAccumulator = { header: undefined, sawFirstLine: false, entries: [], malformed: 0 }
  let windowTruncated: boolean
  let droppedPartialLine = false

  if (fingerprint.size <= cap) {
    const whole = await ctx.files.readHead(path, Math.max(1, fingerprint.size))
    if (whole.missing) return missingView(fingerprint.size, fingerprint.mtimeMs)
    windowTruncated = whole.truncated
    accumulateWindow(whole.text, accumulator)
  } else {
    // The header is the first line and the fold window is the tail. Reading the head
    // first keeps the authoritative cwd available even for a huge session.
    const head = await ctx.files.readHead(path, HEADER_READ_BYTES)
    const headerLine = completeFirstLine(head.text)
    if (headerLine === undefined) {
      notes.push({
        field: 'cwd',
        reason: `the session header did not fit in ${HEADER_READ_BYTES} bytes, so the cwd is unavailable`,
      })
    } else {
      accumulateWindow(headerLine, accumulator)
    }
    const tail = await ctx.files.readTail(path, cap)
    if (tail.missing) return missingView(fingerprint.size, fingerprint.mtimeMs)
    droppedPartialLine = tail.droppedPartialLine
    windowTruncated = true
    // The tail starts on a record boundary and never holds the header, so its first
    // line is an entry: the accumulator is advanced past its header phase.
    accumulator.sawFirstLine = true
    for (const line of tail.text.split('\n')) {
      if (line.trim() === '') continue
      const parsed = parseJsonLine(line)
      if (!parsed.ok) {
        accumulator.malformed += 1
        continue
      }
      const entry = readPiEntry(parsed.value, line)
      if (entry === undefined) accumulator.malformed += 1
      else accumulator.entries.push(entry)
    }
  }

  return {
    ...(accumulator.header === undefined ? {} : { header: accumulator.header }),
    entries: accumulator.entries,
    windowTruncated,
    droppedPartialLine,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    malformed: accumulator.malformed,
    missing: false,
    notes,
  }
}

/**
 * Read only the header of a session file, for by-id lookups and resume checks.
 *
 * @param ctx - Adapter context.
 * @param path - Absolute session file path.
 * @returns The header, or `undefined` when the first line is not a complete header.
 */
export async function readPiSessionHeaderAt(ctx: AdapterContext, path: string): Promise<PiSessionHeader | undefined> {
  const head = await ctx.files.readHead(path, HEADER_READ_BYTES)
  if (head.missing) return undefined
  const firstLine = completeFirstLine(head.text)
  if (firstLine === undefined) return undefined
  const parsed = parseJsonLine(firstLine)
  return parsed.ok ? readPiSessionHeader(parsed.value) : undefined
}

function missingView(size: number, mtimeMs: number): PiSessionView {
  return {
    entries: [],
    windowTruncated: false,
    droppedPartialLine: false,
    size,
    mtimeMs,
    malformed: 0,
    missing: true,
    notes: [{ field: '*', reason: 'the session file is absent' }],
  }
}

/** Parse a block of JSONL text whose first line may be the session header. */
function accumulateWindow(text: string, accumulator: WindowAccumulator): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      accumulator.malformed += 1
      continue
    }
    if (!accumulator.sawFirstLine) {
      accumulator.sawFirstLine = true
      const header = readPiSessionHeader(parsed.value)
      if (header === undefined) {
        accumulator.malformed += 1
        continue
      }
      accumulator.header = header
      continue
    }
    const entry = readPiEntry(parsed.value, line)
    if (entry === undefined) accumulator.malformed += 1
    else accumulator.entries.push(entry)
  }
}

/**
 * The first complete line of a text window.
 *
 * @param text - Text that may end mid-line.
 * @returns The first line without its terminator, or `undefined` when none is complete.
 */
function completeFirstLine(text: string): string | undefined {
  const newline = text.indexOf('\n')
  return newline === -1 ? undefined : text.slice(0, newline)
}

// ---------------------------------------------------------------------------
// Directory-name encoding
// ---------------------------------------------------------------------------

/**
 * Pi's flattened-cwd directory name for an absolute cwd.
 *
 * @param cwd - Working directory; resolved first.
 * @returns The directory name, e.g. `--Volumes-Net-Repo--`.
 */
export function encodeCwdDirName(cwd: string): string {
  const resolved = resolvePath(cwd)
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/**
 * Best-effort decode of a flattened-cwd directory name.
 *
 * The encoding is lossy: a real `-` in a path is indistinguishable from a separator,
 * and a Windows drive colon is flattened too. This is only ever a hint — the header's
 * own `cwd` field is authoritative.
 *
 * @param name - Directory entry name.
 * @returns The candidate absolute path, or `undefined` when the name is not encoded.
 */
export function decodeCwdDirName(name: string): string | undefined {
  if (name.length < 4 || !name.startsWith('--') || !name.endsWith('--')) return undefined
  const inner = name.slice(2, -2)
  return inner === '' ? undefined : `/${inner.replace(/-/g, '/')}`
}

// ---------------------------------------------------------------------------
// Folding and branch walking
// ---------------------------------------------------------------------------

/** Entry types this reader models, directly or as declared state. */
const KNOWN_ENTRY_TYPES: readonly string[] = [
  'message',
  'session_info',
  'model_change',
  'thinking_level_change',
  'usage',
  'context_edit',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
]

/** A session's state as folded from one read window. */
export interface PiSessionFold {
  /** Latest `session_info` name in the window; an empty name clears it. */
  title?: string
  /** Latest `model_change` model id, else the last assistant message's model. */
  model?: string
  /** Usage summed over the window (assistant messages and `usage` entries). */
  usage?: SessionUsage
  /** `message` entries seen in the window. */
  messageCount: number
  /** Latest user/assistant message time in the window, ISO 8601. */
  lastMessageAt?: string
  /** Records the canonical projection has no field for. */
  images: number
  /** `usage` entries in the window (cache-warming accounting). */
  usageEntries: number
  /** `context_edit` entries in the window. */
  contextEdits: number
  /** `compaction` entries in the window. */
  compactions: number
  /** Cache-write tokens seen, which `SessionUsage` cannot carry. */
  cacheWriteTokens: number
  /** Entry types this reader does not model, distinct, at most a handful. */
  unknownEntryTypes: readonly string[]
}

/**
 * Fold a read window into session state.
 *
 * @param entries - Entries in file order.
 * @returns The folded state.
 */
export function foldPiEntries(entries: readonly PiNativeEntry[]): PiSessionFold {
  const fold: PiSessionFold = {
    messageCount: 0,
    images: 0,
    usageEntries: 0,
    contextEdits: 0,
    compactions: 0,
    cacheWriteTokens: 0,
    unknownEntryTypes: [],
  }
  const totals: MutableUsage = {}
  const unknown: string[] = []
  let sawUsage = false

  for (const entry of entries) {
    switch (entry.type) {
      case 'message': {
        fold.messageCount += 1
        const message = readRecord(entry.record, 'message')
        if (message === undefined) break
        const activity = messageActivity(message, entry.timestamp)
        if (activity !== undefined && (fold.lastMessageAt === undefined || activity > fold.lastMessageAt)) {
          fold.lastMessageAt = activity
        }
        fold.images += countImages(message)
        if (readString(message, 'role') === 'assistant') {
          const model = readString(message, 'model')
          if (model !== undefined && model !== '') fold.model = model
          const usage = readRecord(message, 'usage')
          if (usage !== undefined) {
            sawUsage = true
            addUsage(totals, usage)
          }
        }
        break
      }
      case 'session_info': {
        const name = readString(entry.record, 'name')
        if (name === undefined) break
        const trimmed = name.trim()
        // The latest session_info wins, and an empty name clears the title.
        if (trimmed === '') delete fold.title
        else fold.title = trimmed
        break
      }
      case 'model_change': {
        const modelId = readString(entry.record, 'modelId')
        if (modelId !== undefined && modelId !== '') fold.model = modelId
        break
      }
      case 'usage': {
        fold.usageEntries += 1
        const usage = readRecord(entry.record, 'usage')
        if (usage !== undefined) {
          sawUsage = true
          addUsage(totals, usage)
        }
        break
      }
      case 'context_edit':
        fold.contextEdits += 1
        break
      case 'compaction':
        fold.compactions += 1
        break
      default:
        // A format revision must degrade into a visible gap, not a silent drop.
        if (!KNOWN_ENTRY_TYPES.includes(entry.type) && !unknown.includes(entry.type)) unknown.push(entry.type)
        break
    }
  }

  fold.unknownEntryTypes = unknown
  fold.cacheWriteTokens = totals.cacheWrite ?? 0
  if (sawUsage) {
    const usage: SessionUsage = {}
    if (totals.input !== undefined) usage.inputTokens = totals.input
    if (totals.output !== undefined) usage.outputTokens = totals.output
    if (totals.cacheRead !== undefined) usage.cachedInputTokens = totals.cacheRead
    if (totals.reasoning !== undefined) usage.reasoningTokens = totals.reasoning
    if (totals.totalTokens !== undefined) usage.totalTokens = totals.totalTokens
    if (totals.costUsd !== undefined) usage.costUsd = totals.costUsd
    fold.usage = usage
  }
  return fold
}

interface MutableUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  totalTokens?: number
  costUsd?: number
}

/** Sum a native `Usage` record into running totals. */
function addUsage(totals: MutableUsage, usage: Record<string, unknown>): void {
  const cost = readRecord(usage, 'cost')
  const costUsd = cost === undefined ? undefined : readNumber(cost, 'total')
  totals.input = (totals.input ?? 0) + (readNumber(usage, 'input') ?? 0)
  totals.output = (totals.output ?? 0) + (readNumber(usage, 'output') ?? 0)
  totals.cacheRead = (totals.cacheRead ?? 0) + (readNumber(usage, 'cacheRead') ?? 0)
  totals.cacheWrite = (totals.cacheWrite ?? 0) + (readNumber(usage, 'cacheWrite') ?? 0)
  totals.totalTokens = (totals.totalTokens ?? 0) + (readNumber(usage, 'totalTokens') ?? 0)
  const reasoning = readNumber(usage, 'reasoning')
  if (reasoning !== undefined) totals.reasoning = (totals.reasoning ?? 0) + reasoning
  if (costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + costUsd
}

/** The ISO 8601 activity time of a message record. */
function messageActivity(message: Record<string, unknown>, fallback: string): string | undefined {
  const role = readString(message, 'role')
  if (role !== 'user' && role !== 'assistant') return undefined
  const native = readNumber(message, 'timestamp')
  if (native !== undefined) {
    const iso = new Date(native).toISOString()
    return Number.isNaN(new Date(iso).getTime()) ? undefined : iso
  }
  return isoOrUndefined(fallback)
}

/** Count image blocks anywhere in a message's content. */
function countImages(message: Record<string, unknown>): number {
  const content = message.content
  if (!Array.isArray(content)) return 0
  let images = 0
  for (const block of content) {
    if (isRecord(block) && readString(block, 'type') === 'image') images += 1
  }
  return images
}

/** An ISO 8601 time for a native timestamp string, when it is parseable. */
function isoOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

/** The live conversation of a session file. */
export interface PiBranch {
  /** Entries on the branch that ends at the last line, in conversation order. */
  chain: readonly PiNativeEntry[]
  /** Entries in the window that belong to abandoned branches. */
  abandoned: number
  /** Whether the chain start is outside the read window or a parent link is missing. */
  truncated: boolean
}

/**
 * Walk `parentId` links from the last entry to produce the live branch.
 *
 * The store is append-only and the last line is where the next entry attaches, so the
 * last entry is the live leaf; everything reachable from it is the conversation, and
 * everything else is an abandoned branch.
 *
 * @param view - A read window.
 * @returns The chain, the abandoned count, and whether the chain start is unknown.
 */
export function piBranch(view: PiSessionView): PiBranch {
  const byId = new Map<string, PiNativeEntry>()
  for (const entry of view.entries) byId.set(entry.id, entry)
  const leaf = view.entries[view.entries.length - 1]
  if (leaf === undefined) return { chain: [], abandoned: 0, truncated: view.windowTruncated }

  const chain: PiNativeEntry[] = []
  const visited = new Set<string>()
  let cursor: PiNativeEntry | undefined = leaf
  while (cursor !== undefined) {
    // A corrupt file could contain a cycle; a bounded walk is the one safe answer.
    if (visited.has(cursor.id)) break
    visited.add(cursor.id)
    chain.push(cursor)
    if (cursor.parentId === null) break
    cursor = byId.get(cursor.parentId)
  }
  chain.reverse()
  const root = chain[0]
  const truncated = view.windowTruncated || (root !== undefined && root.parentId !== null)
  return { chain, abandoned: view.entries.length - chain.length, truncated }
}

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

/** A projected message, before the reader assigns its window index. */
export interface PiProjectedMessage {
  /** Entry id, or a derived `entryId:blockIndex` for a multi-block entry. */
  id?: string
  role: AgentMessage['role']
  kind: MessageKind
  text?: string
  timestamp?: string
  tool?: { name: string; input?: string; output?: string; failed?: boolean }
  nativeType?: string
}

/** Counters a projection run accumulates, so the reader can declare what it dropped. */
export interface PiProjectionCounters {
  /** Image blocks seen, which the canonical message has no field for. */
  images: number
  /** Content block types this adapter does not model. */
  unknownBlocks: number
  /** Message roles this adapter does not model. */
  unknownRoles: number
}

/**
 * Allocate zeroed projection counters.
 *
 * @returns Fresh counters for one projection run.
 */
export function projectionCounters(): PiProjectionCounters {
  return { images: 0, unknownBlocks: 0, unknownRoles: 0 }
}

/**
 * Project one entry into canonical messages, unwrapping pi's `AgentMessage` shape.
 *
 * Pi's content blocks are `text`, `thinking`, `toolCall` and `image`, and a tool result
 * is its own message with role `toolResult`; an assistant entry therefore expands into
 * one message per content block. Images and unknown block types are counted for the
 * caller's notes instead of being invented into text.
 *
 * @param entry - A session entry.
 * @param counters - Accumulator for what this projection cannot carry.
 * @returns Projected messages in block order; empty for state-only entries.
 */
export function projectPiEntry(
  entry: PiNativeEntry,
  counters: PiProjectionCounters,
): readonly PiProjectedMessage[] {
  switch (entry.type) {
    case 'message':
      return projectMessageEntry(entry, counters)
    case 'custom_message':
      return projectCustomMessage(entry, counters)
    case 'compaction':
      return projectSummary(entry, 'compaction', readString(entry.record, 'summary'), counters)
    case 'branch_summary':
      return projectSummary(entry, 'branch_summary', readString(entry.record, 'summary'), counters)
    default:
      // context_edit, thinking_level_change, model_change, usage, label, session_info
      // and any future entry type carry state or context bookkeeping, not conversation
      // content; the caller notes the ones with projection consequences.
      return []
  }
}

function projectMessageEntry(
  entry: PiNativeEntry,
  counters: PiProjectionCounters,
): readonly PiProjectedMessage[] {
  const message = readRecord(entry.record, 'message')
  if (message === undefined) return []
  const timestamp = messageActivity(message, entry.timestamp)
  const nativeType = 'message'

  switch (readString(message, 'role') ?? '') {
    case 'user': {
      const text = projectUserContent(message, counters)
      return [{ role: 'user', kind: 'user', ...spreadText(text), ...spreadTime(timestamp), nativeType }]
    }
    case 'assistant': {
      const content = readArray(message, 'content')
      if (content === undefined) {
        const text = readString(message, 'content')
        return text === undefined
          ? []
          : [{ role: 'assistant', kind: 'assistant', text, ...spreadTime(timestamp), nativeType }]
      }
      return projectAssistantBlocks(content, entry, counters).map(item => ({
        ...item,
        ...spreadTime(timestamp),
        nativeType,
      }))
    }
    case 'toolResult': {
      const output = projectToolResultContent(message, counters)
      const toolCallId = readString(message, 'toolCallId')
      const failed = readBoolean(message, 'isError') === true
      return [
        {
          role: 'tool',
          kind: 'tool-result',
          ...(toolCallId === undefined ? {} : { id: toolCallId }),
          ...spreadText(output),
          ...spreadTime(timestamp),
          nativeType,
          tool: {
            name: readString(message, 'toolName') ?? 'tool',
            ...(output === undefined ? {} : { output }),
            ...(failed ? { failed: true } : {}),
          },
        },
      ]
    }
    case 'bashExecution': {
      const output = readString(message, 'output')
      const command = readString(message, 'command')
      const exitCode = readNumber(message, 'exitCode')
      return [
        {
          role: 'tool',
          kind: 'tool-result',
          ...spreadText(output),
          ...spreadTime(timestamp),
          nativeType,
          tool: {
            name: 'bash',
            ...(command === undefined ? {} : { input: command }),
            ...(output === undefined ? {} : { output }),
            ...(exitCode === undefined || exitCode === 0 ? {} : { failed: true }),
          },
        },
      ]
    }
    case 'custom':
      return projectCustomMessage(entry, counters, message)
    case 'branchSummary':
      return projectSummary(entry, 'branch_summary', readString(message, 'summary'), counters)
    case 'compactionSummary':
      return projectSummary(entry, 'compaction', readString(message, 'summary'), counters)
    default: {
      counters.unknownRoles += 1
      const text = typeof message.content === 'string' ? message.content : undefined
      return [{ role: 'unknown', kind: 'unknown', ...spreadText(text), ...spreadTime(timestamp), nativeType }]
    }
  }
}

function projectAssistantBlocks(
  content: readonly unknown[],
  entry: PiNativeEntry,
  counters: PiProjectionCounters,
): readonly PiProjectedMessage[] {
  const items: PiProjectedMessage[] = []
  const multi = content.length > 1
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]
    if (!isRecord(block)) {
      counters.unknownBlocks += 1
      continue
    }
    const id = multi ? `${entry.id}:${index}` : entry.id
    switch (readString(block, 'type')) {
      case 'text': {
        const text = readString(block, 'text')
        if (text !== undefined && text !== '') items.push({ id, role: 'assistant', kind: 'assistant', text })
        break
      }
      case 'thinking': {
        const text = readString(block, 'thinking')
        if (text !== undefined && text !== '') items.push({ id, role: 'assistant', kind: 'reasoning', text })
        break
      }
      case 'toolCall': {
        const args = block.arguments
        items.push({
          id,
          role: 'assistant',
          kind: 'tool-call',
          tool: {
            name: readString(block, 'name') ?? 'tool',
            ...(args === undefined ? {} : { input: stringifyBounded(args) }),
          },
        })
        break
      }
      case 'image':
        counters.images += 1
        break
      default:
        counters.unknownBlocks += 1
        break
    }
  }
  return items
}

function projectUserContent(message: Record<string, unknown>, counters: PiProjectionCounters): string | undefined {
  const content = message.content
  if (typeof content === 'string') return content
  return projectTextBlocks(content, counters)
}

function projectToolResultContent(
  message: Record<string, unknown>,
  counters: PiProjectionCounters,
): string | undefined {
  const content = message.content
  if (typeof content === 'string') return content
  return projectTextBlocks(content, counters)
}

/** Join the text blocks of a content array, counting what is dropped. */
function projectTextBlocks(content: unknown, counters: PiProjectionCounters): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) {
      counters.unknownBlocks += 1
      continue
    }
    const type = readString(block, 'type')
    if (type === 'text') {
      const text = readString(block, 'text')
      if (text !== undefined) parts.push(text)
    } else if (type === 'image') counters.images += 1
    else counters.unknownBlocks += 1
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function projectCustomMessage(
  entry: PiNativeEntry,
  counters: PiProjectionCounters,
  message?: Record<string, unknown>,
): readonly PiProjectedMessage[] {
  const source = message ?? entry.record
  const content = source.content
  const text = typeof content === 'string' ? content : projectTextBlocks(content, counters)
  if (text === undefined || text === '') return []
  // Pi renders a displayed custom message like a user turn, and injects it as one.
  const display = readBoolean(source, 'display') === true
  const customType = readString(source, 'customType') ?? readString(entry.record, 'customType')
  return [
    {
      id: entry.id,
      role: display ? 'user' : 'system',
      kind: display ? 'user' : 'system',
      text,
      nativeType: customType ?? 'custom_message',
      ...spreadTime(isoOrUndefined(entry.timestamp)),
    },
  ]
}

function projectSummary(
  entry: PiNativeEntry,
  nativeType: string,
  summary: string | undefined,
  counters: PiProjectionCounters,
): readonly PiProjectedMessage[] {
  if (summary === undefined || summary === '') {
    counters.unknownBlocks += 1
    return []
  }
  return [
    {
      id: entry.id,
      role: 'system',
      kind: 'system',
      text: summary,
      nativeType,
      ...spreadTime(isoOrUndefined(entry.timestamp)),
    },
  ]
}

/** Serialize a native value for a canonical string field, bounded. */
function stringifyBounded(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = '<unserializable>'
  }
  return text.length > MAX_RAW_CHARS ? text.slice(0, MAX_RAW_CHARS) : text
}

function spreadText(text: string | undefined): { text?: string } {
  return text === undefined ? {} : { text }
}

function spreadTime(timestamp: string | undefined): { timestamp?: string } {
  return timestamp === undefined ? {} : { timestamp }
}

// ---------------------------------------------------------------------------
// Discovery and reading
// ---------------------------------------------------------------------------

/** One directory level of a pi store: session files and/or project subdirectories. */
interface ScanRoot {
  /** Directory to read. */
  path: string
  /** Fresh scan of `.jsonl` files directly in this directory. */
  scanFiles: boolean
  /** Whether subdirectories are project directories to read one level into. */
  scanSubdirectories: boolean
}

/** The roots a scan reads: the override directory first, then pi's default root. */
function scanRoots(layout: PiStoreLayout): readonly ScanRoot[] {
  const roots: ScanRoot[] = []
  if (layout.sessionDirOverride !== undefined) {
    // An override holds session files for every project; it is read for subdirectories
    // too, because an override may point at an otherwise default-shaped root.
    roots.push({ path: layout.sessionDirOverride, scanFiles: true, scanSubdirectories: true })
  }
  // A dedupe guard: an override that names the default root must not double-scan it.
  if (layout.sessionDirOverride !== layout.defaultSessionsRoot) {
    roots.push({ path: layout.defaultSessionsRoot, scanFiles: true, scanSubdirectories: true })
  }
  return roots
}

/**
 * Whether a caller's signal asked to stop.
 *
 * @param signal - Caller signal, when one was supplied.
 * @returns `true` only once the signal has aborted.
 */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/**
 * Enumerate Pi's sessions.
 *
 * The directory name is only a hint: the header's own `cwd` is authoritative, so a
 * disagreement (or an unreadable header) is declared as a projection note rather than
 * silently resolving to the lossy decode.
 *
 * @param ctx - Adapter context.
 * @param agent - This adapter's canonical agent id.
 * @param options - Cwd filter, limit and cancellation.
 * @param env - Environment to resolve the store from; defaults to the host's.
 * @returns Sessions, newest first, bounded by the scan caps.
 */
export async function listPiSessions(
  ctx: AdapterContext,
  agent: AgentId,
  options: ListSessionsOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly AgentSession[]> {
  const layout = await resolvePiStore(ctx, env)
  const limit = options.limit === undefined || options.limit <= 0 ? Number.POSITIVE_INFINITY : options.limit
  const wantedCwd = options.cwd === undefined ? undefined : resolvePath(options.cwd)
  const sessions: AgentSession[] = []
  const scanNotes: ProjectionNote[] = []
  let filesSeen = 0
  let directoriesSeen = 0
  let scanStopped = false

  for (const root of scanRoots(layout)) {
    if (scanStopped || sessions.length >= limit) break
    if (!(await ctx.files.isDirectory(root.path))) continue
    const entries = await ctx.files.listDir(root.path)
    if (root.scanFiles) {
      for (const entry of entries) {
        if (aborted(options.signal) || sessions.length >= limit) break
        if (!entry.isFile || !isSessionFileName(entry.name)) continue
        if (filesSeen >= MAX_SCAN_FILES) {
          scanNotes.push({ field: 'sessions', reason: `the scan stopped after ${MAX_SCAN_FILES} session files` })
          scanStopped = true
          break
        }
        filesSeen += 1
        // A file directly in the root has no directory-name hint for its cwd.
        const session = await projectSession(ctx, agent, undefined, entry.path, entry.mtimeMs, wantedCwd)
        if (session !== undefined) sessions.push(session)
      }
    }
    if (!root.scanSubdirectories || scanStopped) continue
    for (const directory of entries) {
      if (scanStopped || aborted(options.signal) || sessions.length >= limit) break
      if (!directory.isDirectory) continue
      if (directoriesSeen >= MAX_SCAN_DIRECTORIES) {
        scanNotes.push({
          field: 'sessions',
          reason: `only the ${MAX_SCAN_DIRECTORIES} most recently touched session directories were scanned`,
        })
        scanStopped = true
        break
      }
      if (filesSeen >= MAX_SCAN_FILES) {
        scanNotes.push({ field: 'sessions', reason: `the scan stopped after ${MAX_SCAN_FILES} session files` })
        scanStopped = true
        break
      }
      directoriesSeen += 1
      const files = (await ctx.files.listDir(directory.path)).filter(
        file => file.isFile && isSessionFileName(file.name),
      )
      let filesHere = 0
      for (const file of files) {
        if (aborted(options.signal) || sessions.length >= limit) break
        if (filesSeen >= MAX_SCAN_FILES) {
          scanNotes.push({ field: 'sessions', reason: `the scan stopped after ${MAX_SCAN_FILES} session files` })
          scanStopped = true
          break
        }
        if (filesHere >= MAX_SCAN_FILES_PER_DIRECTORY) {
          scanNotes.push({
            field: 'sessions',
            reason: `only the ${MAX_SCAN_FILES_PER_DIRECTORY} most recent files of ${directory.name} were scanned`,
          })
          break
        }
        filesHere += 1
        filesSeen += 1
        const session = await projectSession(ctx, agent, directory.name, file.path, file.mtimeMs, wantedCwd)
        if (session !== undefined) sessions.push(session)
      }
    }
  }

  sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  if (scanNotes.length === 0) return sessions
  return sessions.map((session, index) =>
    index === 0 ? { ...session, notes: [...session.notes, ...scanNotes] } : session,
  )
}

/** Project one session file onto `AgentSession`. */
async function projectSession(
  ctx: AdapterContext,
  agent: AgentId,
  directoryName: string | undefined,
  path: string,
  mtimeMs: number,
  wantedCwd: string | undefined,
): Promise<AgentSession | undefined> {
  const view = await readPiSessionView(ctx, path, SMALL_FILE_BYTES)
  if (view.missing) return undefined
  const notes: ProjectionNote[] = [...view.notes]
  const decoded = directoryName === undefined ? undefined : decodeCwdDirName(directoryName)
  const mtimeIso = new Date(mtimeMs).toISOString()
  const header = view.header

  if (header === undefined) {
    const derivedId = idFromFileName(ctx.files.baseName(path))
    if (derivedId === undefined) {
      ctx.log.debug('skipping a session file with no readable header and no id in its name', { path })
      return undefined
    }
    notes.push({
      field: '*',
      reason: 'the session header was unreadable; the id came from the file name and no metadata is available',
    })
    return {
      key: sessionKey(agent, nativeSessionId(derivedId)),
      agentId: agent,
      nativeId: nativeSessionId(derivedId),
      nativePath: path,
      status: 'unreadable',
      ...(decoded === undefined ? {} : { cwd: decoded }),
      updatedAt: mtimeIso,
      binding: { runIds: [] },
      notes,
    }
  }

  const headerCwd = header.cwd === '' ? undefined : header.cwd
  const cwd = headerCwd ?? decoded
  if (decoded !== undefined && headerCwd !== undefined && decoded !== headerCwd) {
    notes.push({
      field: 'cwd',
      reason:
        `the directory name decodes to ${decoded} but the header records ${headerCwd}; ` +
        `pi would name this session's directory ${encodeCwdDirName(headerCwd)}, so the path ` +
        'likely contains a real dash, which the encoding flattens',
    })
  } else if (headerCwd === undefined && decoded !== undefined) {
    notes.push({ field: 'cwd', reason: 'taken from the lossy directory-name encoding; the header recorded no cwd' })
  }
  if (wantedCwd !== undefined && headerCwd !== undefined && resolvePath(headerCwd) !== wantedCwd) return undefined

  const branch = piBranch(view)
  const fold = foldPiEntries(branch.chain)
  if (view.windowTruncated) {
    notes.push({
      field: 'usage',
      reason: 'the file exceeded the read window; counts and usage cover only the live branch inside that window',
    })
  }
  if (branch.abandoned > 0) {
    notes.push({
      field: 'messages',
      reason: `${branch.abandoned} entries on abandoned branches are excluded from the linear reading`,
    })
  }
  if (fold.contextEdits > 0) {
    notes.push({
      field: 'messages',
      reason: `${fold.contextEdits} context edits are recorded but not applied: the transcript shows the recorded content`,
    })
  }
  if (fold.cacheWriteTokens > 0) {
    notes.push({ field: 'usage', reason: 'cache-write tokens are recorded by pi but have no canonical field' })
  }
  if (view.malformed > 0) {
    notes.push({ field: '*', reason: `${view.malformed} lines in the read window did not parse` })
  }
  if (fold.images > 0) {
    notes.push({
      field: 'messages',
      reason: `${fold.images} image blocks have no canonical field and are not represented in this summary`,
    })
  }
  if (fold.unknownEntryTypes.length > 0) {
    notes.push({
      field: 'messages',
      reason: `entry types this adapter does not model were left out: ${fold.unknownEntryTypes.join(', ')}`,
    })
  }

  const parentId = header.parentSession === undefined ? undefined : idFromSessionReference(header.parentSession)
  return {
    key: sessionKey(agent, nativeSessionId(header.id)),
    agentId: agent,
    nativeId: nativeSessionId(header.id),
    nativePath: path,
    ...(fold.title === undefined ? {} : { title: fold.title, titleIsNative: true }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(fold.model === undefined ? {} : { model: fold.model }),
    createdAt: isoOrUndefined(header.timestamp) ?? mtimeIso,
    updatedAt: fold.lastMessageAt ?? isoOrUndefined(header.timestamp) ?? mtimeIso,
    status: 'idle',
    ...(view.windowTruncated ? {} : { messageCount: fold.messageCount }),
    ...(parentId === undefined ? {} : { parentNativeId: nativeSessionId(parentId) }),
    source: header.parentSession === undefined ? 'pi' : 'pi:fork',
    ...(fold.usage === undefined ? {} : { usage: fold.usage }),
    binding: { runIds: [] },
    notes,
  }
}

/** Whether a file name is a pi session file. */
function isSessionFileName(name: string): boolean {
  return name.endsWith('.jsonl')
}

/** The session id encoded in a session file name, when the convention holds. */
function idFromFileName(name: string): string | undefined {
  if (!name.endsWith('.jsonl')) return undefined
  const stem = name.slice(0, -'.jsonl'.length)
  const separator = stem.lastIndexOf('_')
  if (separator <= 0 || separator === stem.length - 1) return undefined
  return stem.slice(separator + 1)
}

/** The session id behind a header `parentSession` path, when it can be recovered. */
function idFromSessionReference(reference: string): string | undefined {
  const lastSegment = reference.split(/[/\\]/).pop()
  if (lastSegment === undefined || lastSegment === '') return undefined
  if (!isSessionFileName(lastSegment)) return reference
  return idFromFileName(lastSegment) ?? reference
}

/** Everything `readPiTranscript` returns, mirroring the SPI's transcript result. */
export interface PiTranscript {
  messages: readonly AgentMessage[]
  totalMessages?: number
  hasMore: boolean
  notes: readonly ProjectionNote[]
}

/**
 * Read a bounded transcript window along the live branch.
 *
 * @param ctx - Adapter context.
 * @param nativeId - Pi session id, or a session file path.
 * @param options - Message and byte caps.
 * @param env - Environment to resolve the store from; defaults to the host's.
 * @returns The window, oldest first, with declared gaps.
 */
export async function readPiTranscript(
  ctx: AdapterContext,
  nativeId: NativeSessionId,
  options: ReadTranscriptOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiTranscript> {
  const path = await findPiSessionFile(ctx, nativeId, env)
  if (path === undefined) {
    return {
      messages: [],
      hasMore: false,
      notes: [{ field: '*', reason: `no session file was found for ${String(nativeId)}` }],
    }
  }
  const view = await readPiSessionView(ctx, path, options.maxBytes ?? DEFAULT_TRANSCRIPT_BYTES)
  if (view.missing) {
    return {
      messages: [],
      hasMore: false,
      notes: [{ field: '*', reason: 'the session file disappeared during the read' }],
    }
  }

  const branch = piBranch(view)
  const counters = projectionCounters()
  const drafts: PiProjectedMessage[] = []
  for (const entry of branch.chain) {
    for (const item of projectPiEntry(entry, counters)) drafts.push(item)
  }

  const maxMessages = options.maxMessages
  const window =
    maxMessages === undefined || maxMessages <= 0 || drafts.length <= maxMessages
      ? drafts
      : drafts.slice(drafts.length - maxMessages)
  const messages: AgentMessage[] = window.map((draft, index) => ({
    index,
    role: draft.role,
    kind: draft.kind,
    ...(draft.id === undefined ? {} : { id: draft.id }),
    ...(draft.text === undefined ? {} : { text: draft.text }),
    ...(draft.timestamp === undefined ? {} : { timestamp: draft.timestamp }),
    ...(draft.tool === undefined ? {} : { tool: draft.tool }),
    ...(draft.nativeType === undefined ? {} : { nativeType: draft.nativeType }),
  }))

  const notes: ProjectionNote[] = [...view.notes]
  if (view.malformed > 0) {
    notes.push({ field: '*', reason: `${view.malformed} lines in the read window did not parse` })
  }
  if (branch.abandoned > 0) {
    notes.push({
      field: 'messages',
      reason: `${branch.abandoned} entries on abandoned branches are excluded from the linear reading`,
    })
  }
  if (branch.truncated) {
    notes.push({
      field: 'messages',
      reason: 'the live branch extends past the read window, so older messages were not read',
    })
  }
  if (messages.length < drafts.length) {
    notes.push({
      field: 'messages',
      reason: `the window was capped at ${messages.length} of ${drafts.length} projected items`,
    })
  }
  if (counters.images > 0) {
    notes.push({
      field: 'messages',
      reason: `${counters.images} image blocks were omitted; the canonical message has no image field`,
    })
  }
  const fold = foldPiEntries(branch.chain)
  if (fold.unknownEntryTypes.length > 0) {
    notes.push({
      field: 'messages',
      reason: `entry types this adapter does not model were left out: ${fold.unknownEntryTypes.join(', ')}`,
    })
  }
  if (counters.unknownBlocks > 0) {
    notes.push({ field: 'messages', reason: `${counters.unknownBlocks} content blocks have no canonical kind` })
  }
  if (counters.unknownRoles > 0) {
    notes.push({
      field: 'messages',
      reason: `${counters.unknownRoles} messages had a role this adapter does not model`,
    })
  }

  return {
    messages,
    ...(branch.truncated ? {} : { totalMessages: countMessageEntries(branch.chain) }),
    hasMore: branch.truncated || messages.length < drafts.length,
    notes,
  }
}

function countMessageEntries(entries: readonly PiNativeEntry[]): number {
  let count = 0
  for (const entry of entries) if (entry.type === 'message') count += 1
  return count
}

/**
 * Locate a session file for a native id, or for a path given verbatim.
 *
 * There is no session index in pi, so this is a bounded directory scan: first by the
 * `<timestamp>_<id>.jsonl` file-name convention (cheap and exact), then by probing
 * headers when the name convention does not match.
 *
 * @param ctx - Adapter context.
 * @param nativeId - Session id or file path.
 * @param env - Environment to resolve the store from; defaults to the host's.
 * @returns The absolute path, or `undefined` when no file matches.
 */
export async function findPiSessionFile(
  ctx: AdapterContext,
  nativeId: NativeSessionId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const raw = String(nativeId)
  if (raw.includes('/') || raw.includes('\\') || raw.endsWith('.jsonl')) {
    const candidate = ctx.files.resolvePath(raw)
    return (await ctx.files.isFile(candidate)) ? candidate : undefined
  }

  const layout = await resolvePiStore(ctx, env)
  let probes = 0
  let visitedDirectories = 0
  let fallback: string | undefined
  const candidates: { path: string; namedMatch: boolean }[] = []

  for (const root of scanRoots(layout)) {
    if (!(await ctx.files.isDirectory(root.path))) continue
    const entries = await ctx.files.listDir(root.path)
    for (const entry of entries) {
      if (root.scanFiles && entry.isFile && isSessionFileName(entry.name)) {
        candidates.push({ path: entry.path, namedMatch: idFromFileName(entry.name) === raw })
      }
    }
    if (!root.scanSubdirectories) continue
    for (const directory of entries) {
      if (!directory.isDirectory || visitedDirectories >= MAX_SCAN_DIRECTORIES) continue
      visitedDirectories += 1
      const files = (await ctx.files.listDir(directory.path)).filter(
        entry => entry.isFile && isSessionFileName(entry.name),
      )
      for (const file of files) candidates.push({ path: file.path, namedMatch: idFromFileName(file.name) === raw })
    }
  }

  // Name matches are checked first and cheaply; only then are headers probed.
  candidates.sort((a, b) => Number(b.namedMatch) - Number(a.namedMatch))
  for (const candidate of candidates) {
    if (!candidate.namedMatch && probes >= MAX_HEADER_PROBES) continue
    probes += 1
    const header = await readPiSessionHeaderAt(ctx, candidate.path)
    if (header?.id !== raw) continue
    if (candidate.namedMatch) return candidate.path
    if (fallback === undefined) fallback = candidate.path
  }
  if (!fallback && probes >= MAX_HEADER_PROBES) {
    ctx.log.debug('the by-id session lookup stopped at its header probe cap', { nativeId: raw })
  }
  return fallback
}

/**
 * Pi has no native todo list and no plan mode: its README states that it "skips
 * features like sub-agents and plan mode", and both exist only as example extensions.
 *
 * @returns Always `undefined`, because there is no native task model to project.
 */
export function readPiNativeTasks(): Promise<NativeTaskState | undefined> {
  return Promise.resolve(undefined)
}
