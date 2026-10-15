/**
 * OpenAI-compatible chat-completions transport over `fetch`.
 *
 * The request is built from the harness vocabulary and the streamed deltas are mapped back
 * onto it. Four rules shape the code:
 *
 * - **Tool calls are assembled, not passed through.** A provider sends the id and name in
 *   one delta and the arguments as fragments across many; the harness vocabulary keeps raw
 *   JSON strings and needs a stable block index from the first fragment, so each call gets
 *   one index, a `block-start` on its first fragment, and a `block-end` carrying the
 *   concatenated arguments.
 * - **Usage precedes the terminal finish, and nothing follows it.** Usage arrives after the
 *   chunk that carries `finish_reason`, so the terminal chunks are emitted only once the
 *   stream has ended: blocks closed, then usage, then exactly one finish.
 * - **A stream without the provider's terminal signal is a failure, not a short answer.**
 *   `finish_reason` or `[DONE]` settles the response; a body that ends without either is
 *   `STREAM_CLOSED`, which the retry policy treats as a transient truncation.
 * - **Every request carries attribution headers**, merged so a route-declared header cannot
 *   displace them.
 *
 * Reasoning blocks are never resent in a request: no OpenAI-compatible field carries a
 * previous turn's thinking, and providers reject one that echoes it back. A request
 * message that reduces to nothing is omitted, because a role with no content is invalid on
 * the wire.
 *
 * @module @zorker/muti-agent-llm-bridge/openai
 */
import { mergedHeaders } from "./attribution.js";
import { toolCallId } from "./contract.js";
import { ABORTED_CODE, classifyHttpFailure, classifyInBandFailure, classifyTransportFailure, EMPTY_RESPONSE_CODE, LlmError, MALFORMED_RESPONSE_CODE, STREAM_CLOSED_CODE, UNSUPPORTED_CONTENT_CODE, UNSUPPORTED_OPTION_CODE, } from "./errors.js";
import { readSseFrames } from "./sse.js";
/** Longest provider error body read into a diagnostic. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/**
 * Whether a decoded JSON value is a plain object.
 *
 * @param value - Value to test.
 * @returns `true` for a non-null, non-array object.
 */
function asObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Read a string field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent or not a string.
 */
function asString(source, key) {
    const value = source[key];
    return typeof value === 'string' ? value : undefined;
}
/**
 * Read a non-negative integer field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent, negative or not an integer.
 */
function asCount(source, key) {
    const value = source[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/**
 * Read an array field.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The array, or `[]` when absent or not an array.
 */
function asArray(source, key) {
    const value = source[key];
    return Array.isArray(value) ? value : [];
}
/**
 * Read the `type` tag off a block this bridge does not model.
 *
 * @param block - The unmodeled block, narrowed to `never` by the exhaustive switch.
 * @returns Its `type` tag, or `unknown` when it carries none.
 */
function unmodeledBlockType(block) {
    const record = asObject(block);
    const type = record === undefined ? undefined : asString(record, 'type');
    return type ?? 'unknown';
}
/**
 * Serialize one request message onto the wire.
 *
 * @param message - The harness message.
 * @param provider - Route key, for diagnostics.
 * @returns The wire message, or `undefined` when it reduces to nothing the wire accepts.
 * @throws LlmError with code `UNSUPPORTED_CONTENT` for a block this transport cannot carry
 *   and `MALFORMED_RESPONSE` for a tool result with no call id to answer.
 */
function serializeMessage(message, provider) {
    // A developer message carries tool-addition/removal bookkeeping this route never
    // receives (it declares no tool-update mode), so only its text can matter.
    const role = message.role === 'developer' ? 'system' : message.role;
    const texts = [];
    const toolCalls = [];
    for (const block of message.content) {
        switch (block.type) {
            case 'text':
                texts.push(block.text);
                break;
            case 'tool-call':
                toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: { name: block.name, arguments: block.arguments },
                });
                break;
            case 'reasoning':
                // Thinking is not part of a request on this wire protocol.
                break;
            default:
                // The harness content vocabulary is merge-extensible, so a block type this
                // bridge does not model can still arrive from another plugin.
                throw new LlmError(`route "${provider}" cannot send block type "${unmodeledBlockType(block)}"`, UNSUPPORTED_CONTENT_CODE);
        }
    }
    const content = texts.join('');
    if (toolCalls.length > 0)
        return { role, content, tool_calls: toolCalls };
    if (content === '')
        return undefined;
    if (message.role === 'tool') {
        if (message.toolCallId === undefined) {
            throw new LlmError(`route "${provider}" received a tool result without a call id`, MALFORMED_RESPONSE_CODE);
        }
        return { role: 'tool', content, tool_call_id: message.toolCallId };
    }
    return { role, content };
}
/**
 * Build the request body for one chat-completions call.
 *
 * @param options - The harness request.
 * @param target - Route settings that shape the body.
 * @returns The JSON body, ready to serialize.
 * @throws LlmError with code `UNSUPPORTED_OPTION` when the request names a reasoning effort
 *   and the route declares no field to carry one.
 */
