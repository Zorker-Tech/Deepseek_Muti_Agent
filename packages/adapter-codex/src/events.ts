/**
 * `codex exec --json` projection: one native `ThreadEvent` JSONL line becomes zero
 * or more canonical {@link AgentRunEvent} objects, and one process exit becomes one
 * classified outcome (ADR-0003, ADR-0014).
 *
 * Every native event this module recognizes is mapped; a native type it does not
 * model is *preserved* as `kind: 'unknown'` with its raw JSON rather than dropped,
 * so a Codex protocol revision degrades into a visible gap. The two exports here are
 * deliberately transport-free: they take parsed JSON lines and a {@link ProcessOutcome},
 * never a stream, which is what makes them testable against recorded fixtures.
 *
 * @module @zorker/muti-agent-adapter-codex/events
 */

import {
  ErrorCodes,
  MutiAgentError,
  nativeSessionId as toNativeSessionId,
  type AgentRunEvent,
  type RunId,
  type RunResult,
  type SessionUsage,
} from '@zorker/muti-agent-contracts'
import type { ProcessOutcome } from '@zorker/muti-agent-core'

/** Cap on any single text field copied out of a native event into a canonical event. */
export const MAX_EVENT_TEXT_BYTES = 8 * 1024

/** Non-terminal events {@link RunEventQueue} holds for a consumer before it starts dropping. */
export const DEFAULT_MAX_PENDING_EVENTS = 4_096

/** How a finished `codex exec` process is classified. */
export type CodexRunFailure = 'cancelled' | 'timeout' | 'rate-limited' | 'policy-blocked' | 'crashed'

/** Classification of one finished process, with the canonical error it maps to. */
export type CodexOutcomeClassification =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** Failure class, derived from the runner's flags and Codex's own stderr. */
      readonly failure: CodexRunFailure
      /** Canonical error code for the run record. */
      readonly code: string
      /** Message naming what happened. */
      readonly message: string
      /** Actionable next step for the human. */
      readonly remediation: string
      /** Whether a plain retry could succeed. */
      readonly retryable: boolean
    }

/** Patterns that identify a rate-limit refusal in Codex's stderr or failure events. */
const RATE_LIMIT_PATTERN = /rate\s*limit|too many requests|429|usage limit|quota/i
/** Patterns that identify a policy refusal in Codex's stderr or failure events. */
const POLICY_PATTERN = /policy|refus|blocked|not permitted|not allowed|safety|disallowed/i

/**
 * Truncate a native string to the event cap.
 *
 * @param text - Native text.
 * @returns The text, cut at {@link MAX_EVENT_TEXT_BYTES} with a marker when it was longer.
 */
export function capText(text: string): string {
  if (text.length <= MAX_EVENT_TEXT_BYTES) return text
  return `${text.slice(0, MAX_EVENT_TEXT_BYTES)}\n[truncated by muti-agent at ${MAX_EVENT_TEXT_BYTES} characters]`
}

/**
 * Normalize a native type token for comparison.
 *
 * Codex serializes the same conceptual item as `AgentMessage` in one payload family
 * and `agent_message` in another, and enum variants have been renamed across
 * versions; comparing on a separator-free lowercase form tolerates both without
 * enumerating casings.
 *
 * @param value - Native type token, or `undefined`.
 * @returns The comparable form, or an empty string.
 */
export function normalizeType(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

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

/** A finite number field of a record. */
function num(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A record field of a record. */
function obj(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return asRecord(record?.[key])
}

/** Serialize a native value for a canonical text field, tolerating cycles and non-JSON values. */
function json(value: unknown): string {
  try {
    return capText(JSON.stringify(value) ?? String(value))
  } catch {
    return String(value)
  }
}

/**
 * Project a native `Usage` payload (`turn.completed`) onto canonical usage.
 *
 * @param value - The native usage object.
 * @returns Canonical usage, or `undefined` when the payload carries no numbers.
 */
export function usageFromNative(value: unknown): SessionUsage | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const inputTokens = num(record, 'input_tokens')
  const cachedInputTokens = num(record, 'cached_input_tokens')
  const outputTokens = num(record, 'output_tokens')
  const reasoningTokens = num(record, 'reasoning_output_tokens')
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined
  }
  const usage: SessionUsage = {}
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  if (inputTokens !== undefined || outputTokens !== undefined) {
    usage.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0)
  }
  return usage
}

