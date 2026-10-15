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

import { nativeSessionId, type AgentRunEvent, type RunId, type SessionUsage } from '@zorker/muti-agent-contracts'
import {
  isRecord,
  readArray,
  readNumber,
  readOmpSessionHeader,
  readRecord,
  readString,
  type OmpSessionHeader,
} from './sessions.ts'

/** Characters of a native record retained inside an `unknown` event. */
const MAX_NATIVE_CHARS = 4_000

/** Run state the projection accumulates for the terminal result. */
export interface OmpRunState {
  /** Native session id from the header, once it has been seen. */
  sessionId?: string
  /** Header of the session this run wrote into. */
  header?: OmpSessionHeader
  /** Assistant text of the last completed message. */
  finalText?: string
  /** Usage summed over completed assistant messages. */
  usage?: SessionUsage
  /** `stopReason` of the last completed assistant message. */
  lastStopReason?: string
  /** Provider message of the last failed assistant message, verbatim. */
  lastErrorMessage?: string
  /** Whether OMP reported a terminal (non-continuing) `agent_end`. */
  settled: boolean
  /** Whether the last turn ended aborted rather than stopping cleanly. */
  aborted: boolean
  /** Tool calls completed. */
  toolCalls: number
  /** Tool calls that finished with an error. */
  toolFailures: number
  /** Cache-write tokens, which `SessionUsage` cannot carry. */
  cacheWriteTokens: number
  /** Projection gaps worth recording on the run result. */
  notes: string[]
}

/**
 * Maps OMP's JSON event stream onto canonical events, accumulating the run state a
 * terminal result needs.
 *
 * The projection is single-run state: one instance per `AdapterRun`.
 */
export class OmpRunProjection {
  private readonly runState: OmpRunState = {
    settled: false,
    aborted: false,
    toolCalls: 0,
    toolFailures: 0,
    cacheWriteTokens: 0,
    notes: [],
  }