export function buildChatBody(options, target) {
    const messages = [];
    if (options.system !== undefined && options.system !== '') {
        messages.push({ role: 'system', content: options.system });
    }
    for (const message of options.messages) {
        const wire = serializeMessage(message, target.provider);
        if (wire !== undefined)
            messages.push(wire);
    }
    if (options.reasoningEffort !== undefined && target.supportsReasoningEffort !== true) {
        throw new LlmError(`route "${target.provider}" has no wire field for reasoning effort "${options.reasoningEffort}"`, UNSUPPORTED_OPTION_CODE);
    }
    const tools = options.tools ?? [];
    return {
        model: target.wireModel ?? options.model,
        messages,
        stream: true,
        ...target.includeUsage === false ? {} : { stream_options: { include_usage: true } },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
        ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: [...options.stop] },
        ...options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort },
        ...tools.length === 0
            ? {}
            : {
                tools: tools.map(tool => ({
                    type: 'function',
                    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                })),
            },
        ...target.body ?? {},
    };
}
/**
 * Decode one SSE record's data as a chat-completions event.
 *
 * @param data - The record's joined data lines.
 * @param provider - Route key, for diagnostics.
 * @returns The normalized event.
 * @throws LlmError with code `MALFORMED_RESPONSE` when the payload is not a JSON object or
 *   carries a delta this transport cannot map.
 */
export function decodeChatEvent(data, provider) {
    let parsed;
    try {
        parsed = JSON.parse(data);
    }
    catch (cause) {
        throw new LlmError(`route "${provider}" sent an event that is not JSON`, MALFORMED_RESPONSE_CODE, { cause });
    }
    const event = asObject(parsed);
    if (event === undefined) {
        throw new LlmError(`route "${provider}" sent an event that is not a JSON object`, MALFORMED_RESPONSE_CODE);
    }
    if (event.error !== undefined && event.error !== null) {
        return { delta: { toolCalls: [] }, error: event.error };
    }
    const choice = asObject(asArray(event, 'choices')[0]);
    const rawDelta = choice === undefined ? undefined : asObject(choice.delta);
    const usage = asObject(event.usage);
    const finishReason = choice === undefined ? undefined : asString(choice, 'finish_reason');
    return {
        delta: decodeDelta(rawDelta, provider),
        ...finishReason === undefined || finishReason === '' ? {} : { finishReason },
        ...usage === undefined ? {} : { usage },
    };
}
/**
 * Normalize one provider `delta`.
 *
 * @param raw - The provider delta object, if the event carried one.
 * @param provider - Route key, for diagnostics.
 * @returns The text, reasoning text and tool-call fragments it carried.
 */
function decodeDelta(raw, provider) {
    if (raw === undefined)
        return { toolCalls: [] };
    if (raw.function_call !== undefined && raw.function_call !== null) {
        // The pre-tool-calls legacy shape carries one un-indexed call; mapping it would
        // invent an index the provider never sent, so the route reports it instead.
        throw new LlmError(`route "${provider}" sent the legacy function_call delta, which this transport does not map`, UNSUPPORTED_CONTENT_CODE);
    }
    const text = decodeContent(raw.content, provider);
    const reasoning = asString(raw, 'reasoning_content') ?? asString(raw, 'reasoning');
    return {
        ...text === undefined ? {} : { text },
        ...reasoning === undefined ? {} : { reasoning },
        toolCalls: asArray(raw, 'tool_calls').flatMap((entry, position) => {
            const call = decodeToolCall(entry, position);
            return call === undefined ? [] : [call];
        }),
    };
}
/**
 * Read a delta's `content`, which providers send either as a string or as text parts.
 *
 * @param content - The raw `content` field.
 * @param provider - Route key, for diagnostics.
 * @returns The text, or `undefined` when the field is absent or carries none.
 * @throws LlmError with code `UNSUPPORTED_CONTENT` for a non-text part.
 */
