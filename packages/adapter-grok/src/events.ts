/**
 * Projection of `grok -p --output-format streaming-json` NDJSON onto the canonical
 * run-event union (ADR-0002, ADR-0003).
 *
 * Line shapes are those of xAI's streaming-json reducer
 * (`xai-grok-pager/src/headless/reducer/acp.rs`): a `type`-tagged envelope whose leaf
 * names follow ACP (`toolCallId`, `kind`, `rawInput`, `rawOutput`) plus xAI's own
 * `toolName`. `text` and `thought` chunks carry their payload in `data`, and `end`
 * always carries `sessionId`. `end` is always last.
 *
 * A `type` the union cannot model becomes `unknown` rather than being dropped, so a
 * protocol revision degrades into a visible gap (ADR-0003).
 *
 * @module @zorker/muti-agent-adapter-grok/events
 */

import { ErrorCodes } from '@zorker/muti-agent-contracts'
import type { AgentRunEvent, RunId, SessionUsage, TodoStatus } from '@zorker/muti-agent-contracts'

/** Bytes of a native tool payload kept on one event; the rest is dropped, not paged. */
const TOOL_PAYLOAD_BYTES = 8 * 1024

/** Mutable per-run mapping state threaded across successive stream lines. */
export interface GrokStreamState {
  /** Assistant text accumulated from `text` lines; the run's final message. */
  text: string
  /** Native session id, once a line carried one. */
  sessionId: string | undefined
  /** Turn stop reason from the `end` line (`end_turn`, `max_tokens`, `refusal`, …). */
  stopReason: string | undefined
  /** Usage projected from `usage`/`end` lines; the latest one wins. */
  usage: SessionUsage | undefined
  /** Cache-creation input tokens reported alongside usage; no canonical field carries them. */
  cacheCreationTokens: number | undefined
  /** Tool name by call id, because `tool_call_update` omits the name. */
  toolNames: Map<string, string>
  /** `message` of the first `error` line, for failure classification. */
  errorMessage: string | undefined
  /** Whether the terminal `end` line was seen. */
  ended: boolean
  /** Declared projection gaps observed while mapping. */
  notes: string[]
}

/**
 * @returns Fresh mapping state for one run.
 */
export function createStreamState(): GrokStreamState {
  return {
    text: '',
    sessionId: undefined,
    stopReason: undefined,
    usage: undefined,
    cacheCreationTokens: undefined,
    toolNames: new Map<string, string>(),
    errorMessage: undefined,
    ended: false,
    notes: [],
  }
}

/** A classified run failure: a canonical code, evidence, and the next human action. */
export interface GrokRunFailure {
  /** Canonical error code. */
  code: string
  /** What went wrong, in the run's own terms. */
  message: string
  /** What the human should do next. */
  remediation: string
  /** Whether a plain retry could succeed. */
  retryable: boolean
}

/** Grok's own refusal message when a resume changes the session's sandbox profile. */
const SANDBOX_CONFLICT = /cannot resume this session under sandbox profile/i
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b|quota (?:exceeded|exhausted)|usage limit/i
const UNAUTHENTICATED = /not authenticated|not signed in|unauthorized|\b401\b|invalid api key|login required/i
const POLICY_BLOCKED = /policy|not allowed|disallowed|refus(?:ed|al)|forbidden|\b403\b|moderation|blocked/i

/**
 * Classify a finished process into the canonical failure vocabulary.
 *
 * @param input - Observed outcome and the evidence needed to pick a code.
 * @returns The classified failure, or `undefined` when the run succeeded.
 */
export function classifyGrokFailure(input: {
  exitCode: number | undefined
  signal: string | undefined
  timedOut: boolean
  cancelled: boolean
  stderrTail: string
  errorMessage: string | undefined
}): GrokRunFailure | undefined {
  if (input.cancelled) {
    return {
      code: ErrorCodes.runCancelled,
      message: 'the run was cancelled',
      remediation: 'Re-dispatch the run when you want it to continue.',
      retryable: true,
    }
  }
  if (input.timedOut) {
    return {
      code: ErrorCodes.runTimeout,
      message: 'the run exceeded its wall-clock budget',
      remediation: 'Raise the adapter timeout or split the task into smaller runs.',
      retryable: true,
    }
  }
  if (input.exitCode === 0) return undefined

  const evidence = `${input.errorMessage ?? ''}\n${input.stderrTail}`
  const failed = `grok exited with ${
    input.exitCode === undefined ? `signal ${input.signal ?? 'unknown'}` : `code ${String(input.exitCode)}`
  }`

  if (SANDBOX_CONFLICT.test(evidence)) {
    return {
      code: ErrorCodes.runPolicyBlocked,
      message: failed,
      remediation:
        'grok refuses to resume a session under a different sandbox profile than it was created with. Omit the sandbox override for this session, or start a new session with the requested profile.',
      retryable: false,
    }
  }
  if (RATE_LIMITED.test(evidence)) {
    return {
      code: ErrorCodes.runRateLimited,
      message: failed,
      remediation: 'Wait for the quota window to reset, or switch the model or account.',
      retryable: true,
    }
  }
  if (UNAUTHENTICATED.test(evidence)) {
    return {
      code: ErrorCodes.authNotConfigured,
      message: failed,
      remediation: 'Log in through the Grok Build credential panel (`grok login`) and retry.',
      retryable: false,
    }
  }
  if (POLICY_BLOCKED.test(evidence)) {
    return {
      code: ErrorCodes.runPolicyBlocked,
      message: failed,
      remediation: 'Review the request against the account policy or the session sandbox profile.',
      retryable: false,
    }
  }
  return {
    code: ErrorCodes.runAgentCrashed,
    message: failed,
    remediation: 'Inspect the captured stderr tail and the session record for the cause.',
    retryable: false,
  }
}