/**
 * Classify a finished `codex exec` process.
 *
 * The runner's own flags decide cancellation and timeout; everything else is read off
 * Codex's stderr, because Codex exits non-zero for "not logged in", "rate limited",
 * "policy refused" and "crashed" alike (ADR-0014 rule 6).
 *
 * @param outcome - The process outcome from the runner.
 * @param stderrText - Bounded stderr, head and tail joined.
 * @returns `{ ok: true }` for a successful exit, else the failure class and its
 *   canonical error code.
 */
export function classifyExecOutcome(outcome: ProcessOutcome, stderrText: string): CodexOutcomeClassification {
  if (outcome.cancelled) {
    return {
      ok: false,
      failure: 'cancelled',
      code: ErrorCodes.runCancelled,
      message: 'the run was cancelled',
      remediation: 'Nothing to do; the run stopped on request.',
      retryable: true,
    }
  }
  if (outcome.timedOut) {
    return {
      ok: false,
      failure: 'timeout',
      code: ErrorCodes.runTimeout,
      message: `the run exceeded its ${String(outcome.durationMs)} ms budget`,
      remediation: 'Raise the agent timeout in settings, or split the task into smaller runs.',
      retryable: true,
    }
  }
  if (outcome.code === 0) return { ok: true }
  const evidence = stderrText.trim()
  if (RATE_LIMIT_PATTERN.test(evidence)) {
    return {
      ok: false,
      failure: 'rate-limited',
      code: ErrorCodes.runRateLimited,
      message: 'codex reported a rate limit or usage cap',
      remediation: 'Wait for the limit to reset, then dispatch the run again.',
      retryable: true,
    }
  }
  if (POLICY_PATTERN.test(evidence)) {
    return {
      ok: false,
      failure: 'policy-blocked',
      code: ErrorCodes.runPolicyBlocked,
      message: 'codex refused the request on policy grounds',
      remediation: 'Reword the task, or run it in a session whose sandbox and approvals allow it.',
      retryable: false,
    }
  }
  return {
    ok: false,
    failure: 'crashed',
    code: ErrorCodes.runAgentCrashed,
    message:
      outcome.code === undefined
        ? `codex was terminated by signal ${String(outcome.signal)}`
        : `codex exited with code ${String(outcome.code)}`,
    remediation: 'Read the captured output, then run `codex exec` once by hand to reproduce it.',
    retryable: false,
  }
}

/** Options for {@link CodexExecEventMapper}. */
export interface CodexEventMapperOptions {
  /** Run id echoed on every emitted event. */
  readonly runId: RunId
  /** Clock, injectable so fixtures produce stable timestamps. */
  readonly now?: () => string
}

/**
 * Stateful projection of one `codex exec --json` stream.
 *
 * State is what the terminal result needs: the thread id Codex announced, the last
 * completed assistant message, the last reported usage, and the error evidence. The
 * mapper is single-run: one instance per process.
 */
export class CodexExecEventMapper {
  private readonly runId: RunId
  private readonly now: () => string
  private thread: string | undefined
  private completedText: string | undefined
  private usage: SessionUsage | undefined
  private readonly failures: string[] = []
  private readonly unmodelledTypes = new Set<string>()
  private readonly reasoningByItem = new Map<string, string>()
  private readonly messageByItem = new Map<string, string>()
  private readonly openedTools = new Set<string>()
  private todoSignature: string | undefined

