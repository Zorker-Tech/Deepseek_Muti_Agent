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
import type { AppIdentity } from './attribution.ts';
import type { FinishReason, GenerateOptions, StreamChunk, TokenUsage } from './contract.ts';
/** The `fetch` shape this transport uses, so a test can inject a stub. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
/** Everything one chat-completions call needs beyond the harness request. */
export interface ChatCompletionsTarget {
    /** Provider route key this call belongs to; used in diagnostics only. */
    provider: string;
    /** Absolute chat-completions endpoint. */
    endpoint: string;
    /** Route-declared headers, including its credential; attribution names win collisions. */
    headers?: Readonly<Record<string, string>>;
    /** Model id sent on the wire; defaults to `GenerateOptions.model`. */
    wireModel?: string;
    /** Whether the provider's `stream_options.include_usage` is requested; defaults to `true`. */
    includeUsage?: boolean;
    /**
     * Whether this route accepts OpenAI's `reasoning_effort` field.
     *
     * Absent means it does not: sending a field the provider never reads would change the
     * request for a reason nothing downstream can see, so a request that names an effort is
     * refused instead.
     */
    supportsReasoningEffort?: boolean;
    /** Extra body fields merged last, for a route that needs one. */
    body?: Readonly<Record<string, unknown>>;
    /** Identity sent as attribution; defaults to this product's own. */
    identity?: AppIdentity;
    /** Injected transport; defaults to the global `fetch`. */
    fetch?: FetchLike;
}
/** One tool-call fragment, normalized out of a provider delta. */
interface ToolCallFragment {
    /** Stable identity of the call across deltas. */
    key: string;
    id?: string;
    name?: string;
    arguments?: string;
}
/** One provider delta, normalized. */
interface DecodedDelta {
    text?: string;
    reasoning?: string;
    toolCalls: readonly ToolCallFragment[];
}
/** One decoded provider event, normalized. */
interface DecodedEvent {
    delta: DecodedDelta;
    finishReason?: string;
    usage?: Record<string, unknown>;
    /** The provider's own error payload when the event carries one. */
    error?: unknown;
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
export declare function buildChatBody(options: GenerateOptions, target: ChatCompletionsTarget): Record<string, unknown>;
/**
 * Decode one SSE record's data as a chat-completions event.
 *
 * @param data - The record's joined data lines.
 * @param provider - Route key, for diagnostics.
 * @returns The normalized event.
 * @throws LlmError with code `MALFORMED_RESPONSE` when the payload is not a JSON object or
 *   carries a delta this transport cannot map.
 */
export declare function decodeChatEvent(data: string, provider: string): DecodedEvent;
/**
 * Map a provider `finish_reason` onto the harness vocabulary.
 *
 * @param raw - The provider's finish reason.
 * @param provider - Route key, for diagnostics.
 * @returns The harness finish reason.
 * @throws LlmError with code `CONTENT_FILTER` for a provider-blocked response and
 *   `MALFORMED_RESPONSE` for a reason this vocabulary cannot express.
 */
export declare function mapFinishReason(raw: string, provider: string): FinishReason;
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
export declare function mapUsage(raw: Record<string, unknown>): TokenUsage | undefined;
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
export declare function streamChatCompletions(options: GenerateOptions, target: ChatCompletionsTarget): AsyncGenerator<StreamChunk>;
export {};
//# sourceMappingURL=openai.d.ts.map