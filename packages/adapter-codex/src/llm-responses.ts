/**
 * The OpenAI Responses wire, as Codex's own client speaks it.
 *
 * Codex's `config.toml` accepts exactly one `wire_api` value — `"responses"`
 * (`WireApi` in `codex-rs/model-provider-info/src/lib.rs`, whose `Deserialize`
 * rejects anything else) — so a Codex route posts a `ResponsesApiRequest`-shaped
 * body to `<base_url>/responses` and reads back the event stream Codex reads.
 * Request shape, item vocabulary and event names are verified against the revision
 * named in this package's README.
 *
 * Three documented divergences from Codex's client are deliberate:
 *
 * - Codex ignores `response.function_call_arguments.delta` and takes a function
 *   call's arguments from the finished item. This adapter consumes both, so the
 *   harness can show a call while it is still being written.
 * - Codex discards an event record whose terminating blank line never arrived and
 *   fails the stream as incomplete. The shared framing discards it too (an event
 *   a provider never finished writing is not an event) but reports the
 *   truncation, and this module turns that report into a `STREAM_CLOSED` failure
 *   naming it.
 * - Codex carries its base instructions as a `developer` input message and never
 *   sends the request-level `instructions` field (commit c9253c4977, "Send base
 *   instructions as Responses input messages"). This adapter does the same, so a
 *   leading harness `system` message is one more `developer` item and no field
 *   this revision no longer defines reaches the wire.
 *
 * @module @zorker/muti-agent-adapter-codex/llm-responses
 */

import {
  classifyInBandFailure,
  EMPTY_RESPONSE_CODE,
  LlmError,
  MALFORMED_RESPONSE_CODE,
  SERVER_CODE,
  STREAM_CLOSED_CODE,
  toolCallId,
  UNSUPPORTED_CONTENT_CODE,
  UNSUPPORTED_OPTION_CODE,
} from '@zorker/muti-agent-llm-bridge'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmFailure,
  RequestMessage,
  StreamChunk,
  TokenUsage,
} from '@zorker/muti-agent-llm-bridge'
import type { SseFrame } from '@zorker/muti-agent-llm-bridge'

/** The Responses endpoint, relative to a provider's `base_url`. */
export const RESPONSES_PATH = 'responses'

/**
 * The provider refused to produce the content its own policy covers.
 *
 * Declared here rather than imported because the shared transport raises it for the
 * chat-completions wire only, where a `content_filter` finish reason carries it; both
 * spellings must stay identical so consumers route on one code.
 */
export const CONTENT_FILTER_CODE = 'CONTENT_FILTER'

/**
 * The request body for one model call.
 *
 * Field selection follows Codex's own client: `store: false` (nothing is kept
 * provider-side), `stream: true`, `tool_choice: "auto"`, parallel tool calls on,
 * and `prompt_cache_key` carrying the session identity the harness stamped, which
 * is the field Codex uses for the same purpose. `temperature` and
 * `max_output_tokens` are the public Responses spelling of the request's own
 * controls and are sent only when the request set them; the current Codex client
 * sends neither because its prompt assembly never sets them.
 *
 * A leading `system` message — or the `system` text of a one-shot caller — becomes
 * a `developer` input message, which is how Codex's own client carries its base
 * instructions (see this module's header).
 *
 * @param options - the assembled request.
 * @returns a JSON-serializable body.
 * @throws LlmError with code `UNSUPPORTED_OPTION` when the request names stop
 *   sequences, which the Responses request vocabulary has no field for.
 */
export function responsesRequestBody(options: GenerateOptions): Record<string, unknown> {
  if (options.stop !== undefined && options.stop.length > 0) {
    // The Responses API has no `stop` field; dropping the sequences would silently
    // change what the model is allowed to emit, so the request is refused instead.
    throw new LlmError(
      'this route cannot express stop sequences: the Responses request vocabulary has no stop field',
      UNSUPPORTED_OPTION_CODE,
    )
  }
  const input: Record<string, unknown>[] = []
  if (options.system !== undefined && options.system !== '') {
    input.push(messageItem('developer', [{ type: 'input_text', text: options.system }]))
  }
  for (const message of options.messages) input.push(...inputItems(message))
  const body: Record<string, unknown> = {
    model: options.model,
    input,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: false,
    stream: true,
  }
  const tools = options.tools
  if (tools !== undefined && tools.length > 0) {
    body['tools'] = tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // Codex's own tool declarations set `strict: false`, and a strict schema
      // needs every property required, which provider-neutral harness schemas are
      // not written for.
      strict: false,
    }))
  }
  if (options.reasoningEffort !== undefined) body['reasoning'] = { effort: String(options.reasoningEffort) }
  if (options.temperature !== undefined) body['temperature'] = options.temperature
  if (options.maxTokens !== undefined) body['max_output_tokens'] = options.maxTokens
  if (options.sessionId !== undefined) body['prompt_cache_key'] = options.sessionId
  return body
}