  /**
   * @param options - Run identity and an optional clock.
   */
  constructor(options: CodexEventMapperOptions) {
    this.runId = options.runId
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** Native thread id Codex announced, once it has. */
  get nativeSessionId(): string | undefined {
    return this.thread
  }

  /** Last completed assistant message text. */
  get finalText(): string | undefined {
    return this.completedText
  }

  /** Usage from the most recent `turn.completed`. */
  get reportedUsage(): SessionUsage | undefined {
    return this.usage
  }

  /** Error evidence from `turn.failed`, `error` and error items, oldest first. */
  get errorEvidence(): readonly string[] {
    return this.failures
  }

  /** Native item types this mapper does not model, sorted. */
  get unmodelledItemTypes(): readonly string[] {
    return [...this.unmodelledTypes].sort()
  }

  /**
   * Project one parsed `ThreadEvent` line.
   *
   * @param value - The parsed JSON line.
   * @param raw - The raw line, preserved in `unknown` events.
   * @returns Zero or more canonical events, in order.
   */
  mapLine(value: unknown, raw: string): readonly AgentRunEvent[] {
    const record = asRecord(value)
    const at = this.now()
    if (record === undefined) {
      return [this.unknown(at, undefined, raw)]
    }
    const type = str(record, 'type')
    switch (type) {
      case 'thread.started': {
        const threadId = str(record, 'thread_id')
        if (threadId === undefined) return [this.unknown(at, 'thread.started', raw)]
        this.thread = threadId
        return [{ kind: 'session.bound', runId: this.runId, at, nativeSessionId: toNativeSessionId(threadId) }]
      }
      case 'turn.started':
        return []
      case 'turn.completed': {
        const usage = usageFromNative(record.usage)
        if (usage === undefined) {
          this.unmodelledTypes.add('turn.completed(no usage)')
          return [this.unknown(at, 'turn.completed', raw)]
        }
        this.usage = usage
        return [{ kind: 'usage.updated', runId: this.runId, at, usage }]
      }
      case 'turn.failed': {
        const message = str(obj(record, 'error'), 'message') ?? json(record.error)
        this.failures.push(message)
        return [{ kind: 'warning', runId: this.runId, at, message: capText(`codex turn failed: ${message}`) }]
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.mapItem(type === 'item.completed' ? 'completed' : 'open', record, raw, at)
      case 'error': {
        const message = str(record, 'message') ?? raw
        this.failures.push(message)
        return [{ kind: 'warning', runId: this.runId, at, message: capText(`codex error: ${message}`) }]
      }
      default: {
        this.unmodelledTypes.add(type ?? '(untyped)')
        return [this.unknown(at, type, raw)]
      }
    }
  }

  /** Project one `item.*` event through the native item table. */
  private mapItem(
    phase: 'open' | 'completed',
    record: Record<string, unknown>,
    raw: string,
    at: string,
  ): readonly AgentRunEvent[] {
    const item = asRecord(record.item)
    if (item === undefined) {
      this.unmodelledTypes.add('item(no payload)')
      return [this.unknown(at, 'item', raw)]
    }
    const nativeType = str(item, 'type')
    const callId = str(item, 'id')
    const callIdFields = callId === undefined ? {} : { callId }
    switch (normalizeType(nativeType)) {
      case 'agentmessage': {
        const text = str(item, 'text')
        if (text === undefined || text === '') return []
        if (phase === 'open') {
          const delta = this.takeDelta(this.messageByItem, callId, text)
          return delta === undefined ? [] : [{ kind: 'message.delta', runId: this.runId, at, text: delta }]
        }
        this.completedText = text
        return [{ kind: 'message.completed', runId: this.runId, at, text }]
      }
      case 'reasoning': {
        const text = str(item, 'text') ?? ''
        if (text === '') return []
        if (phase === 'completed') return []
        const delta = this.takeDelta(this.reasoningByItem, callId, text)
        return delta === undefined ? [] : [{ kind: 'reasoning.delta', runId: this.runId, at, text: delta }]
      }
      case 'commandexecution': {
        const command = str(item, 'command') ?? ''
        if (phase === 'open') return [this.toolStarted(at, callId, 'shell', capText(command))]
        const status = normalizeType(str(item, 'status'))
        const output = str(item, 'aggregated_output')
        return [
          // A completed item whose start was never observed still yields a well-formed
          // pair, because a consumer that only sees `tool.completed` has nothing to key on.
          ...this.ensureToolStarted(at, callId, 'shell', command === '' ? undefined : capText(command)),
          {
            kind: 'tool.completed',
            runId: this.runId,
            at,
            ...callIdFields,
            toolName: 'shell',
            failed: status === 'failed' || status === 'declined',
            ...(output === undefined || output === '' ? {} : { output: capText(output) }),
          },
        ]
      }
      case 'filechange': {
        const changes = Array.isArray(item.changes) ? item.changes : []
        const paths: string[] = []
        for (const change of changes) {
          const path = str(asRecord(change), 'path')
          if (path !== undefined) paths.push(path)
        }
        if (paths.length === 0) return []
        const failed = normalizeType(str(item, 'status')) === 'failed'
        const events: AgentRunEvent[] = [{ kind: 'files.changed', runId: this.runId, at, paths }]
        if (failed) {
          events.push({ kind: 'warning', runId: this.runId, at, message: `codex could not apply a patch to ${paths.join(', ')}` })
        }
        return events
      }
      case 'mcptoolcall':
      case 'collabtoolcall':
      case 'websearch': {
        const name = this.toolName(nativeType, item)
        if (phase === 'open') return [this.toolStarted(at, callId, name, this.toolInput(item))]
        const output = this.toolOutput(item)
        const status = normalizeType(str(item, 'status'))
        return [
          ...this.ensureToolStarted(at, callId, name, this.toolInput(item)),
          {
            kind: 'tool.completed',
            runId: this.runId,
            at,
            ...callIdFields,
            toolName: name,
            failed: status === 'failed' || status === 'errored' || str(item, 'error') !== undefined,
            ...(output === undefined ? {} : { output }),
          },
        ]
      }
      case 'todolist': {
        if (phase === 'open') return []
        const items = Array.isArray(item.items) ? item.items : []
        const todos: { content: string; status: string }[] = []
        for (const entry of items) {
          const todo = asRecord(entry)
          const content = str(todo, 'text')
          if (content === undefined) continue
          const completed = todo?.completed === true
          todos.push({ content, status: completed ? 'completed' : 'pending' })
        }
        const signature = JSON.stringify(todos)
        if (signature === this.todoSignature) return []
        this.todoSignature = signature
        return [{ kind: 'todos.updated', runId: this.runId, at, todos }]
      }
      case 'error': {
        const message = str(item, 'message') ?? json(item)
        this.failures.push(message)
        return [{ kind: 'warning', runId: this.runId, at, message: capText(`codex error: ${message}`) }]
      }
      default: {
        this.unmodelledTypes.add(nativeType ?? '(untyped item)')
        return [this.unknown(at, `item.${nativeType ?? 'unknown'}`, raw)]
      }
    }
  }

  /** Build a `tool.started` event and remember that this call is open. */
  private toolStarted(at: string, callId: string | undefined, toolName: string, input: string | undefined): AgentRunEvent {
    if (callId !== undefined) this.openedTools.add(callId)
    return {
      kind: 'tool.started',
      runId: this.runId,
      at,
      ...(callId === undefined ? {} : { callId }),
      toolName,
      ...(input === undefined ? {} : { input }),
    }
  }

  /** A synthetic `tool.started` for a completed item whose start was never seen. */
  private ensureToolStarted(
    at: string,
    callId: string | undefined,
    toolName: string,
    input: string | undefined,
  ): readonly AgentRunEvent[] {
    if (callId !== undefined && this.openedTools.has(callId)) return []
    return [this.toolStarted(at, callId, toolName, input)]
  }

  /** Native tool name for an MCP, collab or web-search item. */
  private toolName(nativeType: string | undefined, item: Record<string, unknown>): string {
    switch (normalizeType(nativeType)) {
      case 'mcptoolcall': {
        const server = str(item, 'server')
        const tool = str(item, 'tool') ?? 'mcp'
        return server === undefined ? tool : `${server}/${tool}`
      }
      case 'collabtoolcall': {
        const tool = str(item, 'tool') ?? 'collab'
        return `collab:${tool}`
      }
      default:
        return 'web_search'
    }
  }

  /** Serialized input for an MCP, collab or web-search item. */
  private toolInput(item: Record<string, unknown>): string | undefined {
    const argumentsValue = item.arguments
    if (argumentsValue !== undefined) return json(argumentsValue)
    const prompt = str(item, 'prompt')
    if (prompt !== undefined) return capText(prompt)
    const query = str(item, 'query')
    if (query !== undefined) return capText(query)
    const action = item.action
    return action === undefined ? undefined : json(action)
  }

  /** Serialized output for an MCP, collab or web-search item. */
  private toolOutput(item: Record<string, unknown>): string | undefined {
    const result = item.result
    if (result !== undefined) return json(result)
    const error = asRecord(item.error)
    const message = str(error, 'message')
    if (message !== undefined) return capText(message)
    const states = item.agents_states
    if (states !== undefined) return json(states)
    const results = item.results
    return results === undefined ? undefined : json(results)
  }

  /**
   * Text to emit as an incremental delta for one native item.
   *
   * Codex repeats the item's accumulated text on every update instead of sending
   * fragments, so the delta is the suffix beyond what this item already emitted.
   *
   * @param seen - Per-item memory of the text already emitted.
   * @param key - Native item id, or `undefined` for an anonymous item.
   * @param text - The native accumulated text.
   * @returns The new suffix, or `undefined` when nothing new is present.
   */
  private takeDelta(seen: Map<string, string>, key: string | undefined, text: string): string | undefined {
    const id = key ?? ''
    const previous = seen.get(id)
    seen.set(id, text)
    if (previous === undefined) return text
    if (!text.startsWith(previous)) return undefined
    const delta = text.slice(previous.length)
    return delta === '' ? undefined : delta
  }

  /** Build an `unknown` event preserving an unmodelled native record. */
  private unknown(at: string, nativeType: string | undefined, raw: string): AgentRunEvent {
    return {
      kind: 'unknown',
      runId: this.runId,
      at,
      ...(nativeType === undefined ? {} : { nativeType }),
      native: capText(raw),
    }
  }
}

/** Options for {@link RunEventQueue}. */
export interface RunEventQueueOptions {
  /** Non-terminal events held for a consumer before the oldest are dropped. */
  readonly maxPending?: number
  /** Called with the running total whenever events are dropped. */
  readonly onDrop?: (dropped: number) => void
}

/**
 * Push/pull queue between a run's producer and its consumer.
 *
 * `AdapterRun.result` must settle for a caller that never iterates `events`, so the
 * producer cannot block on the consumer; {@link RunEventQueue.result} is resolved by the
 * producer pushing the terminal event, never by a second consumer of the iterable.
 * Unbounded buffering would let a chatty run exhaust memory, so past
 * {@link RunEventQueueOptions.maxPending} pending events and with no consumer waiting,
 * the *oldest* non-terminal events are dropped and counted (surfaced as a run note). The
 * terminal `run.finished` event is never dropped. The iterable is single-consumer, as
 * the SPI declares.
 */
export class RunEventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly pending: AgentRunEvent[] = []
  private readonly maxPending: number
  private readonly onDrop: ((dropped: number) => void) | undefined
  private readonly terminal: Promise<RunResult>
  private resolveTerminal: ((result: RunResult) => void) | undefined
  private rejectTerminal: ((cause: unknown) => void) | undefined
  private waiter: (() => void) | undefined
  private closed = false
  private dropped = 0

  /**
   * @param options - Buffer cap and a drop hook.
   */
  constructor(options: RunEventQueueOptions = {}) {
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING_EVENTS)
    this.onDrop = options.onDrop
    this.terminal = new Promise<RunResult>((resolve, reject) => {
      this.resolveTerminal = resolve
      this.rejectTerminal = reject
    })
    // The producer always settles this promise in practice; marking it handled keeps a
    // pathological producer failure from becoming an unhandled rejection.
    void this.terminal.catch(() => undefined)
  }

