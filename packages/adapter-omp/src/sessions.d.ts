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
import { type AgentId, type AgentMessage, type AgentSession, type MessageKind, type NativeSessionId, type ProjectionNote, type SessionUsage } from '@zorker/muti-agent-contracts';
import { type AdapterContext, type ListSessionsOptions, type NativeTaskState, type ReadTranscriptOptions } from '@zorker/muti-agent-core';
/** Session file format version this reader was verified against. */
export declare const OMP_SESSION_VERSION = 3;
/** Bytes of the fixed-width title slot at the head of a current session file. */
export declare const OMP_TITLE_SLOT_BYTES = 256;
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
    sessionDir?: string;
    /**
     * Whether a credential supplied by the host environment is forwarded to a run.
     * Off by default: ADR-0014 makes credential passthrough an explicit per-adapter
     * opt-in, and the `minimal`/`inherit-agent` env derivation filters provider keys.
     */
    inheritCredentialEnv: boolean;
}
/**
 * Validate this adapter's settings.
 *
 * @param settings - Raw settings from the host configuration.
 * @returns The validated settings, with defaults applied.
 */
export declare function parseOmpSettings(settings: Readonly<Record<string, unknown>>): OmpAdapterSettings;
/**
 * The ambient services the store resolver and the catalog reader actually use.
 *
 * Narrower than `AdapterContext` on purpose: a host that only reads OMP's
 * configuration — the harness LLM registration — supplies a file probe, a logger and
 * a runtime config, and must not have to fake a process runner it never calls.
 */