/**
 * One message as ordered input items.
 *
 * An assistant message's tool-call blocks become `function_call` items of their
 * own, so the `function_call_output` a later tool-role message produces always has
 * its call in context. A reasoning block is never sent back: a Responses route
 * accepts a reasoning item only together with the encrypted form the provider
 * returned, and the harness reply state that would carry it is not part of the
 * shared seam this adapter speaks (see the README's declared unsupported cases).
 *
 * @param message - one request message.
 * @returns the items to append to `input`, in order.
 * @throws LlmError with code `MALFORMED_RESPONSE` for a tool result with no call
 *   id to answer, and `UNSUPPORTED_CONTENT` for a block this route cannot carry.
 */
function inputItems(message: RequestMessage): Record<string, unknown>[] {
  switch (message.role) {
    case 'system':
    case 'developer': {
      // Tool-addition and tool-removal blocks have no Responses representation;
      // without a declared `toolUpdate` the harness already declares the complete
      // tool list on every request, so nothing is lost by skipping them.
      const text = joinedText(message.content)
      return text === '' ? [] : [messageItem('developer', [{ type: 'input_text', text }])]
    }
    case 'user': {
      const text = joinedText(message.content)
      return text === '' ? [] : [messageItem('user', [{ type: 'input_text', text }])]
    }
    case 'assistant':
      return assistantItems(message)
    case 'tool': {
      const callId = message.toolCallId
      if (callId === undefined) {
        throw new LlmError(
          'this route received a tool result without a call id, so it cannot be answered on the wire',
          MALFORMED_RESPONSE_CODE,
        )
      }
      return [{ type: 'function_call_output', call_id: callId, output: joinedText(message.content) }]
    }
  }
}

/** One assistant message's items, in content-block order. */
function assistantItems(message: RequestMessage): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') items.push(messageItem('assistant', [{ type: 'output_text', text: block.text }]))
        break
      case 'tool-call':
        items.push({ type: 'function_call', name: block.name, arguments: block.arguments, call_id: block.id })
        break
      case 'reasoning':
        // Thinking is not part of a request on this wire protocol.
        break
      default:
        // The harness content vocabulary is merge-extensible, so a block type this
        // module does not model can still arrive from another plugin.
        throw new LlmError(
          `this route cannot send block type "${unmodeledBlockType(block)}"`,
          UNSUPPORTED_CONTENT_CODE,
        )
    }
  }
  return items
}

/**
 * The `type` tag off a content block this module does not model.
 *
 * @param block - the unmodeled block, narrowed to `never` by the exhaustive switch.
 * @returns its `type` tag, or `unknown` when it carries none.
 */
function unmodeledBlockType(block: never): string {
  const record = asRecord(block)
  const type = record === undefined ? undefined : str(record, 'type')
  return type ?? 'unknown'
}

/** One `message` item in the Responses input vocabulary. */
function messageItem(role: string, content: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'message', role, content }
}

/** The concatenated text of a content block list, ignoring non-text blocks. */
function joinedText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/** One block accumulating deltas. */
interface OpenBlock {
  readonly index: number
  text: string
  /** Present for a tool call: the provider's call id, final name and accumulated arguments JSON. */
  call?: { readonly id: string; name: string; arguments: string }
}

/**
 * Translates one Responses event stream into harness chunks.
 *
 * The adapter contract this class carries: `block-start` precedes every delta of
 * its block; each opened block is closed by exactly one `block-end`, whose payload
 * is authoritative (a finished item's text is used only when it extends what
 * already streamed, so the assembled block can never contradict the deltas a
 * consumer already saw); `usage` precedes the single terminal `finish`; and
 * nothing follows it. A failure the provider reports inside the stream is thrown
 * from {@link finish}, which is one of the two error paths the harness sanctions.
 */
