/**
 * OMP's `--mode json` event stream mapped onto the canonical run-event union
 * (ADR-0003). One record per line: the first is the session header, and every later
 * record is an `AgentSessionEvent` serialized through OMP's `printableEvent`, which
 * strips the `message_update` partial-message snapshots and the provider replay
 * payload but keeps each incremental delta.
 *
 * Mapping rules, all verified against oh-my-pi 18.11.0
 * (`packages/coding-agent/src/modes/print-mode.ts`,
 * `packages/coding-agent/src/session/agent-session-events.ts`):
 *
 * | OMP record | Canonical event |
 * |---|---|
 * | session header `{type:'session',id,cwd}` | `session.bound` |
 * | `message_update` + `assistantMessageEvent.text_delta` | `message.delta` |
 * | `message_update` + `assistantMessageEvent.thinking_delta` | `reasoning.delta` |
 * | `message_update` + `assistantMessageEvent.error` | `warning` |
 * | `message_end` (assistant) | `message.completed`, `usage.updated` |
 * | `tool_execution_start` | `tool.started` |
 * | `tool_execution_end` | `tool.completed` |
 * | `todo_reminder` | `todos.updated` |
 * | `todo_auto_clear` | `todos.updated` (empty) |
 * | `auto_compaction_start` / `auto_compaction_end` (failure) | `warning` |
 * | `auto_retry_start` / `auto_retry_end` (failure) | `warning` |
 * | `retry_fallback_applied` | `warning` |
 * | `notice` | `warning` |
 * | `agent_end` | the settle boundary (recorded, not emitted) |
 * | `thinking_level_changed`, `model_changed`, `ttsr_triggered`, retry/cache/advisor telemetry | `unknown` |
 * | anything unrecognized | `unknown` |
 *
 * Deliberate no-ops, kept out of the stream so the run record is not noise: lifecycle
 * records with no content (`agent_start`, `turn_start`, `turn_end`, `message_start`,
 * `queue_update`), records whose content arrives again on a boundary the adapter
 * already maps (`tool_execution_update`, `tool_stream_update`, `message_update`
 * with `toolcall_*`/`*_start`/`*_end`/`done`, the prompt echo of a `message_end`
 * with role `user`, and the duplicate result of a tool call in a `message_end` with
 * role `toolResult`), and the telemetry-only `advisor_*`, `config_warnings_changed`,
 * `cache_warming_*` records.
 *
 * Two OMP shape facts shape the code: `message_update` in JSON mode carries only the
 * delta (its `partial` snapshot is stripped), so `toolcall_start` cannot name the tool
 * and the authoritative announcement is `tool_execution_start`; and OMP's idle boundary
 * is `agent_end` with `isTerminal !== false` — the `agent_settled` event pi 1.2 emitted
 * does not exist here.
 *
 * @module @zorker/muti-agent-adapter-omp/events
 */
import { type AgentRunEvent, type RunId, type SessionUsage } from '@zorker/muti-agent-contracts';
import { type OmpSessionHeader } from './sessions.ts';
/** Run state the projection accumulates for the terminal result. */
export interface OmpRunState {
    /** Native session id from the header, once it has been seen. */
    sessionId?: string;
    /** Header of the session this run wrote into. */
    header?: OmpSessionHeader;
    /** Assistant text of the last completed message. */
    finalText?: string;
    /** Usage summed over completed assistant messages. */
    usage?: SessionUsage;
    /** `stopReason` of the last completed assistant message. */
    lastStopReason?: string;
    /** Provider message of the last failed assistant message, verbatim. */
    lastErrorMessage?: string;
    /** Whether OMP reported a terminal (non-continuing) `agent_end`. */
    settled: boolean;
    /** Whether the last turn ended aborted rather than stopping cleanly. */
    aborted: boolean;
    /** Tool calls completed. */
    toolCalls: number;
    /** Tool calls that finished with an error. */
    toolFailures: number;
    /** Cache-write tokens, which `SessionUsage` cannot carry. */
    cacheWriteTokens: number;
    /** Projection gaps worth recording on the run result. */
    notes: string[];
}
/**
 * Maps OMP's JSON event stream onto canonical events, accumulating the run state a
 * terminal result needs.
 *
 * The projection is single-run state: one instance per `AdapterRun`.
 */
export declare class OmpRunProjection {
    private readonly runId;
    private readonly runState;
    private readonly usageTotals;
    /**
     * @param runId - Run id echoed on every emitted event.
     */
    constructor(runId: RunId);
    /** A read-only snapshot of the accumulated state. */
    state(): Readonly<OmpRunState>;
    /**
     * Map one stdout record.
     *
     * @param value - Decoded JSON record; a malformed line never reaches this method.
     * @param raw - The raw line, bounded, for `unknown` projection.
     * @param at - ISO 8601 time to stamp on emitted events.
     * @returns The events to emit, in order; empty for a declared no-op.
     */
    observe(value: unknown, raw: string, at: string): readonly AgentRunEvent[];
    /**
     * Record a diagnostic the run loop detected outside the stream.
     *
     * @param message - What happened, phrased for a human.
     * @param at - ISO 8601 time to stamp on the event.
     * @returns The warning event to emit.
     */
    warn(message: string, at: string): AgentRunEvent;
    /**
     * Record a projection gap on the terminal result.
     *
     * @param note - One line describing the gap.
     */
    addNote(note: string): void;
    /** Map `message_update`, which carries delta-only content in JSON mode. */
    private mapMessageUpdate;
    /** Map `message_end`, the authoritative message boundary. */
    private mapMessageEnd;
    /** Add a native `Usage` record to the run totals and project the running total. */
    private accumulateUsage;
    private warning;
    private unknown;
}
//# sourceMappingURL=events.d.ts.map