export type OmpReadContext = Pick<AdapterContext, 'log' | 'config' | 'files'>;
/** Where a machine keeps OMP's configuration, sessions and credential store. */
export interface OmpStoreLayout {
    /** Resolved agent config directory (`~/.omp/agent` or its profile/override form). */
    agentDir: string;
    /** Config root the agent directory hangs off (`~/.omp`, or `$HOME/$PI_CONFIG_DIR`). */
    configRoot: string;
    /** Active named profile, when one is selected. */
    profile?: string;
    /** Root holding one directory per project, plus any stray session files. */
    defaultSessionsRoot: string;
    /** Flat session directory in force, when the adapter or the host configured one. */
    sessionDirOverride?: string;
    /** Whether the override came from the adapter's own `sessionDir` setting. */
    sessionsDirFromSetting: boolean;
    /** Whether the agent directory came from an override rather than the default. */
    agentDirFromEnv: boolean;
    /** `agent.db`, OMP's SQLite store holding the credential rows. */
    credentialPath: string;
    /** `config.yml`, the primary settings file (else its `config.yaml` sibling). */
    settingsPath: string;
    /** `models.yml`, the primary provider/model file (else its `models.yaml` sibling). */
    modelsPath: string;
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
export declare function resolveOmpStore(ctx: OmpReadContext, env?: NodeJS.ProcessEnv): Promise<OmpStoreLayout>;
/**
 * The named profile the environment selects, normalized as OMP does: `OMP_PROFILE`
 * wins over the legacy `PI_PROFILE`, and the explicit `default` sentinel selects the
 * default profile.
 *
 * @param env - Host environment.
 * @returns The profile name, or `undefined` for the default profile.
 */
export declare function activeProfile(env: NodeJS.ProcessEnv): string | undefined;
/**
 * Whether a decoded JSON value is a plain object.
 *
 * @param value - Value to test.
 * @returns `true` for a non-null, non-array object.
 */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * Read a string field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent or not a string.
 */
export declare function readString(source: Record<string, unknown>, key: string): string | undefined;
/**
 * Read a finite number field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent or not a finite number.
 */
export declare function readNumber(source: Record<string, unknown>, key: string): number | undefined;
/**
 * Read a boolean field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent or not a boolean.
 */
export declare function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined;
/**
 * Read an object field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The nested object, or `undefined`.
 */
export declare function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined;
/**
 * Read an array field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The array, or `undefined`.
 */
export declare function readArray(source: Record<string, unknown>, key: string): readonly unknown[] | undefined;
/** The fixed-width current-title slot that physically heads a current session file. */
export interface OmpTitleSlot {
    /** Current session title, verbatim. */
    title: string;
    /** Who set it: `auto` (titler) or `user` (an explicit rename). */
    source?: string;
    /** ISO 8601 time the slot was last written. */
    updatedAt?: string;
}
/**
 * Parse the physical title slot.
 *
 * @param value - Decoded JSON of the first line.
 * @returns The slot, or `undefined` when the line is not the title slot.
 */
export declare function readOmpTitleSlot(value: unknown): OmpTitleSlot | undefined;
/** The logical first record of an OMP session file. */
export interface OmpSessionHeader {
    /** Session id, verbatim. */
    id: string;
    /** Creation time, verbatim ISO 8601. */
    timestamp: string;
    /** Absolute working directory the session was started in; empty on very old files. */
    cwd: string;
    /** Session title folded into the header by OMP's loaders, when it carries one. */
    title?: string;
    /** Who set the folded title. */
    titleSource?: string;
    /** Path or id of the session this one was forked from, when it was. */
    parentSession?: string;
    /** Native format version; absent on v1 files. */
    version?: number;
    /** Extra workspace roots beyond `cwd`, which `AgentSession` has no field for. */
    additionalDirectories: number;
    /** Previous absolute locations recorded by successful moves. */
    previousSessionFiles: number;
    /** Whether a inherited provider prompt-cache identity is recorded (a local-only field). */
    hasProviderPromptCacheKey: boolean;
}
/**
 * Parse a session header.
 *
 * @param value - Decoded JSON of the header line.
 * @returns The header, or `undefined` when the line is not a session header.
 */
export declare function readOmpSessionHeader(value: unknown): OmpSessionHeader | undefined;
/** One parsed session entry, in file order, with its bounded raw line. */
export interface OmpNativeEntry {
    /** Entry id, verbatim. */
    id: string;
    /** Parent entry id; `null` at a branch root or for the first entry. */
    parentId: string | null;
    /** Entry timestamp, verbatim ISO 8601 (empty when the file omits it). */
    timestamp: string;
    /** Entry type, verbatim. */
    type: string;
    /** Decoded record, for field access. */
    record: Record<string, unknown>;
    /** Raw JSONL line, truncated for diagnostics only. */
    raw: string;
}
/**
 * Parse one session entry.
 *
 * @param value - Decoded JSON of a non-header line.
 * @param raw - The raw line, retained bounded for `unknown` projections.
 * @returns The entry, or `undefined` when the line is not an entry.
 */
export declare function readOmpEntry(value: unknown, raw: string): OmpNativeEntry | undefined;
/** One bounded read of a session file. */
export interface OmpSessionView {
    /** The physical title slot, when the read window contained it. */
    titleSlot?: OmpTitleSlot;
    /** Session header, when the read window contained it. */
    header?: OmpSessionHeader;
    /** Entries in the read window, in file order. */
    entries: readonly OmpNativeEntry[];
    /** Whether earlier file content was outside the window. */
    windowTruncated: boolean;
    /** Whether the window dropped a leading partial line. */
    droppedPartialLine: boolean;
    /** File size at read time, or `-1` when absent. */
    size: number;
    /** File modification time in milliseconds. */
    mtimeMs: number;
    /** JSON lines in the window that did not parse as the slot, the header or an entry. */
    malformed: number;
    /** Whether the file was absent. */
    missing: boolean;
    /** Declared gaps produced while reading. */
    notes: readonly ProjectionNote[];
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
export declare function readOmpSessionView(ctx: AdapterContext, path: string, maxBytes: number): Promise<OmpSessionView>;
/**
 * Read only the slot and header of a session file, for by-id lookups and resume checks.
 *
 * @param ctx - Adapter context.
 * @param path - Absolute session file path.
 * @returns The slot and header, each absent when its line is missing or unreadable.
 */
export declare function readOmpSessionLeadAt(ctx: AdapterContext, path: string): Promise<{
    titleSlot?: OmpTitleSlot;
    header?: OmpSessionHeader;
}>;
/**
 * Read only the header of a session file, for by-id lookups and resume checks.
 *
 * @param ctx - Adapter context.
 * @param path - Absolute session file path.
 * @returns The header, or `undefined` when no complete header line was read.
 */
export declare function readOmpSessionHeaderAt(ctx: AdapterContext, path: string): Promise<OmpSessionHeader | undefined>;
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
export declare function encodeCwdDirName(cwd: string, options?: {
    home?: string;
    tempRoot?: string;
}): string;
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
export declare function decodeCwdDirName(name: string, options?: {
    home?: string;
    tempRoot?: string;
}): string | undefined;
/** A session's state as folded from one read window. */
export interface OmpSessionFold {
    /** Latest title: a `title_change` in the window, else the folded header title. */
    title?: string;
    /** Latest `model_change` selector, else the last assistant message's `provider/model`. */
    model?: string;
    /** Usage summed over the window (assistant messages and `model_usage` entries). */
    usage?: SessionUsage;
    /** `message` entries seen in the window. */
    messageCount: number;
    /** Latest user/assistant message time in the window, ISO 8601. */
    lastMessageAt?: string;
    /** Latest `mode_change` mode name, verbatim (`none` means no mode is active). */
    mode?: string;
    /** Plan file path recorded alongside a plan-mode transition. */
    planFilePath?: string;
    /** Records the canonical projection has no field for. */
    images: number;
    /** `model_usage` entries in the window (out-of-transcript accounting). */
    modelUsageEntries: number;
    /** `session_init` entries in the window (subagent bootstrap records). */
    sessionInitEntries: number;
    /** `reset_boundary` entries in the window. */
    resetBoundaries: number;
    /** `compaction` entries in the window. */
    compactions: number;
    /** `ttsr_injection` entries in the window. */
    ttsrInjections: number;
    /** `credential_pin` entries in the window (pseudonymous account pins). */
    credentialPins: number;
    /** Cache-write tokens seen, which `SessionUsage` cannot carry. */
    cacheWriteTokens: number;
    /** Entry types this reader does not model, distinct, at most a handful. */
    unknownEntryTypes: readonly string[];
}
/**
 * Fold a read window into session state.
 *
 * @param entries - Entries in file order.
 * @param header - The header, when the window held it.
 * @returns The folded state.
 */
export declare function foldOmpEntries(entries: readonly OmpNativeEntry[], header?: OmpSessionHeader): OmpSessionFold;
/** The live conversation of a session file. */
export interface OmpBranch {
    /** Entries on the branch that ends at the live leaf, in conversation order. */
    chain: readonly OmpNativeEntry[];
    /** Entries in the window that belong to abandoned branches. */
    abandoned: number;
    /** Whether the chain start is outside the read window or a parent link is missing. */
    truncated: boolean;
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
export declare function ompBranch(view: OmpSessionView): OmpBranch;
/** A projected message, before the reader assigns its window index. */
export interface OmpProjectedMessage {
    /** Entry id, or a derived `entryId:blockIndex` for a multi-block entry. */
    id?: string;
    role: AgentMessage['role'];
    kind: MessageKind;
    text?: string;
    timestamp?: string;
    tool?: {
        name: string;
        input?: string;
        output?: string;
        failed?: boolean;
    };
    /** Paths a `fileMention` message inlined, which only `file-change` carries. */
    paths?: readonly string[];
    nativeType?: string;
}
/** Counters a projection run accumulates, so the reader can declare what it dropped. */
export interface OmpProjectionCounters {
    /** Image blocks seen, which the canonical message has no field for. */
    images: number;
    /** Content block types this adapter does not model. */
    unknownBlocks: number;
    /** Message roles this adapter does not model. */
    unknownRoles: number;
}
/**
 * Allocate zeroed projection counters.
 *
 * @returns Fresh counters for one projection run.
 */
export declare function ompProjectionCounters(): OmpProjectionCounters;
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
export declare function projectOmpEntry(entry: OmpNativeEntry, counters: OmpProjectionCounters): readonly OmpProjectedMessage[];
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
export declare function listOmpSessions(ctx: AdapterContext, agent: AgentId, options: ListSessionsOptions, env?: NodeJS.ProcessEnv): Promise<readonly AgentSession[]>;
/** Everything `readOmpTranscript` returns, mirroring the SPI's transcript result. */
export interface OmpTranscript {
    messages: readonly AgentMessage[];
    totalMessages?: number;
    hasMore: boolean;
    notes: readonly ProjectionNote[];
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
export declare function readOmpTranscript(ctx: AdapterContext, nativeId: NativeSessionId, options: ReadTranscriptOptions, env?: NodeJS.ProcessEnv): Promise<OmpTranscript>;
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
export declare function findOmpSessionFile(ctx: AdapterContext, nativeId: NativeSessionId, env?: NodeJS.ProcessEnv): Promise<string | undefined>;
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
export declare function readOmpNativeTasks(ctx: AdapterContext, agent: AgentId, nativeId: NativeSessionId, env?: NodeJS.ProcessEnv): Promise<NativeTaskState | undefined>;
//# sourceMappingURL=sessions.d.ts.map