export class ResponsesTranslator {
  private readonly texts = new Map<string, OpenBlock>()
  private readonly reasonings = new Map<string, OpenBlock>()
  private readonly calls = new Map<string, OpenBlock>()
  private readonly callByItemId = new Map<string, string>()
  private readonly response: Record<string, unknown> = {}
  private index = 0
  private usage: TokenUsage | undefined
  private failure: LlmError | undefined
  private ended = false
  private toolCalls = 0
  private blocks = 0

  /** Whether the response reached its terminal event, so no further frame can matter. */
  get terminal(): boolean {
    return this.ended || this.failure !== undefined
  }

  /** The response id observed so far, for diagnostics. */
  get responseId(): string | undefined {
    return str(this.response, 'id')
  }

  /**
   * Translate one decoded frame.
   * @param frame - the SSE frame.
   * @returns the chunks it produced, in order.
   */
  push(frame: SseFrame): StreamChunk[] {
    const payload = parseJson(frame.data)
    if (payload === undefined) return []
    // Codex keys off the payload's `type`; the frame's `event` name is advisory.
    const kind = str(payload, 'type') ?? frame.event
    if (kind === undefined) return []
    switch (kind) {
      case 'response.created':
        return this.created(payload)
      case 'response.output_item.added':
        return this.itemAdded(payload)
      case 'response.output_item.done':
        return this.itemDone(payload)
      case 'response.output_text.delta':
        return this.textDelta(payload)
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
        return this.argumentsDelta(payload)
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return this.reasoningDelta(payload)
      case 'response.completed':
      case 'response.incomplete':
        return this.completedResponse(kind, payload)
      case 'response.failed':
        return this.failedResponse(payload)
      case 'error':
        return this.errorEvent(payload)
      default:
        // `response.in_progress`, `response.output_text.done`, `response.metadata`
        // and every other event Codex ignores carry nothing this vocabulary needs.
        return []
    }
  }

  /**
   * End the stream: close every open block, then emit usage and one `finish`.
   * @returns the final chunks.
   * @throws {LlmError} the in-band failure the stream reported, if any.
   */
  finish(): StreamChunk[] {
    if (this.failure !== undefined) throw this.failure
    const chunks: StreamChunk[] = []
    for (const open of this.texts.values()) chunks.push(close(open, { type: 'text', text: open.text }))
    for (const open of this.reasonings.values()) chunks.push(close(open, { type: 'reasoning', text: open.text }))
    for (const open of this.calls.values()) {
      const call = open.call
      if (call === undefined) continue
      chunks.push(close(open, { type: 'tool-call', id: toolCallId(call.id), name: call.name, arguments: call.arguments }))
    }
    this.texts.clear()
    this.reasonings.clear()
    this.calls.clear()
    if (this.usage !== undefined) chunks.push({ type: 'usage', usage: this.usage })
    chunks.push({ type: 'finish', reason: this.finishReason() })
    return chunks
  }

  /** `response.created` records the response identity, which is all it carries that matters. */
  private created(payload: Record<string, unknown>): StreamChunk[] {
    const response = asRecord(payload['response'])
    if (response === undefined) return []
    for (const key of ['id', 'model']) {
      const value = str(response, key)
      if (value !== undefined) this.response[key] = value
    }
    return []
  }

  /** `response.output_item.added` fixes a function call's identity before its arguments arrive. */
  private itemAdded(payload: Record<string, unknown>): StreamChunk[] {
    const item = asRecord(payload['item'])
    if (item === undefined) return []
    const type = str(item, 'type')
    if (type !== 'function_call' && type !== 'custom_tool_call') return []
    const itemId = str(item, 'id')
    const callId = str(item, 'call_id') ?? itemId
    if (callId === undefined) return []
    return this.openCall(callId, itemId, str(item, 'name') ?? '')
  }

