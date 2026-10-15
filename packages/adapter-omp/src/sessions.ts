/**
 * OMP's session store: discovery, the title-slot/header/entry record model,
 * branch-following transcript reading, and the native todo/plan projection.
 * Everything here is read-only and bounded, because the store belongs to another
 * process that may be appending to it right now (ADR-0012).
 *
 * Layout, verified against oh-my-pi 18.11.0 (`docs/session.md`,
 * `packages/coding-agent/src/session/session-paths.ts`):
 *
 *   <agent-dir>/sessions/<encoded-cwd>/<file-safe-timestamp>_<sessionId>.jsonl
 *
 * where `<agent-dir>` is `$PI_CODING_AGENT_DIR` (default profile only) or
 * `~/.omp/agent` — `PI_CONFIG_DIR` renames `.omp`, and a named profile
 * (`OMP_PROFILE`, else the legacy `PI_PROFILE`) resolves to
 * `~/.omp/profiles/<name>/agent` with the agent-dir override ignored. The
 * `<encoded-cwd>` bucket is `-<relative>` under home, `-tmp-<relative>` under the
 * temp root, and `--<encoded-absolute>--` otherwise. A session directory override
 * (`$PI_CODING_AGENT_SESSION_DIR`, or the adapter's own `sessionDir` setting) is
 * **not** a second root: it is the directory that directly holds session files,
 * replacing the per-cwd bucket for every project, so it is read flat.
 *
 * The file physically begins with a 256-byte fixed-width `type: "title"` slot
 * (including its newline), then the `type: "session"` header, then append-only
 * `SessionEntry` values that form a tree (omp's own loaders strip and fold the
 * slot; legacy files may begin directly with the header). A branch switch appends
 * an entry whose `parentId` is not the previous line's `id`, so the live
 * conversation is the chain ending at the live leaf, never the file order — and a
 * late `model_usage` entry that carries `activeLeafId` selects a leaf other than
 * the last line.
 *
 * @module @zorker/muti-agent-adapter-omp/sessions
 */