  /** Events dropped so far because no consumer was reading. */
  get droppedCount(): number {
    return this.dropped
  }

  /**
   * The terminal run result, resolved by the terminal event.
   *
   * Rejects with `run/protocol-error` only when the queue is closed without one, which
   * means the producer itself failed.
   */
  get result(): Promise<RunResult> {
    return this.terminal
  }

  /**
   * Append one event. Ignored once the queue has delivered its terminal event.
   *
   * @param event - The event to enqueue.
   */
  push(event: AgentRunEvent): void {
    if (this.closed) return
    const terminal = event.kind === 'run.finished'
    if (!terminal && this.pending.length >= this.maxPending && this.waiter === undefined) {
      this.pending.shift()
      this.dropped += 1
      this.onDrop?.(this.dropped)
    }
    this.pending.push(event)
    if (terminal) {
      this.closed = true
      this.resolveTerminal?.(event.result)
      this.resolveTerminal = undefined
      this.rejectTerminal = undefined
    }
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /**
   * Mark the queue complete, so a waiting consumer stops after the buffered events.
   *
   * @param cause - Why the producer stopped, when it stopped without a terminal event.
   */
  close(cause?: unknown): void {
    if (this.closed) return
    this.closed = true
    if (cause !== undefined) {
      this.rejectTerminal?.(
        cause instanceof MutiAgentError
          ? cause
          : new MutiAgentError(ErrorCodes.runProtocolError, 'the run stream ended without a terminal event', {
              cause,
              remediation: 'Re-dispatch the run; if it repeats, capture the codex stdout stream for diagnosis.',
            }),
      )
      this.resolveTerminal = undefined
      this.rejectTerminal = undefined
    }
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /** Consume events in order; completes after the terminal event has been yielded. */
  async *[Symbol.asyncIterator](): AsyncGenerator<AgentRunEvent> {
    while (true) {
      while (this.pending.length > 0) {
        const next = this.pending.shift()
        if (next !== undefined) yield next
      }
      if (this.closed) return
      await new Promise<void>(resolve => {
        this.waiter = resolve
      })
    }
  }
}