  /** `response.output_item.done` completes the block that item describes. */
  private itemDone(payload: Record<string, unknown>): StreamChunk[] {
    const item = asRecord(payload['item'])
    if (item === undefined) return []
    const type = str(item, 'type')
    const itemId = str(item, 'id')
    if (type === 'message') return this.doneMessage(itemId, messageText(item))
    if (type === 'function_call' || type === 'custom_tool_call') {
      const callId = str(item, 'call_id')
      const key = callId ?? (itemId === undefined ? undefined : this.callByItemId.get(itemId)) ?? itemId
      if (key === undefined) return []
      return this.doneCall(key, str(item, 'arguments') ?? str(item, 'input') ?? '')
    }
    if (type === 'reasoning') return this.doneReasoning(itemId, reasoningText(item))
    return []
  }

  /** `response.output_text.delta` appends visible text to one item's block. */
  private textDelta(payload: Record<string, unknown>): StreamChunk[] {
    const delta = str(payload, 'delta')
    if (delta === undefined) return []
    const itemId = str(payload, 'item_id')
    const key = itemId ?? 'message'
    const chunks = this.texts.has(key) ? [] : this.openText(key)
    const open = this.texts.get(key)
    if (open === undefined) return chunks
    open.text += delta
    return [...chunks, { type: 'text-delta', index: open.index, text: delta }]
  }

  /** `response.function_call_arguments.delta` streams a tool call's raw JSON. */
  private argumentsDelta(payload: Record<string, unknown>): StreamChunk[] {
    const delta = str(payload, 'delta')
    if (delta === undefined) return []
    const itemId = str(payload, 'item_id')
    const callId = str(payload, 'call_id')
    const key = (itemId === undefined ? undefined : this.callByItemId.get(itemId)) ?? callId ?? itemId
    if (key === undefined) return []
    const chunks = this.calls.has(key) ? [] : this.openCall(key, itemId, '')
    const open = this.calls.get(key)
    if (open === undefined) return chunks
    const call = open.call
    if (call === undefined) return chunks
    call.arguments += delta
    return [...chunks, {
      type: 'tool-call-delta',
      index: open.index,
      id: toolCallId(call.id),
      // The name is repeated on every delta once known, so a consumer assembling the
      // stream carries the tool identity before the call is closed.
      ...call.name === '' ? {} : { name: call.name },
      argumentsDelta: delta,
    }]
  }

  /** A reasoning summary or reasoning-text delta opens or grows a reasoning block. */
  private reasoningDelta(payload: Record<string, unknown>): StreamChunk[] {
    const delta = str(payload, 'delta')
    if (delta === undefined) return []
    const itemId = str(payload, 'item_id') ?? str(payload, 'id') ?? 'reasoning'
    const part = num(payload, 'summary_index') ?? num(payload, 'content_index') ?? 0
    const key = `${itemId}#${String(part)}`
    const chunks = this.reasonings.has(key) ? [] : this.openReasoning(key)
    const open = this.reasonings.get(key)
    if (open === undefined) return chunks
    open.text += delta
    return [...chunks, { type: 'reasoning-delta', index: open.index, text: delta }]
  }

  /**
   * `response.completed` / `response.incomplete`: status, end-turn flag, usage and reason.
   *
   * An `incomplete` response is a terminal state, not a truncation: `content_filter` is
   * the provider refusing the content, `max_output_tokens` is the length cap the harness
   * already has a finish reason for, and `interrupted` is a turn the server ended, which
   * Codex's own client likewise accepts. Any other reason names a stop neither this
   * vocabulary nor the request can explain, so it fails as a provider-side error.
   */
  private completedResponse(kind: string, payload: Record<string, unknown>): StreamChunk[] {
    const response = asRecord(payload['response']) ?? {}
    this.ended = true
    this.response['status'] = kind === 'response.completed' ? 'completed' : 'incomplete'
    const id = str(response, 'id')
    if (id !== undefined) this.response['id'] = id
    const endTurn = response['end_turn']
    if (typeof endTurn === 'boolean') this.response['endTurn'] = endTurn
    const reason = incompleteReason(response)
    if (reason !== undefined) this.response['incompleteReason'] = reason
    this.usage = usageOf(response['usage'])
    if (kind !== 'response.incomplete') return []
    if (reason === 'content_filter') {
      this.failure = new LlmError(
        'the provider stopped the response with a content filter',
        CONTENT_FILTER_CODE,
      )
    } else if (reason !== 'max_output_tokens' && reason !== 'interrupted') {
      this.failure = new LlmError(
        `the provider stopped the response before completion (reason: ${reason ?? 'unknown'})`,
        SERVER_CODE,
      )
    }
    return []
  }