import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import {
  nativeSessionId,
  sessionKey,
  todoId,
  type AgentId,
  type AgentMessage,
  type AgentSession,
  type AgentTodo,
  type MessageKind,
  type NativeSessionId,
  type ProjectionNote,
  type SessionUsage,
  type TodoStatus,
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
export const OMP_SESSION_VERSION = 3

/** Bytes of the fixed-width title slot at the head of a current session file. */
export const OMP_TITLE_SLOT_BYTES = 256

/** How many session directories a single scan will look at. */
const MAX_SCAN_DIRECTORIES = 200
/** Per-directory file cap, so one runaway project cannot starve the scan. */
const MAX_SCAN_FILES_PER_DIRECTORY = 400
/** Global file cap for one scan. */
const MAX_SCAN_FILES = 1_500
/** Cap on header probes during a by-id lookup, whose fast path is the file name. */
const MAX_HEADER_PROBES = 300
/** Bytes read to obtain the slot and header lines of a large session file. */
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
 * Adapter settings OMP accepts under `AdapterRuntimeConfig.settings`. Unknown keys
 * are ignored rather than rejected, so a newer host can carry settings this adapter
 * version does not know yet.
 */
export interface OmpAdapterSettings {
  /**
   * Session directory override, as `omp --session-dir` defines it: the one directory
   * that directly holds session files for every project. OMP's `config.yml` has no
   * equivalent key (`--session-dir` defaults from `PI_CODING_AGENT_SESSION_DIR`), so
   * this setting and that variable are the only non-argv sources.
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
export function parseOmpSettings(settings: Readonly<Record<string, unknown>>): OmpAdapterSettings {
  const rawDir = settings.sessionDir
  const rawInherit = settings.inheritCredentialEnv
  const sessionDir = typeof rawDir === 'string' && rawDir.trim() !== '' ? rawDir.trim() : undefined
  return {
    ...(sessionDir === undefined ? {} : { sessionDir }),
    inheritCredentialEnv: typeof rawInherit === 'boolean' ? rawInherit : false,
  }
}

/**
 * The ambient services the store resolver and the catalog reader actually use.
 *
 * Narrower than `AdapterContext` on purpose: a host that only reads OMP's
 * configuration — the harness LLM registration — supplies a file probe, a logger and
 * a runtime config, and must not have to fake a process runner it never calls.
 */
export type OmpReadContext = Pick<AdapterContext, 'log' | 'config' | 'files'>

/** Where a machine keeps OMP's configuration, sessions and credential store. */
export interface OmpStoreLayout {
  /** Resolved agent config directory (`~/.omp/agent` or its profile/override form). */
  agentDir: string
  /** Config root the agent directory hangs off (`~/.omp`, or `$HOME/$PI_CONFIG_DIR`). */
  configRoot: string
  /** Active named profile, when one is selected. */
  profile?: string
  /** Root holding one directory per project, plus any stray session files. */
  defaultSessionsRoot: string
  /** Flat session directory in force, when the adapter or the host configured one. */
  sessionDirOverride?: string
  /** Whether the override came from the adapter's own `sessionDir` setting. */
  sessionsDirFromSetting: boolean
  /** Whether the agent directory came from an override rather than the default. */
  agentDirFromEnv: boolean
  /** `agent.db`, OMP's SQLite store holding the credential rows. */
  credentialPath: string
  /** `config.yml`, the primary settings file (else its `config.yaml` sibling). */
  settingsPath: string
  /** `models.yml`, the primary provider/model file (else its `models.yaml` sibling). */
  modelsPath: string
}

/**
 * Resolve the store layout from the adapter settings, the host environment and OMP's
 * own profile selection.
 *
 * Precedence mirrors `getAgentDir()`: the adapter's `homeDir`, then a named profile's
 * `~/.omp/profiles/<name>/agent` (which ignores `PI_CODING_AGENT_DIR`), then
 * `$PI_CODING_AGENT_DIR`, then `<config-root>/agent` where the config root is
 * `$HOME/<PI_CONFIG_DIR || '.omp'>`. The session-directory override is the adapter
 * setting, then `$PI_CODING_AGENT_SESSION_DIR`; OMP has no settings key for it.
 *
 * @param ctx - Ambient services (configuration and read-only file helpers).
 * @param env - Host environment; injected for testability.
 * @returns The resolved layout.
 */
export async function resolveOmpStore(
  ctx: OmpReadContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OmpStoreLayout> {
  const settings = parseOmpSettings(ctx.config.settings)
  const profile = activeProfile(env)
  const configDirName = env.PI_CONFIG_DIR === undefined || env.PI_CONFIG_DIR === '' ? '.omp' : env.PI_CONFIG_DIR
  const home = resolveHome({ envName: 'HOME', defaultName: '', env })
  const configRoot = ctx.files.resolvePath(join(home.path, configDirName))
  const agentDirFromEnv = ctx.config.homeDir !== undefined || (profile === undefined && readAgentDirEnv(env) !== undefined)
  const agentDir = ctx.files.resolvePath(
    ctx.config.homeDir !== undefined && ctx.config.homeDir !== ''
      ? ctx.config.homeDir
      : profile !== undefined
        ? join(configRoot, 'profiles', profile, 'agent')
        : (readAgentDirEnv(env) ?? join(configRoot, 'agent')),
  )
  const override = settings.sessionDir ?? readSessionDirEnv(env)
  return {
    agentDir,
    configRoot,
    ...(profile === undefined ? {} : { profile }),
    defaultSessionsRoot: `${agentDir}/sessions`,
    ...(override === undefined ? {} : { sessionDirOverride: ctx.files.resolvePath(override) }),
    sessionsDirFromSetting: settings.sessionDir !== undefined,
    agentDirFromEnv,
    credentialPath: `${agentDir}/agent.db`,
    settingsPath: `${agentDir}/config.yml`,
    modelsPath: `${agentDir}/models.yml`,
  }
}

/** `$PI_CODING_AGENT_DIR`, when it is set to a non-empty value. */
function readAgentDirEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.PI_CODING_AGENT_DIR
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** `$PI_CODING_AGENT_SESSION_DIR`, when it is set to a non-empty value. */
function readSessionDirEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.PI_CODING_AGENT_SESSION_DIR
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/**
 * The named profile the environment selects, normalized as OMP does: `OMP_PROFILE`
 * wins over the legacy `PI_PROFILE`, and the explicit `default` sentinel selects the
 * default profile.
 *
 * @param env - Host environment.
 * @returns The profile name, or `undefined` for the default profile.
 */
export function activeProfile(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE
  const trimmed = raw?.trim()
  return trimmed === undefined || trimmed === '' || trimmed === 'default' ? undefined : trimmed
}

// ---------------------------------------------------------------------------
// Native record narrowing. OMP's files are foreign JSON: every field is read
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

/** The fixed-width current-title slot that physically heads a current session file. */
export interface OmpTitleSlot {
  /** Current session title, verbatim. */
  title: string
  /** Who set it: `auto` (titler) or `user` (an explicit rename). */
  source?: string
  /** ISO 8601 time the slot was last written. */
  updatedAt?: string
}

/**
 * Parse the physical title slot.
 *
 * @param value - Decoded JSON of the first line.
 * @returns The slot, or `undefined` when the line is not the title slot.
 */
export function readOmpTitleSlot(value: unknown): OmpTitleSlot | undefined {
  if (!isRecord(value) || readString(value, 'type') !== 'title') return undefined
  const title = readString(value, 'title')
  if (title === undefined) return undefined
  const source = readString(value, 'source')
  const updatedAt = readString(value, 'updatedAt')
  return {
    title,
    ...(source === undefined ? {} : { source }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/** The logical first record of an OMP session file. */
export interface OmpSessionHeader {
  /** Session id, verbatim. */
  id: string
  /** Creation time, verbatim ISO 8601. */
  timestamp: string
  /** Absolute working directory the session was started in; empty on very old files. */
  cwd: string
  /** Session title folded into the header by OMP's loaders, when it carries one. */
  title?: string
  /** Who set the folded title. */
  titleSource?: string
  /** Path or id of the session this one was forked from, when it was. */
  parentSession?: string
  /** Native format version; absent on v1 files. */
  version?: number
  /** Extra workspace roots beyond `cwd`, which `AgentSession` has no field for. */
  additionalDirectories: number
  /** Previous absolute locations recorded by successful moves. */
  previousSessionFiles: number
  /** Whether a inherited provider prompt-cache identity is recorded (a local-only field). */
  hasProviderPromptCacheKey: boolean
}

/**
 * Parse a session header.
 *
 * @param value - Decoded JSON of the header line.
 * @returns The header, or `undefined` when the line is not a session header.
 */
export function readOmpSessionHeader(value: unknown): OmpSessionHeader | undefined {
  if (!isRecord(value) || readString(value, 'type') !== 'session') return undefined
  const id = readString(value, 'id')
  if (id === undefined || id === '') return undefined
  const timestamp = readString(value, 'timestamp')
  const cwd = readString(value, 'cwd')
  const version = readNumber(value, 'version')
  const parentSession = readString(value, 'parentSession')
  const title = readString(value, 'title')
  const titleSource = readString(value, 'titleSource')
  return {
    id,
    timestamp: timestamp ?? '',
    cwd: cwd ?? '',
    ...(version === undefined ? {} : { version: Math.trunc(version) }),
    ...(parentSession === undefined || parentSession === '' ? {} : { parentSession }),
    ...(title === undefined || title === '' ? {} : { title }),
    ...(titleSource === undefined || titleSource === '' ? {} : { titleSource }),
    additionalDirectories: (readArray(value, 'additionalDirectories') ?? []).length,
    previousSessionFiles: (readArray(value, 'previousSessionFiles') ?? []).length,
    hasProviderPromptCacheKey: readString(value, 'providerPromptCacheKey') !== undefined,
  }
}

/** One parsed session entry, in file order, with its bounded raw line. */
export interface OmpNativeEntry {
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
export function readOmpEntry(value: unknown, raw: string): OmpNativeEntry | undefined {
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
export interface OmpSessionView {
  /** The physical title slot, when the read window contained it. */
  titleSlot?: OmpTitleSlot
  /** Session header, when the read window contained it. */
  header?: OmpSessionHeader
  /** Entries in the read window, in file order. */
  entries: readonly OmpNativeEntry[]
  /** Whether earlier file content was outside the window. */
  windowTruncated: boolean
  /** Whether the window dropped a leading partial line. */
  droppedPartialLine: boolean
  /** File size at read time, or `-1` when absent. */
  size: number
  /** File modification time in milliseconds. */
  mtimeMs: number
  /** JSON lines in the window that did not parse as the slot, the header or an entry. */
  malformed: number
  /** Whether the file was absent. */
  missing: boolean
  /** Declared gaps produced while reading. */
  notes: readonly ProjectionNote[]
}

interface WindowAccumulator {
  titleSlot: OmpTitleSlot | undefined
  header: OmpSessionHeader | undefined
  sawFirstLine: boolean
  entries: OmpNativeEntry[]
  malformed: number
}

/**
 * Read a bounded view of one session file: the whole file when it is small, else the
 * slot/header lines plus a tail window. Read-only, and capped so a large session is
 * never read into memory whole.
 *
 * @param ctx - Adapter context.
 * @param path - Absolute session file path.
 * @param maxBytes - Desired window size.
 * @returns The view; `missing: true` when the file is gone.
 */
export async function readOmpSessionView(
  ctx: AdapterContext,
  path: string,
  maxBytes: number,
): Promise<OmpSessionView> {
  const cap = Math.max(MIN_TRANSCRIPT_BYTES, Math.min(maxBytes, MAX_TRANSCRIPT_BYTES))
  const fingerprint = await ctx.files.fingerprint(path)
  if (fingerprint.size < 0) return missingView(-1, 0)

  const notes: ProjectionNote[] = []
  const accumulator: WindowAccumulator = {
    titleSlot: undefined,
    header: undefined,
    sawFirstLine: false,
    entries: [],
    malformed: 0,
  }
  let windowTruncated: boolean
  let droppedPartialLine = false

  if (fingerprint.size <= cap) {
    const whole = await ctx.files.readHead(path, Math.max(1, fingerprint.size))
    if (whole.missing) return missingView(fingerprint.size, fingerprint.mtimeMs)
    windowTruncated = whole.truncated
    accumulateLines(whole.text, accumulator)
  } else {
    // The slot and header head the file, and the fold window is the tail. Reading the
    // head first keeps the slot and the authoritative cwd available for a huge session.
    const head = await ctx.files.readHead(path, HEADER_READ_BYTES)
    const lead = completeLeadLines(head.text, 2)
    if (lead.length < 2) {
      notes.push({
        field: 'cwd',
        reason: `the title slot and session header did not both fit in ${HEADER_READ_BYTES} bytes, so the cwd is unavailable`,
      })
    }
    accumulateLines(lead.join('\n'), accumulator)
    const tail = await ctx.files.readTail(path, cap)
    if (tail.missing) return missingView(fingerprint.size, fingerprint.mtimeMs)
    droppedPartialLine = tail.droppedPartialLine
    windowTruncated = true
    // The tail starts on a record boundary and never holds the slot or the header, so
    // its first line is an entry: the accumulator is advanced past its lead phase.
    accumulator.sawFirstLine = true
    for (const line of tail.text.split('\n')) {
      if (line.trim() === '') continue
      const parsed = parseJsonLine(line)
      if (!parsed.ok) {
        accumulator.malformed += 1
        continue
      }
      const entry = readOmpEntry(parsed.value, line)
      if (entry === undefined) accumulator.malformed += 1
      else accumulator.entries.push(entry)
    }
  }

  return {
    ...(accumulator.titleSlot === undefined ? {} : { titleSlot: accumulator.titleSlot }),
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
 * Read only the slot and header of a session file, for by-id lookups and resume checks.
 *
 * @param ctx - Adapter context.
 * @param path - Absolute session file path.
 * @returns The slot and header, each absent when its line is missing or unreadable.
 */
export async function readOmpSessionLeadAt(
  ctx: AdapterContext,
  path: string,
): Promise<{ titleSlot?: OmpTitleSlot; header?: OmpSessionHeader }> {
  const head = await ctx.files.readHead(path, HEADER_READ_BYTES)
  if (head.missing) return {}
  const accumulator: WindowAccumulator = {
    titleSlot: undefined,
    header: undefined,
    sawFirstLine: false,
    entries: [],
    malformed: 0,
  }
  accumulateLines(completeLeadLines(head.text, 2).join('\n'), accumulator)
  return {
    ...(accumulator.titleSlot === undefined ? {} : { titleSlot: accumulator.titleSlot }),
    ...(accumulator.header === undefined ? {} : { header: accumulator.header }),
  }
}

/**
 * Read only the header of a session file, for by-id lookups and resume checks.
 *
 * @param ctx - Adapter context.
 * @param path - Absolute session file path.
 * @returns The header, or `undefined` when no complete header line was read.
 */
export async function readOmpSessionHeaderAt(
  ctx: AdapterContext,
  path: string,
): Promise<OmpSessionHeader | undefined> {
  return (await readOmpSessionLeadAt(ctx, path)).header
}

function missingView(size: number, mtimeMs: number): OmpSessionView {
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

/** Parse a block of JSONL text whose leading lines are the title slot and the header. */
function accumulateLines(text: string, accumulator: WindowAccumulator): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      accumulator.malformed += 1
      continue
    }
    if (!accumulator.sawFirstLine) {
      accumulator.sawFirstLine = true
      const slot = readOmpTitleSlot(parsed.value)
      if (slot !== undefined) {
        accumulator.titleSlot = slot
        // The slot is not the logical first entry: the header still follows it.
        accumulator.sawFirstLine = false
        continue
      }
      const header = readOmpSessionHeader(parsed.value)
      if (header === undefined) {
        accumulator.malformed += 1
        continue
      }
      accumulator.header = header
      continue
    }
    const entry = readOmpEntry(parsed.value, line)
    if (entry === undefined) accumulator.malformed += 1
    else accumulator.entries.push(entry)
  }
}

/**
 * The first `count` complete lines of a text window, in order.
 *
 * @param text - Text that may end mid-line.
 * @param count - How many lines to collect.
 * @returns The lines without their terminators; fewer when the text holds fewer.
 */
function completeLeadLines(text: string, count: number): readonly string[] {
  const lines: string[] = []
  let start = 0
  while (lines.length < count) {
    const newline = text.indexOf('\n', start)
    if (newline === -1) break
    lines.push(text.slice(start, newline))
    start = newline + 1
  }
  return lines
}

// ---------------------------------------------------------------------------
// Directory-name encoding
// ---------------------------------------------------------------------------

/**
 * OMP's session bucket name for an absolute cwd.
 *
 * A cwd under home is `-<relative>`, one under the temp root is `-tmp-<relative>`,
 * and anything else is `--<encoded-absolute>--`, with path separators (and a
 * Windows drive colon) replaced by `-`.
 *
 * @param cwd - Working directory; resolved first.
 * @param options - Home and temp roots to classify against; default to this process's.
 * @returns The directory name, e.g. `--Volumes-Net-Repo--`.
 */
export function encodeCwdDirName(
  cwd: string,
  options: { home?: string; tempRoot?: string } = {},
): string {
  const resolved = resolvePath(cwd)
  const home = resolvePath(options.home ?? homedir())
  const tempRoot = resolvePath(options.tempRoot ?? tmpdir())
  const homeRelative = relativeWithin(home, resolved)
  const tempRelative = relativeWithin(tempRoot, resolved)
  if (tempRelative !== undefined) return `-tmp-${tempRelative.replace(/[/\\:]/g, '-')}`
  if (homeRelative !== undefined) return `-${homeRelative.replace(/[/\\:]/g, '-')}`
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/** The path of `target` relative to `root`, when it is at or inside `root`. */
function relativeWithin(root: string, target: string): string | undefined {
  if (target === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : undefined
}

/**
 * Best-effort decode of a session bucket name.
 *
 * The encoding is lossy: a real `-` in a path is indistinguishable from a separator,
 * a Windows drive colon is flattened, and `-tmp-<x>` is also the home-relative name
 * of `home/tmp/x`. This is only ever a hint — the header's own `cwd` is authoritative.
 *
 * @param name - Directory entry name.
 * @param options - Home and temp roots to decode against; default to this process's.
 * @returns The candidate absolute path, or `undefined` when the name is not encoded.
 */
export function decodeCwdDirName(
  name: string,
  options: { home?: string; tempRoot?: string } = {},
): string | undefined {
  if (name.length < 2) return undefined
  if (name.startsWith('--') && name.endsWith('--')) {
    const inner = name.slice(2, -2)
    return inner === '' ? undefined : `/${inner.replace(/-/g, '/')}`
  }
  if (!name.startsWith('-')) return undefined
  const home = resolvePath(options.home ?? homedir())
  const tempRoot = resolvePath(options.tempRoot ?? tmpdir())
  if (name.startsWith('-tmp-')) {
    const inner = name.slice('-tmp-'.length)
    return inner === '' ? undefined : `${tempRoot}/${inner.replace(/-/g, '/')}`
  }
  const inner = name.slice(1)
  return inner === '' ? undefined : `${home}/${inner.replace(/-/g, '/')}`
}

// ---------------------------------------------------------------------------
// Folding and branch walking
// ---------------------------------------------------------------------------

/** Entry types this reader models, directly or as declared state. */
const KNOWN_ENTRY_TYPES: readonly string[] = [
  'message',
  'model_usage',
  'thinking_level_change',
  'model_change',
  'service_tier_change',
  'compaction',
  'branch_summary',
  'reset_boundary',
  'custom',
  'custom_message',
  'label',
  'title_change',
  'ttsr_injection',
  'credential_pin',
  'session_init',
  'mode_change',
]

/** Mode names OMP records that mean plan mode is on. */
const PLAN_MODES: readonly string[] = ['plan', 'plan_paused']

/** A session's state as folded from one read window. */
export interface OmpSessionFold {
  /** Latest title: a `title_change` in the window, else the folded header title. */
  title?: string
  /** Latest `model_change` selector, else the last assistant message's `provider/model`. */
  model?: string
  /** Usage summed over the window (assistant messages and `model_usage` entries). */
  usage?: SessionUsage
  /** `message` entries seen in the window. */
  messageCount: number
  /** Latest user/assistant message time in the window, ISO 8601. */
  lastMessageAt?: string
  /** Latest `mode_change` mode name, verbatim (`none` means no mode is active). */
  mode?: string
  /** Plan file path recorded alongside a plan-mode transition. */
  planFilePath?: string
  /** Records the canonical projection has no field for. */
  images: number
  /** `model_usage` entries in the window (out-of-transcript accounting). */
  modelUsageEntries: number
  /** `session_init` entries in the window (subagent bootstrap records). */
  sessionInitEntries: number
  /** `reset_boundary` entries in the window. */
  resetBoundaries: number
  /** `compaction` entries in the window. */
  compactions: number
  /** `ttsr_injection` entries in the window. */
  ttsrInjections: number
  /** `credential_pin` entries in the window (pseudonymous account pins). */
  credentialPins: number
  /** Cache-write tokens seen, which `SessionUsage` cannot carry. */
  cacheWriteTokens: number
  /** Entry types this reader does not model, distinct, at most a handful. */
  unknownEntryTypes: readonly string[]
}

/**
 * Fold a read window into session state.
 *
 * @param entries - Entries in file order.
 * @param header - The header, when the window held it.
 * @returns The folded state.
 */
export function foldOmpEntries(
  entries: readonly OmpNativeEntry[],
  header?: OmpSessionHeader,
): OmpSessionFold {
  const fold: OmpSessionFold = {
    messageCount: 0,
    images: 0,
    modelUsageEntries: 0,
    sessionInitEntries: 0,
    resetBoundaries: 0,
    compactions: 0,
    ttsrInjections: 0,
    credentialPins: 0,
    cacheWriteTokens: 0,
    unknownEntryTypes: [],
  }
  if (header?.title !== undefined) fold.title = header.title
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
          // OMP records the provider and the bare model id separately on a message;
          // the `provider/model` selector is the form `--model` accepts.
          const model = readString(message, 'model')
          if (model !== undefined && model !== '') {
            const provider = readString(message, 'provider')
            fold.model = provider === undefined || provider === '' ? model : `${provider}/${model}`
          }
          const usage = readRecord(message, 'usage')
          if (usage !== undefined) {
            sawUsage = true
            addUsage(totals, usage)
          }
        }
        break
      }
      case 'model_usage': {
        fold.modelUsageEntries += 1
        const usage = readRecord(entry.record, 'usage')
        if (usage !== undefined) {
          sawUsage = true
          addUsage(totals, usage)
        }
        break
      }
      case 'model_change': {
        // OMP records the selector verbatim as `provider/modelId` (not pi's `modelId`).
        const model = readString(entry.record, 'model')
        if (model !== undefined && model !== '') fold.model = model
        break
      }
      case 'title_change': {
        const title = readString(entry.record, 'title')
        if (title !== undefined) {
          const trimmed = title.trim()
          if (trimmed === '') delete fold.title
          else fold.title = trimmed
        }
        break
      }
      case 'mode_change': {
        const mode = readString(entry.record, 'mode')
        if (mode !== undefined && mode !== '') fold.mode = mode
        const data = readRecord(entry.record, 'data')
        const planFilePath = data === undefined ? undefined : readString(data, 'planFilePath')
        if (planFilePath !== undefined && planFilePath !== '') fold.planFilePath = planFilePath
        break
      }
      case 'session_init':
        fold.sessionInitEntries += 1
        break
      case 'reset_boundary':
        fold.resetBoundaries += 1
        break
      case 'compaction':
        fold.compactions += 1
        break
      case 'ttsr_injection':
        fold.ttsrInjections += 1
        break
      case 'credential_pin':
        fold.credentialPins += 1
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
  const reasoning = readNumber(usage, 'reasoningTokens')
  if (reasoning !== undefined) totals.reasoning = (totals.reasoning ?? 0) + reasoning
  if (costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + costUsd
}

/** The ISO 8601 activity time of a message record. */
function messageActivity(message: Record<string, unknown>, fallback: string): string | undefined {
  const role = readString(message, 'role')
  if (role !== 'user' && role !== 'assistant') return undefined
  const native = readNumber(message, 'timestamp')
  if (native !== undefined) return new Date(native).toISOString()
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
export interface OmpBranch {
  /** Entries on the branch that ends at the live leaf, in conversation order. */
  chain: readonly OmpNativeEntry[]
  /** Entries in the window that belong to abandoned branches. */
  abandoned: number
  /** Whether the chain start is outside the read window or a parent link is missing. */
  truncated: boolean
}

/**
 * Walk `parentId` links from the live leaf to produce the live branch.
 *
 * The store is append-only, so the last line is where the next entry attaches — with
 * one recorded exception: a late `model_usage` entry names the leaf that was active
 * when the usage arrived (`activeLeafId`), and OMP replays that captured leaf rather
 * than the marker itself. Everything reachable from the resolved leaf is the
 * conversation; everything else is an abandoned branch.
 *
 * @param view - A read window.
 * @returns The chain, the abandoned count, and whether the chain start is unknown.
 */
export function ompBranch(view: OmpSessionView): OmpBranch {
  const byId = new Map<string, OmpNativeEntry>()
  for (const entry of view.entries) byId.set(entry.id, entry)
  const last = view.entries[view.entries.length - 1]
  if (last === undefined) return { chain: [], abandoned: 0, truncated: view.windowTruncated }
  const leaf = leafEntry(last, byId)

  const chain: OmpNativeEntry[] = []
  const visited = new Set<string>()
  let cursor: OmpNativeEntry | undefined = leaf
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

/** The leaf a late `model_usage` marker selects, when it names one that is present. */
function leafEntry(last: OmpNativeEntry, byId: ReadonlyMap<string, OmpNativeEntry>): OmpNativeEntry {
  if (last.type !== 'model_usage') return last
  const activeLeafId = last.record.activeLeafId
  if (typeof activeLeafId !== 'string' || activeLeafId === '') return last
  return byId.get(activeLeafId) ?? last
}

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

/** A projected message, before the reader assigns its window index. */
export interface OmpProjectedMessage {
  /** Entry id, or a derived `entryId:blockIndex` for a multi-block entry. */
  id?: string
  role: AgentMessage['role']
  kind: MessageKind
  text?: string
  timestamp?: string
  tool?: { name: string; input?: string; output?: string; failed?: boolean }
  /** Paths a `fileMention` message inlined, which only `file-change` carries. */
  paths?: readonly string[]
  nativeType?: string
}

/** Counters a projection run accumulates, so the reader can declare what it dropped. */
export interface OmpProjectionCounters {
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
export function ompProjectionCounters(): OmpProjectionCounters {
  return { images: 0, unknownBlocks: 0, unknownRoles: 0 }
}

/**
 * Project one entry into canonical messages, unwrapping OMP's camelCase message roles.
 *
 * Content blocks are `text`, `thinking`, `toolCall` and `image`, and a tool result is
 * its own message with role `toolResult`; an assistant entry therefore expands into one
 * message per content block. Images and unknown block types are counted for the caller's
 * notes instead of being invented into text.
 *
 * @param entry - A session entry.
 * @param counters - Accumulator for what this projection cannot carry.
 * @returns Projected messages in block order; empty for state-only entries.
 */
export function projectOmpEntry(
  entry: OmpNativeEntry,
  counters: OmpProjectionCounters,
): readonly OmpProjectedMessage[] {
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
      // model_usage, thinking_level_change, model_change, service_tier_change,
      // reset_boundary, label, title_change, ttsr_injection, credential_pin,
      // session_init, mode_change and any future entry type carry state or context
      // bookkeeping, not conversation content; the caller notes the ones with
      // projection consequences.
      return []
  }
}

function projectMessageEntry(
  entry: OmpNativeEntry,
  counters: OmpProjectionCounters,
): readonly OmpProjectedMessage[] {
  const message = readRecord(entry.record, 'message')
  if (message === undefined) return []
  const timestamp = messageActivity(message, entry.timestamp)
  const nativeType = 'message'

  switch (readString(message, 'role') ?? '') {
    case 'user':
    case 'developer': {
      const text = projectUserContent(message, counters)
      return [
        {
          role: 'user',
          kind: 'user',
          ...spreadText(text),
          ...spreadTime(timestamp),
          nativeType: readString(message, 'role') === 'developer' ? 'developer' : nativeType,
        },
      ]
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
    case 'bashExecution':
    case 'pythonExecution': {
      const tool = readString(message, 'role') === 'bashExecution' ? 'bash' : 'python'
      const output = readString(message, 'output')
      const command = readString(message, 'command') ?? readString(message, 'code')
      const exitCode = readNumber(message, 'exitCode')
      return [
        {
          role: 'tool',
          kind: 'tool-result',
          ...spreadText(output),
          ...spreadTime(timestamp),
          nativeType: tool,
          tool: {
            name: tool,
            ...(command === undefined ? {} : { input: command }),
            ...(output === undefined ? {} : { output }),
            ...(exitCode === undefined || exitCode === 0 ? {} : { failed: true }),
          },
        },
      ]
    }
    case 'fileMention': {
      const paths = (readArray(message, 'paths') ?? []).filter((path): path is string => typeof path === 'string')
      return [
        {
          role: 'user',
          kind: 'file-change',
          ...spreadText(projectUserContent(message, counters)),
          ...spreadTime(timestamp),
          nativeType,
          paths,
        },
      ]
    }
    case 'custom':
      return projectCustomMessage(entry, counters, message)
    case 'hookMessage': {
      // v3 rewrites `hookMessage` to `custom`; a reader must still accept the legacy role.
      counters.unknownRoles += 1
      return projectCustomMessage(entry, counters, message)
    }
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
  entry: OmpNativeEntry,
  counters: OmpProjectionCounters,
): readonly OmpProjectedMessage[] {
  const items: OmpProjectedMessage[] = []
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

function projectUserContent(message: Record<string, unknown>, counters: OmpProjectionCounters): string | undefined {
  const content = message.content
  if (typeof content === 'string') return content
  return projectTextBlocks(content, counters)
}

function projectToolResultContent(
  message: Record<string, unknown>,
  counters: OmpProjectionCounters,
): string | undefined {
  const content = message.content
  if (typeof content === 'string') return content
  return projectTextBlocks(content, counters)
}

/** Join the text blocks of a content array, counting what is dropped. */
function projectTextBlocks(content: unknown, counters: OmpProjectionCounters): string | undefined {
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
  entry: OmpNativeEntry,
  counters: OmpProjectionCounters,
  message?: Record<string, unknown>,
): readonly OmpProjectedMessage[] {
  const source = message ?? entry.record
  const content = source.content
  const text = typeof content === 'string' ? content : projectTextBlocks(content, counters)
  if (text === undefined || text === '') return []
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
  entry: OmpNativeEntry,
  nativeType: string,
  summary: string | undefined,
  counters: OmpProjectionCounters,
): readonly OmpProjectedMessage[] {
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

/** One directory level of an OMP store: session files and/or project buckets. */
interface ScanRoot {
  /** Directory to read. */
  path: string
  /** Fresh scan of `.jsonl` files directly in this directory. */
  scanFiles: boolean
  /** Whether subdirectories are project directories to read one level into. */
  scanSubdirectories: boolean
}

/** The roots a scan reads: the override directory first, then OMP's default root. */
function scanRoots(layout: OmpStoreLayout): readonly ScanRoot[] {
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
 * Enumerate OMP's sessions.
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
export async function listOmpSessions(
  ctx: AdapterContext,
  agent: AgentId,
  options: ListSessionsOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly AgentSession[]> {
  const layout = await resolveOmpStore(ctx, env)
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
  const view = await readOmpSessionView(ctx, path, SMALL_FILE_BYTES)
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
      ...(view.titleSlot === undefined || view.titleSlot.title === ''
        ? {}
        : { title: view.titleSlot.title, titleIsNative: true }),
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
        `omp would name this session's directory ${encodeCwdDirName(headerCwd)}, so the path ` +
        'likely contains a real dash or a flattened drive colon',
    })
  } else if (headerCwd === undefined && decoded !== undefined) {
    notes.push({ field: 'cwd', reason: 'taken from the lossy directory-name encoding; the header recorded no cwd' })
  }
  if (wantedCwd !== undefined && headerCwd !== undefined && resolvePath(headerCwd) !== wantedCwd) return undefined
  if (header.additionalDirectories > 0) {
    notes.push({
      field: 'cwd',
      reason: `${header.additionalDirectories} additional workspace directories are recorded; AgentSession has one cwd`,
    })
  }
  if (header.previousSessionFiles > 0) {
    notes.push({
      field: 'nativePath',
      reason: `${header.previousSessionFiles} previous session file locations are recorded by successful session moves`,
    })
  }
  if (header.hasProviderPromptCacheKey) {
    notes.push({
      field: '*',
      reason: 'the header carries a local-only provider prompt-cache identity, which is never read into a projection',
    })
  }
  if (header.version !== undefined && header.version < OMP_SESSION_VERSION) {
    notes.push({
      field: '*',
      reason: `the file is session format v${header.version}; this reader was verified against v${OMP_SESSION_VERSION}`,
    })
  }

  const branch = ompBranch(view)
  const fold = foldOmpEntries(branch.chain, header)
  const title = titleOf(view, fold)
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
  if (fold.resetBoundaries > 0) {
    notes.push({
      field: 'messages',
      reason:
        `${fold.resetBoundaries} /clear reset boundaries are recorded but not applied: the transcript shows ` +
        'the branch as recorded, not the collapsed live view',
    })
  }
  if (fold.cacheWriteTokens > 0) {
    notes.push({ field: 'usage', reason: 'cache-write tokens are recorded by omp but have no canonical field' })
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
  if (fold.modelUsageEntries > 0) {
    notes.push({
      field: 'usage',
      reason: `${fold.modelUsageEntries} model_usage entries count out-of-transcript model calls in the totals`,
    })
  }
  if (fold.sessionInitEntries > 0) {
    notes.push({
      field: 'messages',
      reason: `${fold.sessionInitEntries} session_init entries describe a subagent's bootstrap and carry no message`,
    })
  }
  if (fold.ttsrInjections > 0) {
    notes.push({
      field: 'messages',
      reason: `${fold.ttsrInjections} ttsr_injection entries record which time-traveling rules were injected`,
    })
  }
  if (fold.credentialPins > 0) {
    notes.push({
      field: '*',
      reason:
        `${fold.credentialPins} credential_pin entries are pseudonymous account hashes; they are counted, never read`,
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
    ...(title === undefined ? {} : { title, titleIsNative: true }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(fold.model === undefined ? {} : { model: fold.model }),
    createdAt: isoOrUndefined(header.timestamp) ?? mtimeIso,
    updatedAt: fold.lastMessageAt ?? isoOrUndefined(header.timestamp) ?? mtimeIso,
    status: 'idle',
    ...(view.windowTruncated ? {} : { messageCount: fold.messageCount }),
    ...(parentId === undefined ? {} : { parentNativeId: nativeSessionId(parentId) }),
    source: header.parentSession === undefined ? 'omp' : 'omp:fork',
    ...(fold.usage === undefined ? {} : { usage: fold.usage }),
    binding: { runIds: [] },
    notes,
  }
}

/**
 * The title a session file records: the fixed-width slot is the current title and wins
 * over the entries; a `title_change` inside the window is the audit trail, and the
 * header's folded title is the fallback (a rename updates the slot without rewriting
 * the body, so the slot is the authoritative copy).
 *
 * @param view - A read window.
 * @param fold - Its folded state.
 * @returns The title, or `undefined` when the session has none.
 */
function titleOf(view: OmpSessionView, fold: OmpSessionFold): string | undefined {
  const slot = view.titleSlot
  if (slot !== undefined && slot.title.trim() !== '') return slot.title.trim()
  return fold.title
}

/** Whether a file name is an OMP session file. */
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

/** The session id behind a header `parentSession` value, when it can be recovered. */
function idFromSessionReference(reference: string): string | undefined {
  const lastSegment = reference.split(/[/\\]/).pop()
  if (lastSegment === undefined || lastSegment === '') return undefined
  if (!isSessionFileName(lastSegment)) return reference
  return idFromFileName(lastSegment) ?? reference
}

/** Everything `readOmpTranscript` returns, mirroring the SPI's transcript result. */
export interface OmpTranscript {
  messages: readonly AgentMessage[]
  totalMessages?: number
  hasMore: boolean
  notes: readonly ProjectionNote[]
}

/**
 * Read a bounded transcript window along the live branch.
 *
 * @param ctx - Adapter context.
 * @param nativeId - OMP session id, or a session file path.
 * @param options - Message and byte caps.
 * @param env - Environment to resolve the store from; defaults to the host's.
 * @returns The window, oldest first, with declared gaps.
 */
export async function readOmpTranscript(
  ctx: AdapterContext,
  nativeId: NativeSessionId,
  options: ReadTranscriptOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OmpTranscript> {
  const path = await findOmpSessionFile(ctx, nativeId, env)
  if (path === undefined) {
    return {
      messages: [],
      hasMore: false,
      notes: [{ field: '*', reason: `no session file was found for ${String(nativeId)}` }],
    }
  }
  const view = await readOmpSessionView(ctx, path, options.maxBytes ?? DEFAULT_TRANSCRIPT_BYTES)
  if (view.missing) {
    return {
      messages: [],
      hasMore: false,
      notes: [{ field: '*', reason: 'the session file disappeared during the read' }],
    }
  }

  const branch = ompBranch(view)
  const counters = ompProjectionCounters()
  const drafts: OmpProjectedMessage[] = []
  for (const entry of branch.chain) {
    for (const item of projectOmpEntry(entry, counters)) drafts.push(item)
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
    ...(draft.paths === undefined ? {} : { paths: draft.paths }),
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
  const fold = foldOmpEntries(branch.chain, view.header)
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

function countMessageEntries(entries: readonly OmpNativeEntry[]): number {
  let count = 0
  for (const entry of entries) if (entry.type === 'message') count += 1
  return count
}

/**
 * Locate a session file for a native id, or for a path given verbatim.
 *
 * There is no session index in the adapter's reach — `history.db`'s `session_titles`
 * table is a title index, not a path index, and `agent.db` is the credential store —
 * so this is a bounded directory scan: first by the
 * `<timestamp>_<id>.jsonl` file-name convention (cheap and exact), then by probing
 * headers when the name convention does not match.
 *
 * @param ctx - Adapter context.
 * @param nativeId - Session id or file path.
 * @param env - Environment to resolve the store from; defaults to the host's.
 * @returns The absolute path, or `undefined` when no file matches.
 */
export async function findOmpSessionFile(
  ctx: AdapterContext,
  nativeId: NativeSessionId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const raw = String(nativeId)
  if (raw.includes('/') || raw.includes('\\') || raw.endsWith('.jsonl')) {
    const candidate = ctx.files.resolvePath(raw)
    return (await ctx.files.isFile(candidate)) ? candidate : undefined
  }

  const layout = await resolveOmpStore(ctx, env)
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
    const header = await readOmpSessionHeaderAt(ctx, candidate.path)
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
 * Read OMP's own todo/plan state for a session. Read-only.
 *
 * OMP has a native `todo` tool: each committed snapshot is either a `custom` entry
 * with `customType: "user_todo_edit"` (the SDK/UI edit path) or the `details.phases`
 * of a successful `todo` tool result, and OMP's own restoration scans backward for the
 * latest of either. Plan mode is recorded as `mode_change` entries whose `mode` is
 * `plan` (active) or `plan_paused`, with the plan file path in `data.planFilePath`.
 *
 * @param ctx - Adapter context.
 * @param agent - This adapter's canonical agent id.
 * @param nativeId - Session id or file path.
 * @param env - Environment to resolve the store from; defaults to the host's.
 * @returns The observed state, or `undefined` when the session records neither.
 */
export async function readOmpNativeTasks(
  ctx: AdapterContext,
  agent: AgentId,
  nativeId: NativeSessionId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeTaskState | undefined> {
  const path = await findOmpSessionFile(ctx, nativeId, env)
  if (path === undefined) return undefined
  const view = await readOmpSessionView(ctx, path, DEFAULT_TRANSCRIPT_BYTES)
  if (view.missing || view.header === undefined) return undefined
  const branch = ompBranch(view)
  const observedIn = sessionKey(agent, nativeSessionId(view.header.id))
  const notes: ProjectionNote[] = []

  let todos: readonly AgentTodo[] = []
  let sawTodos = false
  for (const entry of branch.chain) {
    const snapshot = todoSnapshot(entry, agent, observedIn)
    if (snapshot === undefined) continue
    sawTodos = true
    todos = snapshot
  }
  if (sawTodos) {
    notes.push({
      field: 'todos',
      reason: "omp's todo model carries no dependency edges, so every item has an empty blockedBy",
    })
  }

  const fold = foldOmpEntries(branch.chain)
  const plan =
    fold.mode === undefined
      ? undefined
      : {
          active: PLAN_MODES.includes(fold.mode),
          items: fold.planFilePath === undefined ? [] : [fold.planFilePath],
        }
  if (plan !== undefined && fold.planFilePath === undefined) {
    notes.push({
      field: 'plan',
      reason: 'the plan-mode transition recorded no plan file path, so the plan body has no locator here',
    })
  }
  if (plan !== undefined && plan.items.length > 0) {
    notes.push({
      field: 'plan',
      reason: "omp records the plan's file path, not its text; the path is reported verbatim and the file is not read",
    })
  }
  if (branch.abandoned > 0) {
    notes.push({
      field: 'todos',
      reason: `${branch.abandoned} entries on abandoned branches are excluded from this reading`,
    })
  }

  if (!sawTodos && plan === undefined) return undefined
  return { todos, ...(plan === undefined ? {} : { plan }), notes }
}

/**
 * The todo snapshot one entry commits, when it commits one.
 *
 * @param entry - A session entry on the live branch.
 * @param agent - This adapter's canonical agent id, the items' owner.
 * @param observedIn - Canonical session key the items were observed in.
 * @returns The projected items, or `undefined` when the entry carries no snapshot.
 */
function todoSnapshot(
  entry: OmpNativeEntry,
  agent: AgentId,
  observedIn: AgentTodo['observedIn'],
): readonly AgentTodo[] | undefined {
  if (entry.type === 'custom') {
    if (readString(entry.record, 'customType') !== 'user_todo_edit') return undefined
    const data = readRecord(entry.record, 'data')
    const phases = data === undefined ? undefined : readArray(data, 'phases')
    return phases === undefined ? undefined : todosFromPhases(phases, entry.timestamp, agent, observedIn)
  }
  if (entry.type !== 'message') return undefined
  const message = readRecord(entry.record, 'message')
  if (message === undefined || readString(message, 'role') !== 'toolResult') return undefined
  if (readString(message, 'toolName') !== 'todo' || readBoolean(message, 'isError') === true) return undefined
  const details = readRecord(message, 'details')
  if (details === undefined || readString(details, 'op') === 'view') return undefined
  const phases = readArray(details, 'phases')
  return phases === undefined ? undefined : todosFromPhases(phases, entry.timestamp, agent, observedIn)
}

/** Project OMP's `TodoPhase[]` onto canonical items, in phase then task order. */
function todosFromPhases(
  phases: readonly unknown[],
  fallbackTime: string,
  agent: AgentId,
  observedIn: AgentTodo['observedIn'],
): readonly AgentTodo[] {
  const updatedAt = isoOrUndefined(fallbackTime) ?? new Date(0).toISOString()
  const items: AgentTodo[] = []
  for (const phase of phases) {
    if (!isRecord(phase)) continue
    const phaseName = readString(phase, 'name') ?? ''
    const tasks = readArray(phase, 'tasks')
    if (tasks === undefined) continue
    for (const task of tasks) {
      if (!isRecord(task)) continue
      const content = readString(task, 'content')
      if (content === undefined || content === '') continue
      const nativeKey = `${phaseName}/${content}`
      items.push({
        id: todoId(`omp:${observedIn === undefined ? 'session' : String(observedIn)}:${nativeKey}`),
        content,
        status: todoStatusOf(readString(task, 'status')),
        owner: agent,
        blockedBy: [],
        updatedAt,
        ...(observedIn === undefined ? {} : { observedIn }),
        nativeKey,
      })
    }
  }
  return items
}

/** OMP's todo status vocabulary mapped onto the canonical one. */
function todoStatusOf(status: string | undefined): TodoStatus {
  switch (status) {
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'abandoned':
      // OMP retires a task with `abandoned`; the canonical vocabulary calls that cancelled.
      return 'cancelled'
    default:
      return 'pending'
  }
}
