/**
 * Pi's `--mode json` event stream mapped onto the canonical run-event union
 * (ADR-0003). One record per line: the first is the session header, and every later
 * record is an `AgentSessionEvent` with delta-only content.
 *
 * Mapping rules, all verified against pi 1.2.0:
 *
 * | Pi record | Canonical event |
 * |---|---|
 * | session header `{type:'session',id,cwd}` | `session.bound` |
 * | `message_update` + `assistantMessageEvent.text_delta` | `message.delta` |
 * | `message_update` + `assistantMessageEvent.thinking_delta` | `reasoning.delta` |
 * | `message_update` + `assistantMessageEvent.toolcall_start` | `tool.started` |
 * | `message_update` + `assistantMessageEvent.error` | `warning` |
 * | `message_end` (assistant) | `message.completed`, `usage.updated` |
 * | `tool_execution_start` | `tool.started`, deduplicated by call id |
 * | `tool_execution_end` | `tool.completed` |
 * | `entry_appended` (`usage` entry) | `usage.updated` |
 * | `compaction_start` / `compaction_end` (failure) | `warning` |
 * | `auto_retry_start` / `auto_retry_end` (failure) | `warning` |
 * | `bash_execution_update` | `output` (stdout) |
 * | `session_info_changed`, `thinking_level_changed`, retry-scheduling records | `unknown` |
 * | anything unrecognized | `unknown` |
 *
 * Deliberate no-ops, kept out of the stream so the run record is not noise: lifecycle
 * records with no content (`agent_start`, `turn_start`, `queue_update`,
 * `agent_settled`), records whose content arrives again on a boundary the adapter
 * already maps (`message_start`, the `*_start`/`*_end` delta brackets, `turn_end`,
 * `toolcall_delta`, `toolcall_end`, `tool_execution_update`), the echo of the prompt
 * itself (`message_end` with role `user`), and the duplicate result of a tool call
 * (`message_end` with role `toolResult`, already carried by `tool_execution_end`).
 *
 * @module @zorker/muti-agent-adapter-pi/events
 */

import { nativeSessionId, type AgentRunEvent, type RunId, type SessionUsage } from '@zorker/muti-agent-contracts'
import {
  isRecord,
  readArray,
  readNumber,
  readPiSessionHeader,
  readRecord,
  readString,
  type PiSessionHeader,
} from './sessions.ts'

/** Characters of a native record retained inside an `unknown` event. */
const MAX_NATIVE_CHARS = 4_000

/** Run state the projection accumulates for the terminal result. */
export interface PiRunState {
  /** Native session id from the header, once it has been seen. */
  sessionId?: string
  /** Header of the session this run wrote into. */
  header?: PiSessionHeader
  /** Assistant text of the last completed message. */
  finalText?: string
  /** Usage summed over completed assistant messages and `usage` entries. */
  usage?: SessionUsage
  /** `stopReason` of the last completed assistant message. */
  lastStopReason?: string
  /** Provider message of the last failed assistant message, verbatim. */
  lastErrorMessage?: string
  /** Whether pi reported its settled (idle) state. */
  settled: boolean
  /** Whether pi reported the last turn as aborted. */
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
 * Maps Pi's JSON event stream onto canonical events, accumulating the run state a
 * terminal result needs.
 *
 * The projection is single-run state: one instance per `AdapterRun`.
 */
export class PiRunProjection {
  private readonly runState: PiRunState = {
    settled: false,
    aborted: false,
    toolCalls: 0,
    toolFailures: 0,
    cacheWriteTokens: 0,
    notes: [],
  }