  /** `response.failed` carries a terminal provider error inside an HTTP 200 stream. */
  private failedResponse(payload: Record<string, unknown>): StreamChunk[] {
    this.failure = classifyInBandFailure(asRecord(payload['response']) ?? payload)
    return []
  }

  /** A top-level `error` event, which is terminal for the whole stream. */
  private errorEvent(payload: Record<string, unknown>): StreamChunk[] {
    this.failure = classifyInBandFailure(asRecord(payload['error']) ?? payload)
    return []
  }

  /** Complete one message item: extend the streamed text, then close the block. */
  private doneMessage(itemId: string | undefined, full: string): StreamChunk[] {
    const key = itemId ?? 'message'
    if (!this.texts.has(key) && full === '') return []
    const chunks = this.texts.has(key) ? [] : this.openText(key)
    const extended = this.extendText(key, full)
    const open = this.texts.get(key)
    if (open === undefined) return [...chunks, ...extended]
    this.texts.delete(key)
    return [...chunks, ...extended, close(open, { type: 'text', text: open.text })]
  }

  /** Complete one function call: extend the streamed arguments, then close the block. */
  private doneCall(key: string, full: string): StreamChunk[] {
    const open = this.calls.get(key)
    if (open === undefined) return []
    const call = open.call
    if (call === undefined) return []
    const chunks = full.startsWith(call.arguments) ? this.extendArguments(key, full) : []
    this.calls.delete(key)
    return [...chunks, close(open, { type: 'tool-call', id: toolCallId(call.id), name: call.name, arguments: call.arguments })]
  }

  /** Complete the reasoning blocks of one finished item. */
  private doneReasoning(itemId: string | undefined, full: string): StreamChunk[] {
    const chunks: StreamChunk[] = []
    for (const [key, open] of [...this.reasonings]) {
      if (itemId !== undefined && !key.startsWith(`${itemId}#`)) continue
      this.reasonings.delete(key)
      if (full.startsWith(open.text)) {
        const missing = full.slice(open.text.length)
        if (missing !== '') {
          open.text = full
          chunks.push({ type: 'reasoning-delta', index: open.index, text: missing })
        }
      }
      chunks.push(close(open, { type: 'reasoning', text: open.text }))
    }
    return chunks
  }

  /** Open a text block for one item key. */
  private openText(key: string): StreamChunk[] {
    const open: OpenBlock = { index: this.index++, text: '' }
    this.texts.set(key, open)
    this.blocks += 1
    return [{ type: 'block-start', index: open.index, blockType: 'text' }]
  }

  /** Open a reasoning block for one summary/content part key. */
  private openReasoning(key: string): StreamChunk[] {
    const open: OpenBlock = { index: this.index++, text: '' }
    this.reasonings.set(key, open)
    this.blocks += 1
    return [{ type: 'block-start', index: open.index, blockType: 'reasoning' }]
  }

  /** Open a tool-call block, or return nothing when it already exists. */
  private openCall(callId: string, itemId: string | undefined, name: string): StreamChunk[] {
    if (itemId !== undefined) this.callByItemId.set(itemId, callId)
    const existing = this.calls.get(callId)
    if (existing !== undefined) {
      const call = existing.call
      if (call !== undefined && call.name === '' && name !== '') call.name = name
      return []
    }
    const open: OpenBlock = { index: this.index++, text: '', call: { id: callId, name, arguments: '' } }
    this.calls.set(callId, open)
    this.blocks += 1
    this.toolCalls += 1
    return [{ type: 'block-start', index: open.index, blockType: 'tool-call' }]
  }

  /** Append text a completed item supplied beyond what streamed, keeping the deltas authoritative. */
  private extendText(key: string, full: string): StreamChunk[] {
    const open = this.texts.get(key)
    if (open === undefined || !full.startsWith(open.text)) return []
    const missing = full.slice(open.text.length)
    if (missing === '') return []
    open.text = full
    return [{ type: 'text-delta', index: open.index, text: missing }]
  }