function decodeContent(content, provider) {
    if (typeof content === 'string')
        return content === '' ? undefined : content;
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const entry of content) {
        const part = asObject(entry);
        if (part === undefined)
            continue;
        const type = asString(part, 'type');
        if (type === 'text') {
            const text = asString(part, 'text');
            if (text !== undefined && text !== '')
                parts.push(text);
            continue;
        }
        throw new LlmError(`route "${provider}" sent a content part of type "${type ?? 'unknown'}", which this route cannot carry`, UNSUPPORTED_CONTENT_CODE);
    }
    return parts.length === 0 ? undefined : parts.join('');
}
/**
 * Normalize one tool-call fragment.
 *
 * The identity is the provider's own call index when it sends one, because that is the only
 * field guaranteed to repeat identically across fragments; an id or name is the fallback,
 * and a provider that sends neither has one call in flight by construction.
 *
 * @param entry - One element of the delta's `tool_calls` array.
 * @param position - Its position in that array, used when the provider sends no index.
 * @returns The fragment, or `undefined` when the element is not an object at all.
 */
function decodeToolCall(entry, position) {
    const call = asObject(entry);
    if (call === undefined)
        return undefined;
    const index = asCount(call, 'index');
    const id = asString(call, 'id');
    const fn = asObject(call.function);
    const name = fn === undefined ? undefined : asString(fn, 'name');
    const args = fn === undefined ? undefined : asString(fn, 'arguments');
    const key = index === undefined ? id ?? name ?? `#${position}` : `#${index}`;
    return {
        key,
        ...id === undefined ? {} : { id },
        ...name === undefined ? {} : { name },
        ...args === undefined ? {} : { arguments: args },
    };
}
/**
 * Map a provider `finish_reason` onto the harness vocabulary.
 *
 * @param raw - The provider's finish reason.
 * @param provider - Route key, for diagnostics.
 * @returns The harness finish reason.
 * @throws LlmError with code `CONTENT_FILTER` for a provider-blocked response and
 *   `MALFORMED_RESPONSE` for a reason this vocabulary cannot express.
 */
export function mapFinishReason(raw, provider) {
    switch (raw) {
        case 'stop':
            return { kind: 'stop' };
        case 'length':
            return { kind: 'max-tokens' };
        case 'tool_calls':
        case 'function_call':
            return { kind: 'tool-calls' };
        case 'content_filter':
            // The provider stopped because its own policy blocked the response; the visible
            // text is incomplete, so this is a failure rather than a short answer.
            throw new LlmError(`route "${provider}" blocked the response with a content filter`, 'CONTENT_FILTER');
        default:
            throw new LlmError(`route "${provider}" sent unsupported finish_reason "${raw}"`, MALFORMED_RESPONSE_CODE);
    }
}
/**
 * Map a provider `usage` object onto harness token accounting.
 *
 * Counts in the harness are disjoint, so a cached prompt count is reported separately and
 * subtracted from the prompt total; the provider's own total is kept only when it is
 * consistent with the counters it was derived from.
 *
 * @param raw - The provider's `usage` object.
 * @returns The harness usage, or `undefined` when the provider disclosed no usable counts.
 */
export function mapUsage(raw) {
    const prompt = asCount(raw, 'prompt_tokens');
    const completion = asCount(raw, 'completion_tokens');
    if (prompt === undefined || completion === undefined)
        return undefined;
    const promptDetails = asObject(raw.prompt_tokens_details);
    const cached = (promptDetails === undefined ? undefined : asCount(promptDetails, 'cached_tokens')) ?? 0;
    const completionDetails = asObject(raw.completion_tokens_details);
    const reasoning = completionDetails === undefined
        ? undefined
        : asCount(completionDetails, 'reasoning_tokens');
    const total = asCount(raw, 'total_tokens');
    return {
        inputTokens: Math.max(0, prompt - cached),
        outputTokens: completion,
        ...total === undefined || total !== prompt + completion ? {} : { totalTokens: total },
        ...cached === 0 ? {} : { cacheReadTokens: cached },
        ...reasoning === undefined || reasoning === 0 ? {} : { reasoningTokens: reasoning },
    };
}
/**
 * Read a bounded prefix of a failed response's body.
 *
 * @param response - The failed response.
 * @returns The body text, truncated at {@link MAX_ERROR_BODY_BYTES}.
 */