  private readonly announcedToolCalls = new Set<string>()

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
  state(): Readonly<PiRunState> {
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
    const header = readPiSessionHeader(value)
    if (header !== undefined) {
      this.runState.header = header
      this.runState.sessionId = header.id
      return [{ kind: 'session.bound', runId: this.runId, at, nativeSessionId: nativeSessionId(header.id) }]
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
        // A call the model already announced on the wire is not announced twice: the
        // canonical union has one `tool.started` per call, and the transcript keeps the
        // arguments this record carries.
        if (callId !== undefined && this.announcedToolCalls.has(callId)) return []
        if (callId !== undefined) this.announcedToolCalls.add(callId)
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
      case 'entry_appended':
        return this.mapEntryAppended(value, at)
      case 'compaction_start':
        return [this.warning(`pi started compacting the conversation (${readString(value, 'reason') ?? 'unknown'} reason)`, at)]
      case 'compaction_end': {
        const errorMessage = readString(value, 'errorMessage')
        if (errorMessage === undefined) return []
        this.addNote(`pi's compaction failed: ${errorMessage}`)
        return [this.warning(`pi's compaction failed: ${errorMessage}`, at)]
      }
      case 'auto_retry_start': {
        const attempt = readNumber(value, 'attempt')
        const max = readNumber(value, 'maxAttempts')
        const message = readString(value, 'errorMessage') ?? 'provider error'
        return [this.warning(`pi is retrying after ${message} (attempt ${attempt ?? '?'}/${max ?? '?'})`, at)]
      }
      case 'auto_retry_end': {
        if (value.success === true) return []
        const finalError = readString(value, 'finalError') ?? 'the retry budget was exhausted'
        this.addNote(`pi's automatic retry failed: ${finalError}`)
        return [this.warning(`pi's automatic retry failed: ${finalError}`, at)]
      }
      case 'bash_execution_update': {
        const delta = readString(value, 'delta')
        return delta === undefined ? [] : [{ kind: 'output', runId: this.runId, at, stream: 'stdout', text: delta }]
      }
      case 'agent_settled': {
        this.runState.settled = true
        const aborted = value.aborted === true
        this.runState.aborted = aborted
        if (!aborted) return []
        this.addNote('pi reported the turn as aborted')
        return [this.warning('pi reported the turn as aborted', at)]
      }
      // Lifecycle records with no content and no consumer-visible state.
      case 'agent_start':
      case 'agent_end':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'queue_update':
      case 'tool_execution_update':
        return []
      // Records this adapter models as state but the canonical union cannot carry.
      case 'session_info_changed':
      case 'thinking_level_changed':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        return [this.unknown(type, raw, at)]
      default:
        this.addNote(`an unrecognized pi event type (${type}) was preserved as an unknown event`)
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
      case 'toolcall_start': {
        const callId = readString(deltaEvent, 'id')
        if (callId !== undefined) this.announcedToolCalls.add(callId)
        return [
          {
            kind: 'tool.started',
            runId: this.runId,
            at,
            ...(callId === undefined ? {} : { callId }),
            toolName: readString(deltaEvent, 'toolName') ?? 'tool',
          },
        ]
      }
      case 'error': {
        const error = readRecord(deltaEvent, 'error')
        const message = error === undefined ? undefined : readString(error, 'errorMessage')
        this.runState.lastStopReason = readString(deltaEvent, 'reason') ?? 'error'
        if (message !== undefined) this.runState.lastErrorMessage = message
        return [this.warning(message ?? 'the assistant response failed', at)]
      }
      case 'done':
        // `message_end` carries the authoritative message and its usage.
        return []
      case 'start':
      case 'text_start':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_end':
      case 'toolcall_delta':
      case 'toolcall_end':
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
        if (stopReason !== undefined) this.runState.lastStopReason = stopReason
        const errorMessage = readString(message, 'errorMessage')
        if (errorMessage !== undefined && errorMessage !== '') {
          this.runState.lastErrorMessage = errorMessage
          events.push(this.warning(`pi reported: ${errorMessage}`, at))
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
      default:
        return [this.unknown('message_end', raw, at)]
    }
  }

  /** Map `entry_appended`, which is the only carrier of standalone `usage` records. */
  private mapEntryAppended(value: Record<string, unknown>, at: string): readonly AgentRunEvent[] {
    const entry = readRecord(value, 'entry')
    if (entry === undefined || readString(entry, 'type') !== 'usage') return []
    const usage = this.accumulateUsage(readRecord(entry, 'usage'))
    if (usage === undefined) return []
    this.addNote('a standalone pi `usage` entry (cache-warming accounting) is included in the run totals')
    return [{ kind: 'usage.updated', runId: this.runId, at, usage }]
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
    const reasoning = readNumber(usage, 'reasoning')
    if (reasoning !== undefined) totals.reasoning += reasoning
    const cost = readRecord(usage, 'cost')
    const costUsd = cost === undefined ? undefined : readNumber(cost, 'total')
    if (costUsd !== undefined) totals.costUsd += costUsd
    this.runState.cacheWriteTokens = totals.cacheWrite
    if (totals.cacheWrite > 0) {
      this.addNote('pi reports cache-write tokens, which the canonical usage shape cannot carry')
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