  private readonly usageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    costUsd: 0,
  }

  /**
   * @param runId - Run id echoed on every emitted event.
   */
  constructor(private readonly runId: RunId) {}

  /** A read-only snapshot of the accumulated state. */
  state(): Readonly<OmpRunState> {
    return this.runState
  }

  /**
   * Map one stdout record.
   *
   * @param value - Decoded JSON record; a malformed line never reaches this method.
   * @param raw - The raw line, bounded, for `unknown` projection.
   * @param at - ISO 8601 time to stamp on emitted events.
   * @returns The events to emit, in order; empty for a declared no-op.
   */
  observe(value: unknown, raw: string, at: string): readonly AgentRunEvent[] {
    const header = readOmpSessionHeader(value)
    if (header !== undefined) {
      this.runState.header = header
      this.runState.sessionId = header.id
      return [
        {
          kind: 'session.bound',
          runId: this.runId,
          at,
          nativeSessionId: nativeSessionId(header.id),
          ...(header.title === undefined ? {} : { title: header.title }),
        },
      ]
    }
    if (!isRecord(value)) {
      // A JSON line that is not an object (for example a bare `null`) is preserved.
      return [this.unknown(undefined, raw, at)]
    }

    const type = readString(value, 'type')
    if (type === undefined) {
      this.addNote('a stdout record had no event type and was preserved as an unknown event')
      return [this.unknown(undefined, raw, at)]
    }

    switch (type) {
      case 'message_update':
        return this.mapMessageUpdate(value, raw, at)
      case 'message_end':
        return this.mapMessageEnd(value, raw, at)
      case 'tool_execution_start': {
        const callId = readString(value, 'toolCallId')
        const args = value.args
        return [
          {
            kind: 'tool.started',
            runId: this.runId,
            at,
            ...(callId === undefined ? {} : { callId }),
            toolName: readString(value, 'toolName') ?? 'tool',
            ...(args === undefined ? {} : { input: boundedJson(args) }),
          },
        ]
      }
      case 'tool_execution_end': {
        this.runState.toolCalls += 1
        const failed = value.isError === true
        if (failed) this.runState.toolFailures += 1
        const result = value.result
        const callId = readString(value, 'toolCallId')
        return [
          {
            kind: 'tool.completed',
            runId: this.runId,
            at,
            ...(callId === undefined ? {} : { callId }),
            toolName: readString(value, 'toolName') ?? 'tool',
            ...(result === undefined ? {} : { output: boundedJson(result) }),
            ...(failed ? { failed: true } : {}),
          },
        ]
      }
      case 'todo_reminder': {
        const todos = (readArray(value, 'todos') ?? [])
          .map(item => (isRecord(item) ? { content: readString(item, 'content'), status: readString(item, 'status') } : undefined))
          .filter(
            (item): item is { content: string; status: string } =>
              item !== undefined && item.content !== undefined && item.status !== undefined,
          )
        if (todos.length === 0) return [this.unknown(type, raw, at)]
        return [{ kind: 'todos.updated', runId: this.runId, at, todos }]
      }
      case 'todo_auto_clear':
        return [{ kind: 'todos.updated', runId: this.runId, at, todos: [] }]
      case 'auto_compaction_start':
        return [
          this.warning(
            `omp started compacting the conversation (${readString(value, 'action') ?? 'unknown'} action, ` +
              `${readString(value, 'reason') ?? 'unknown'} reason)`,
            at,
          ),
        ]
      case 'auto_compaction_end': {
        if (value.aborted === true) return []
        const errorMessage = readString(value, 'errorMessage')
        if (errorMessage === undefined) return []
        this.addNote(`omp's compaction failed: ${errorMessage}`)
        return [this.warning(`omp's compaction failed: ${errorMessage}`, at)]
      }
      case 'auto_retry_start': {
        const attempt = readNumber(value, 'attempt')
        const max = readNumber(value, 'maxAttempts')
        const message = readString(value, 'errorMessage') ?? 'provider error'
        return [this.warning(`omp is retrying after ${message} (attempt ${attempt ?? '?'}/${max ?? '?'})`, at)]
      }
      case 'auto_retry_end': {
        if (value.success === true) return []
        const finalError = readString(value, 'finalError') ?? 'the retry budget was exhausted'
        this.addNote(`omp's automatic retry failed: ${finalError}`)
        return [this.warning(`omp's automatic retry failed: ${finalError}`, at)]
      }
      case 'retry_fallback_applied': {
        const from = readString(value, 'from') ?? 'the configured model'
        const to = readString(value, 'to') ?? 'a fallback model'
        const reason = readString(value, 'reason')
        return [
          this.warning(`omp switched from ${from} to ${to}${reason === undefined ? '' : ` (${reason})`}`, at),
        ]
      }
      case 'notice': {
        const level = readString(value, 'level') ?? 'info'
        const message = readString(value, 'message') ?? 'a session notice'
        const source = readString(value, 'source')
        return [this.warning(`omp ${level} notice${source === undefined ? '' : ` from ${source}`}: ${message}`, at)]
      }
      case 'agent_end': {
        // OMP's idle boundary: `isTerminal` is false only while the session resumes
        // its own work (retry, compaction continuation, a scheduled follow-up).
        const continuing = value.isTerminal === false
        if (!continuing) this.runState.settled = true
        return []
      }
      // Lifecycle records with no content and no consumer-visible state.
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'queue_update':
      case 'tool_execution_update':
      case 'tool_stream_update':
      case 'config_warnings_changed':
      case 'advisor_cost_changed':
      case 'advisor_yielded':
        return []
      // Records this adapter models as state but the canonical union cannot carry.
      case 'thinking_level_changed':
      case 'model_changed':
      case 'ttsr_triggered':
      case 'goal_updated':
      case 'irc_message':
      case 'cache_warming_start':
      case 'cache_warming_end':
      case 'retry_fallback_succeeded':
        return [this.unknown(type, raw, at)]
      default:
        this.addNote(`an unrecognized omp event type (${type}) was preserved as an unknown event`)
        return [this.unknown(type, raw, at)]
    }
  }

  /**
   * Record a diagnostic the run loop detected outside the stream.
   *
   * @param message - What happened, phrased for a human.
   * @param at - ISO 8601 time to stamp on the event.
   * @returns The warning event to emit.
   */
  warn(message: string, at: string): AgentRunEvent {
    return this.warning(message, at)
  }

  /**
   * Record a projection gap on the terminal result.
   *
   * @param note - One line describing the gap.
   */
  addNote(note: string): void {
    if (!this.runState.notes.includes(note)) this.runState.notes.push(note)
  }

  /** Map `message_update`, which carries delta-only content in JSON mode. */
  private mapMessageUpdate(value: Record<string, unknown>, raw: string, at: string): readonly AgentRunEvent[] {
    const deltaEvent = readRecord(value, 'assistantMessageEvent')
    if (deltaEvent === undefined) return [this.unknown('message_update', raw, at)]
    const deltaType = readString(deltaEvent, 'type')
    switch (deltaType) {
      case 'text_delta': {
        const text = readString(deltaEvent, 'delta')
        return text === undefined ? [] : [{ kind: 'message.delta', runId: this.runId, at, text }]
      }
      case 'thinking_delta': {
        const text = readString(deltaEvent, 'delta')
        return text === undefined ? [] : [{ kind: 'reasoning.delta', runId: this.runId, at, text }]
      }
      case 'error': {
        const reason = readString(deltaEvent, 'reason') ?? 'error'
        this.runState.lastStopReason = reason
        this.runState.aborted = reason === 'aborted'
        return [this.warning(`the assistant response failed (${reason})`, at)]
      }
      case 'done':
        // `message_end` carries the authoritative message and its usage.
        return []
      case 'start':
      case 'text_start':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_end':
      case 'image_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        // `toolcall_*` deltas cannot name the tool in JSON mode (`partial` is stripped),
        // so `tool_execution_start` is the one announcement per call.
        return []
      default:
        return [this.unknown(deltaType === undefined ? 'message_update' : `message_update:${deltaType}`, raw, at)]
    }
  }

  /** Map `message_end`, the authoritative message boundary. */
  private mapMessageEnd(value: Record<string, unknown>, raw: string, at: string): readonly AgentRunEvent[] {
    const message = readRecord(value, 'message')
    if (message === undefined) return [this.unknown('message_end', raw, at)]
    switch (readString(message, 'role') ?? '') {
      case 'assistant': {
        const events: AgentRunEvent[] = []
        const text = assistantText(message)
        if (text !== undefined && text !== '') {
          this.runState.finalText = text
          events.push({ kind: 'message.completed', runId: this.runId, at, text })
        }
        const stopReason = readString(message, 'stopReason')
        if (stopReason !== undefined) {
          this.runState.lastStopReason = stopReason
          this.runState.aborted = stopReason === 'aborted'
        }
        const errorMessage = readString(message, 'errorMessage')
        if (errorMessage !== undefined && errorMessage !== '') {
          this.runState.lastErrorMessage = errorMessage
          events.push(this.warning(`omp reported: ${errorMessage}`, at))
        }
        const usage = this.accumulateUsage(readRecord(message, 'usage'))
        if (usage !== undefined) events.push({ kind: 'usage.updated', runId: this.runId, at, usage })
        return events
      }
      case 'user':
        // The prompt echo: the caller already holds the text it sent.
        return []
      case 'toolResult':
        // Already reported by `tool_execution_end`.
        return []
      case 'bashExecution':
      case 'pythonExecution':
      case 'fileMention':
      case 'developer':
      case 'custom':
      case 'hookMessage':
        // Conversation records the transcript reader projects; the run stream already
        // announced the tool work they describe.
        return []
      default:
        return [this.unknown('message_end', raw, at)]
    }
  }

  /** Add a native `Usage` record to the run totals and project the running total. */
  private accumulateUsage(usage: Record<string, unknown> | undefined): SessionUsage | undefined {
    if (usage === undefined) return undefined
    const totals = this.usageTotals
    totals.input += readNumber(usage, 'input') ?? 0
    totals.output += readNumber(usage, 'output') ?? 0
    totals.cacheRead += readNumber(usage, 'cacheRead') ?? 0
    totals.cacheWrite += readNumber(usage, 'cacheWrite') ?? 0
    totals.totalTokens += readNumber(usage, 'totalTokens') ?? 0
    const reasoning = readNumber(usage, 'reasoningTokens')
    if (reasoning !== undefined) totals.reasoning += reasoning
    const cost = readRecord(usage, 'cost')
    const costUsd = cost === undefined ? undefined : readNumber(cost, 'total')
    if (costUsd !== undefined) totals.costUsd += costUsd
    this.runState.cacheWriteTokens = totals.cacheWrite
    if (totals.cacheWrite > 0) {
      this.addNote('omp reports cache-write tokens, which the canonical usage shape cannot carry')
    }
    const projected: SessionUsage = {
      inputTokens: totals.input,
      outputTokens: totals.output,
      cachedInputTokens: totals.cacheRead,
      totalTokens: totals.totalTokens,
    }
    if (totals.reasoning > 0) projected.reasoningTokens = totals.reasoning
    if (totals.costUsd > 0) projected.costUsd = totals.costUsd
    this.runState.usage = projected
    return projected
  }

  private warning(message: string, at: string): AgentRunEvent {
    return { kind: 'warning', runId: this.runId, at, message }
  }

  private unknown(nativeType: string | undefined, raw: string, at: string): AgentRunEvent {
    return {
      kind: 'unknown',
      runId: this.runId,
      at,
      ...(nativeType === undefined ? {} : { nativeType }),
      native: raw.length > MAX_NATIVE_CHARS ? raw.slice(0, MAX_NATIVE_CHARS) : raw,
    }
  }
}

/** The concatenated text blocks of an assistant message record. */
function assistantText(message: Record<string, unknown>): string | undefined {
  const content = message.content
  if (typeof content === 'string') return content
  const blocks = readArray(message, 'content')
  if (blocks === undefined) return undefined
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (readString(block, 'type') !== 'text') continue
    const text = readString(block, 'text')
    if (text !== undefined) parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/** Serialize a native value for a canonical string field, bounded. */
function boundedJson(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = '<unserializable>'
  }
  return text.length > MAX_NATIVE_CHARS ? text.slice(0, MAX_NATIVE_CHARS) : text
}