async function readBoundedBody(response) {
    if (response.body === null)
        return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let text = '';
    let bytes = 0;
    try {
        while (bytes < MAX_ERROR_BODY_BYTES) {
            const step = await reader.read();
            if (step.done === true)
                break;
            bytes += step.value.byteLength;
            text += decoder.decode(step.value, { stream: true });
            if (bytes >= MAX_ERROR_BODY_BYTES)
                break;
        }
        text += decoder.decode();
    }
    catch (_unreadableErrorBody) {
        // The HTTP status already classifies the failure; a body we cannot read adds nothing.
    }
    finally {
        void reader.cancel().catch(() => { });
    }
    return text;
}
/**
 * Send one chat-completions request and stream its deltas as harness chunks.
 *
 * @param options - The fully-assembled harness request.
 * @param target - Endpoint, headers, route-specific wire settings and identity.
 * @returns The harness chunk stream: `block-start`/deltas/`block-end` per block, then
 *   `usage` when the provider reported counts, then exactly one `finish`.
 * @throws LlmError for a rejected request, a malformed event, a stream that ended before
 *   the provider's terminal signal, a caller cancellation, or a completed response that
 *   carried no content.
 */
export async function* streamChatCompletions(options, target) {
    const body = buildChatBody(options, target);
    const headers = {
        ...mergedHeaders(target.headers, target.identity),
        // Set after the merge: a route-declared content negotiation would break the framing,
        // and these two fields are what make the response an event stream at all.
        accept: 'text/event-stream',
        'content-type': 'application/json',
    };
    const send = target.fetch ?? globalThis.fetch;
    let response;
    try {
        response = await send(target.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            ...options.signal === undefined ? {} : { signal: options.signal },
        });
    }
    catch (error) {
        throw classifyTransportFailure(error, options.signal);
    }
    if (!response.ok) {
        const text = await readBoundedBody(response);
        throw classifyHttpFailure(response.status, text, response.headers);
    }
    if (response.body === null) {
        throw new LlmError(`route "${target.provider}" returned no response body`, EMPTY_RESPONSE_CODE);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (/^\s*application\/json\b/i.test(contentType)) {
        // The endpoint answered a streaming request with one JSON document: it ignored
        // `stream: true`, and guessing at the framing would invent events it never sent.
        throw new LlmError(`route "${target.provider}" ignored stream: true and answered with ${contentType}`, MALFORMED_RESPONSE_CODE);
    }
    const frames = readSseFrames(response.body)[Symbol.asyncIterator]();
    const slots = new Map();
    const order = [];
    let reason;
    let usage;
    let sawTerminalRecord = false;
    let end = { truncated: false, tail: '' };
    /**
     * Open the slot for one stream position.
     *
     * @param key - Stable identity of the call or content stream across deltas.
     * @param kind - Block type the slot produces.
     * @returns The slot, created on first use with the next harness block index.
     */
    const openSlot = (key, kind) => {
        const existing = slots.get(key);
        if (existing !== undefined)
            return existing;
        const slot = {
            index: order.length,
            kind,
            started: false,
            text: '',
            id: '',
            name: '',
            arguments: '',
        };
        slots.set(key, slot);
        order.push(slot);
        return slot;
    };
    try {
        while (true) {
            let step;
            try {
                step = await frames.next();
            }
            catch (error) {
                // A body the caller's abort or the socket killed surfaces here, not at `fetch`.
                throw classifyTransportFailure(error, options.signal);
            }
            if (step.done === true) {
                end = step.value;
                break;
            }
            if (options.signal?.aborted === true) {
                throw new LlmError(`route "${target.provider}" request aborted by the caller`, ABORTED_CODE);
            }
            const data = step.value.data.trim();
            if (data === '')
                continue;
            if (data === '[DONE]') {
                sawTerminalRecord = true;
                break;
            }
            const event = decodeChatEvent(data, target.provider);
            if (event.error !== undefined)
                throw classifyInBandFailure(event.error);
            const delta = event.delta;
            if (delta.reasoning !== undefined) {
                const slot = openSlot('reasoning', 'reasoning');
                if (!slot.started) {
                    slot.started = true;
                    yield { type: 'block-start', index: slot.index, blockType: 'reasoning' };
                }
                slot.text += delta.reasoning;
                yield { type: 'reasoning-delta', index: slot.index, text: delta.reasoning };
            }
            if (delta.text !== undefined) {
                const slot = openSlot('text', 'text');
                if (!slot.started) {
                    slot.started = true;
                    yield { type: 'block-start', index: slot.index, blockType: 'text' };
                }
                slot.text += delta.text;
                yield { type: 'text-delta', index: slot.index, text: delta.text };
            }
            for (const fragment of delta.toolCalls) {
                const slot = openSlot(`tool:${fragment.key}`, 'tool-call');
                if (!slot.started) {
                    slot.started = true;
                    yield { type: 'block-start', index: slot.index, blockType: 'tool-call' };
                }
                if (fragment.id !== undefined && fragment.id !== '')
                    slot.id = fragment.id;
                if (fragment.name !== undefined && fragment.name !== '')
                    slot.name = fragment.name;
                const argumentsDelta = fragment.arguments ?? '';
                slot.arguments += argumentsDelta;
                yield {
                    type: 'tool-call-delta',
                    index: slot.index,
                    id: toolCallId(slot.id),
                    ...slot.name === '' ? {} : { name: slot.name },
                    argumentsDelta,
                };
            }
            if (event.finishReason !== undefined) {
                reason = mapFinishReason(event.finishReason, target.provider);
                sawTerminalRecord = true;
            }
            if (event.usage !== undefined)
                usage = mapUsage(event.usage);
        }
    }
    finally {
        // Leaving the loop early (a terminal record, a failure, or an abandoned consumer)
        // cancels the body, so nothing keeps streaming into a response nobody reads.
        await frames.return({ truncated: false, tail: '' }).catch(() => undefined);
    }
    // The terminal reason is resolved before any block is closed: a stream this transport
    // refuses must not first present its blocks as complete.
    const terminal = settledReason();
    if (order.length === 0 && terminal.kind === 'stop') {
        throw new LlmError(`route "${target.provider}" completed the response with no content`, EMPTY_RESPONSE_CODE);
    }
    for (const slot of order) {
        if (!slot.started)
            continue;
        yield { type: 'block-end', index: slot.index, block: closeBlock(slot, target.provider) };
    }
    if (usage !== undefined)
        yield { type: 'usage', usage };
    yield { type: 'finish', reason: terminal };
    /**
     * Resolve the terminal reason, refusing a stream that never reached a terminal signal.
     *
     * A body cut after the provider's terminal record is accepted: the response itself is
     * complete, and only the counts that would have followed it are missing.
     *
     * @returns The terminal finish reason.
     */
    function settledReason() {
        if (reason !== undefined)
            return reason;
        if (!sawTerminalRecord || end.truncated) {
            throw new LlmError(`route "${target.provider}" stream ended before the provider's terminal event`, STREAM_CLOSED_CODE);
        }
        return { kind: order.some(slot => slot.kind === 'tool-call') ? 'tool-calls' : 'stop' };
    }
}
/**
 * Turn one finished slot into its assembled block.
 *
 * A tool call the provider never gave an id for keeps a synthesized one so the tool result
 * can answer it; a call with no name cannot be dispatched at all and is refused.
 *
 * @param slot - The slot, already closed on the wire.
 * @param provider - Route key, for diagnostics.
 * @returns The assembled content block.
 * @throws LlmError with code `MALFORMED_RESPONSE` for a call that names no tool.
 */
function closeBlock(slot, provider) {
    switch (slot.kind) {
        case 'text':
            return { type: 'text', text: slot.text };
        case 'reasoning':
            return { type: 'reasoning', text: slot.text };
        case 'tool-call': {
            if (slot.name === '') {
                throw new LlmError(`route "${provider}" sent a tool call with no name`, MALFORMED_RESPONSE_CODE);
            }
            return {
                type: 'tool-call',
                id: toolCallId(slot.id === '' ? `call_${slot.index}` : slot.id),
                name: slot.name,
                arguments: slot.arguments,
            };
        }
    }
}
//# sourceMappingURL=openai.js.map