  /** Append arguments JSON a completed item supplied beyond what streamed. */
  private extendArguments(key: string, full: string): StreamChunk[] {
    const open = this.calls.get(key)
    if (open === undefined) return []
    const call = open.call
    if (call === undefined) return []
    const missing = full.slice(call.arguments.length)
    if (missing === '') return []
    call.arguments = full
    return [{
      type: 'tool-call-delta',
      index: open.index,
      id: toolCallId(call.id),
      ...call.name === '' ? {} : { name: call.name },
      argumentsDelta: missing,
    }]
  }

  /** The stop reason the accumulated state implies. */
  private finishReason(): FinishReason {
    if (this.toolCalls > 0) return { kind: 'tool-calls' }
    if (str(this.response, 'incompleteReason') === 'max_output_tokens') return { kind: 'max-tokens' }
    if (this.ended && this.blocks === 0) {
      // A terminal event with nothing in it is a retryable failure, not a silent
      // empty turn; `EMPTY_RESPONSE` is the code the harness retries by default.
      return {
        kind: 'error',
        failure: emptyFailure(`the provider returned an empty response (status ${str(this.response, 'status') ?? 'unknown'})`),
      }
    }
    return { kind: 'stop' }
  }
}

/** The failure a finish chunk carries for an empty completion. */
function emptyFailure(message: string): LlmFailure {
  return { message, code: EMPTY_RESPONSE_CODE }
}

/**
 * The failure one stream ended with, when it never reached its terminal event.
 *
 * @param truncated - whether the framing discarded a half-written final record.
 * @returns the failure to raise.
 */
export function streamClosedFailure(truncated: boolean): LlmError {
  return new LlmError(
    truncated
      ? 'the provider stream ended with a half-written final event, so its completion is unknown'
      : 'the provider stream ended before its terminal event',
    STREAM_CLOSED_CODE,
  )
}

/** Close one block: the single `block-end` chunk for its index. */
function close(open: OpenBlock, block: ContentBlock): StreamChunk {
  return { type: 'block-end', index: open.index, block }
}

/** The concatenated `output_text` parts of a finished message item. */
function messageText(item: Record<string, unknown>): string {
  const content = item['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const record = asRecord(part)
    if (record === undefined || str(record, 'type') !== 'output_text') continue
    const text = str(record, 'text')
    if (text !== undefined) parts.push(text)
  }
  return parts.join('')
}

/** The concatenated summary text of a finished reasoning item. */
function reasoningText(item: Record<string, unknown>): string {
  const summary = item['summary']
  if (!Array.isArray(summary)) return ''
  const parts: string[] = []
  for (const part of summary) {
    const text = str(asRecord(part), 'text')
    if (text !== undefined) parts.push(text)
  }
  return parts.join('')
}

/** The `incomplete_details.reason` of a terminal response. */
function incompleteReason(response: Record<string, unknown>): string | undefined {
  const details = response['incomplete_details']
  return details === null ? undefined : str(asRecord(details), 'reason')
}

/**
 * Map provider usage onto the harness's disjoint counters.
 *
 * The Responses `input_tokens` includes cached input, while the harness's
 * `inputTokens` is uncached input only, so the cache counters are subtracted out.
 * A provider reporting more cache tokens than input tokens is clamped to zero
 * instead of yielding a negative count.
 *
 * @param value - the `response.usage` payload.
 * @returns the counters, or `undefined` when the payload carries none.
 */
function usageOf(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value)
  if (usage === undefined) return undefined
  const input = num(usage, 'input_tokens') ?? 0
  const output = num(usage, 'output_tokens') ?? 0
  const details = asRecord(usage['input_tokens_details'])
  const cacheRead = num(details, 'cached_tokens') ?? 0
  const cacheWrite = num(details, 'cache_write_tokens') ?? 0
  const reasoning = num(asRecord(usage['output_tokens_details']), 'reasoning_tokens') ?? 0
  const total = num(usage, 'total_tokens')
  return {
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    outputTokens: output,
    // The provider's plain `total_tokens` is a provider total over the aggregate
    // counts this mapping also received, so it is kept only while the two agree.
    ...total === undefined || total !== input + output ? {} : { totalTokens: total },
    ...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
}

/** Parse one frame's JSON payload, skipping a malformed frame exactly as Codex does. */
function parseJson(data: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  return asRecord(parsed)
}

/** A JSON object view of an unknown value, or `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
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
