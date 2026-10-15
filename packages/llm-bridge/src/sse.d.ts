/**
 * Server-sent-events framing over a response body, decoded to records.
 *
 * This is the piece that must not be subtly wrong, so it implements the wire rules the
 * provider protocols actually rely on rather than a line-splitting approximation:
 *
 * - a field value runs to the end of its line, so one record's `data` may arrive as many
 *   `data:` lines and is joined with newlines;
 * - `CRLF`, `LF` and a lone `CR` all terminate a line, and a terminator may be split
 *   across two chunks;
 * - a chunk may end in the middle of a UTF-8 sequence, which is why decoding is streaming
 *   and the decoder is flushed at end of input;
 * - a line starting with `:` is a comment (a keep-alive) and contributes no record;
 * - a record is dispatched by a blank line, and a stream that ends before that blank line
 *   has its pending record **discarded** and reported as truncated: an event a provider
 *   never finished writing is not an event.
 *
 * @module @zorker/muti-agent-llm-bridge/sse
 */
/** One dispatchable SSE record. */
export interface SseFrame {
    /** `event` field, when the record names one. */
    event?: string;
    /** Joined `data` field lines; `''` when the record carried no data field. */
    data: string;
    /** `id` field, when the record names one. */
    id?: string;
}
/** How a stream ended. */
export interface SseStreamEnd {
    /** Whether a pending record was discarded because the stream ended before its blank line. */
    truncated: boolean;
    /** Bounded copy of the discarded text, for a diagnostic. */
    tail: string;
}
/** Reader options. */
export interface SseReadOptions {
    /** Called for each comment line, so a caller can treat one as liveness. */
    onComment?: (text: string) => void;
    /** Longest unterminated line accepted before the stream is called malformed. */
    maxLineChars?: number;
}
/**
 * Decode a response body into SSE records.
 *
 * The generator must be consumed to completion, or returned from, for the body to be
 * cancelled: a consumer that stops early stops paying for the rest of the response.
 *
 * @param body - Response body bytes, exactly as received.
 * @param options - Comment callback and the line-length cap.
 * @returns Every dispatchable record in arrival order. The generator's return value
 *   reports whether a pending record was discarded at end of input.
 * @throws LlmError with code `MALFORMED_RESPONSE` when one line exceeds the cap.
 */
export declare function readSseFrames(body: ReadableStream<Uint8Array>, options?: SseReadOptions): AsyncGenerator<SseFrame, SseStreamEnd>;
//# sourceMappingURL=sse.d.ts.map