/**
 * Project a `usage` line or an `end` line's merged usage fields.
 *
 * Wire keys are snake_case (`input_tokens`, `cache_read_input_tokens`, …); `input_tokens`
 * already excludes both cache buckets on the `end` line. `cache_creation_input_tokens`
 * has no canonical field and is deliberately dropped.
 *
 * @param value - The raw `usage` object.
 * @returns The canonical usage, or `undefined` when nothing recognizable is present.
 */
export function usageFromWire(value: unknown): SessionUsage | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const input = num(record.input_tokens)
  const output = num(record.output_tokens)
  const cached = num(record.cache_read_input_tokens)
  const reasoning = num(record.reasoning_tokens)
  const total = num(record.total_tokens)
  const cost = num(record.total_cost_usd)
  const usage: SessionUsage = {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

/**
 * Map one parsed streaming-json line onto canonical events.
 *
 * @param line - Parsed JSON value of one NDJSON line.
 * @param context - Run id and the timestamp to stamp on every event from this line.
 * @param state - Per-run mapping state, mutated with what the line revealed.
 * @returns The events this line produced, in order.
 */
export function mapStreamingJsonLine(
  line: unknown,
  context: { runId: RunId; at: string },
  state: GrokStreamState,
): readonly AgentRunEvent[] {
  const record = asRecord(line)
  const type = record === undefined ? undefined : str(record.type)
  if (record === undefined || type === undefined) {
    state.notes.push('a streaming-json line carried no type and was preserved as unknown')
    return [unknownEvent(context, undefined, line)]
  }

  switch (type) {
    case 'text': {
      const data = str(record.data) ?? ''
      if (data === '') return []
      state.text += data
      return [{ kind: 'message.delta', runId: context.runId, at: context.at, text: data }]
    }
    case 'thought': {
      const data = str(record.data) ?? ''
      if (data === '') return []
      return [{ kind: 'reasoning.delta', runId: context.runId, at: context.at, text: data }]
    }
    case 'tool_call': {
      const callId = str(record.toolCallId)
      const toolName = str(record.toolName) ?? str(record.title) ?? 'tool'
      if (callId !== undefined) state.toolNames.set(callId, toolName)
      const input = stringifyBounded(record.rawInput, TOOL_PAYLOAD_BYTES)
      const events: AgentRunEvent[] = [
        {
          kind: 'tool.started',
          runId: context.runId,
          at: context.at,
          toolName,
          ...(callId === undefined ? {} : { callId }),
          ...(input === undefined ? {} : { input }),
        },
      ]
      const paths = locationPaths(record.locations)
      if (paths.length > 0) {
        events.push({ kind: 'files.changed', runId: context.runId, at: context.at, paths })
      }
      return events
    }
    case 'tool_call_update': {
      const callId = str(record.toolCallId)
      const status = str(record.status)
      // Only a terminal status closes the call; `pending`/`in_progress` are progress pings.
      if (status !== 'completed' && status !== 'failed') return []
      const toolName = (callId === undefined ? undefined : state.toolNames.get(callId)) ?? 'tool'
      const output =
        stringifyBounded(toolContentText(record.content), TOOL_PAYLOAD_BYTES) ??
        stringifyBounded(record.rawOutput, TOOL_PAYLOAD_BYTES)
      const events: AgentRunEvent[] = [
        {
          kind: 'tool.completed',
          runId: context.runId,
          at: context.at,
          toolName,
          failed: status === 'failed',
          ...(callId === undefined ? {} : { callId }),
          ...(output === undefined ? {} : { output }),
        },
      ]
      const paths = locationPaths(record.locations)
      if (paths.length > 0) {
        events.push({ kind: 'files.changed', runId: context.runId, at: context.at, paths })
      }
      return events
    }
    case 'plan': {
      const entries = planEntries(record.entries)
      const events: AgentRunEvent[] = [
        {
          kind: 'todos.updated',
          runId: context.runId,
          at: context.at,
          todos: entries.map(entry => ({ content: entry.content, status: entry.status })),
        },
      ]
      events.push({
        kind: 'plan.updated',
        runId: context.runId,
        at: context.at,
        active: entries.length > 0,
        phases: entries.map(entry => entry.content),
      })
      return events
    }
    case 'usage': {
      const usage = usageFromWire(record.usage)
      trackCacheCreation(state, record.usage)
      if (usage === undefined) {
        return [unknownEvent(context, type, record)]
      }
      state.usage = usage
      return [{ kind: 'usage.updated', runId: context.runId, at: context.at, usage }]
    }
    case 'end': {
      state.ended = true
      const sessionId = str(record.sessionId)
      if (sessionId !== undefined) state.sessionId = sessionId
      const stopReason = str(record.stopReason)
      if (stopReason !== undefined) state.stopReason = stopReason
      const merged = usageFromWire(record.usage)
      if (merged !== undefined) state.usage = merged
      trackCacheCreation(state, record.usage)
      const turns = num(record.num_turns)
      if (turns !== undefined) {
        state.notes.push(`grok reported ${String(turns)} model turns for this dispatch; the canonical result has no turn count`)
      }
      return []
    }
    case 'error': {
      const message = str(record.message) ?? 'grok reported an error'
      state.errorMessage = message
      return [{ kind: 'warning', runId: context.runId, at: context.at, message }]
    }
    case 'max_turns_reached': {
      state.stopReason = 'max_turns_reached'
      return [
        {
          kind: 'warning',
          runId: context.runId,
          at: context.at,
          message: 'grok reached its turn limit and stopped before finishing the task',
        },
      ]
    }
    default:
      return [unknownEvent(context, type, record)]
  }
}

/**
 * Extract the ACP plan entries carried by a `plan` line.
 *
 * @param value - The raw `entries` array.
 * @returns Normalized entries; unknown fields are dropped.
 */
export function planEntries(value: unknown): readonly { content: string; status: string }[] {
  const items = Array.isArray(value) ? value : []
  const out: { content: string; status: string }[] = []
  for (const item of items) {
    const record = asRecord(item)
    if (record === undefined) continue
    const content = str(record.content)
    if (content === undefined) continue
    out.push({ content, status: todoStatus(record.status) })
  }
  return out
}

/**
 * Text of an ACP tool content array.
 *
 * ACP wraps text as `{type:'content', content:{type:'text', text}}`; a `diff` entry
 * carries the touched path instead of text.
 *
 * @param content - The raw `content` value.
 * @returns Joined text, or `undefined` when no entry carried any.
 */
export function toolContentText(content: unknown): string | undefined {
  const items = Array.isArray(content) ? content : []
  const parts: string[] = []
  for (const item of items) {
    const record = asRecord(item)
    if (record === undefined) continue
    const inner = asRecord(record.content) ?? record
    const text = str(inner.text)
    if (text !== undefined) parts.push(text)
    const path = str(record.path)
    if (record.type === 'diff' && path !== undefined) parts.push(`[diff] ${path}`)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Paths an ACP `locations` array names.
 *
 * @param locations - The raw `locations` value.
 * @returns Distinct paths, in first-seen order.
 */
export function locationPaths(locations: unknown): readonly string[] {
  const items = Array.isArray(locations) ? locations : []
  const paths: string[] = []
  for (const item of items) {
    const record = asRecord(item)
    const path = record === undefined ? undefined : str(record.path)
    if (path !== undefined && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/**
 * Canonical todo status for a native token.
 *
 * @param value - The native status token.
 * @returns The canonical status; an unknown token is reported as `pending`.
 */
export function todoStatus(value: unknown): TodoStatus {
  switch (value) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'pending'
  }
}

/** Record a usage object's cache-creation count, which the canonical schema cannot carry. */
function trackCacheCreation(state: GrokStreamState, value: unknown): void {
  const record = asRecord(value)
  const creation = record === undefined ? undefined : num(record.cache_creation_input_tokens)
  if (creation !== undefined && creation > 0) state.cacheCreationTokens = creation
}

/** Preserve a native line the union does not model. */
function unknownEvent(
  context: { runId: RunId; at: string },
  nativeType: string | undefined,
  native: unknown,
): AgentRunEvent {
  return {
    kind: 'unknown',
    runId: context.runId,
    at: context.at,
    ...(nativeType === undefined ? {} : { nativeType }),
    native: stringifyBounded(native, TOOL_PAYLOAD_BYTES) ?? '',
  }
}

/**
 * Narrow a JSON value to a plain object.
 *
 * @param value - Any parsed JSON value.
 * @returns The object's own entries, or `undefined` for a non-object.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

/** Narrow a JSON value to a non-empty string. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Narrow a JSON value to a finite number. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Serialize a native payload, capped so one event cannot carry an unbounded blob. */
function stringifyBounded(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'string' ? value : safeJson(value)
  if (text === undefined || text === '') return undefined
  return text.length > max ? text.slice(0, max) : text
}

/** JSON text, or `undefined` when the value cannot be serialized. */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
