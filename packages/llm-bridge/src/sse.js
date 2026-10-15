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
import { LlmError, MALFORMED_RESPONSE_CODE } from "./errors.js";
/** Default cap on one unterminated line; a provider event never legitimately exceeds it. */
const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;
/** Longest discarded tail kept for a diagnostic. */
const TAIL_CHARS = 200;
/**
 * Take the next complete line off `buffer`.
 *
 * @param buffer - Text received so far.
 * @param atEnd - Whether the response body has ended; then an unterminated remainder is
 *   itself the final line.
 * @returns The line and the remaining text, or `undefined` when no complete line is
 *   available yet.
 */
function takeLine(buffer, atEnd) {
    for (let index = 0; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (character === '\n')
            return { line: buffer.slice(0, index), rest: buffer.slice(index + 1) };
        if (character === '\r') {
            const next = buffer[index + 1];
            // A `CR` at the end of what has arrived so far may be the first half of a `CRLF`.
            if (next === undefined) {
                if (!atEnd)
                    return undefined;
                return { line: buffer.slice(0, index), rest: '', final: true };
            }
            return { line: buffer.slice(0, index), rest: buffer.slice(index + (next === '\n' ? 2 : 1)) };
        }
    }
    return atEnd && buffer !== '' ? { line: buffer, rest: '', final: true } : undefined;
}
/**
 * Apply one complete line to the record being accumulated.
 *
 * @param state - The record state to mutate.
 * @param line - The line, without its terminator.
 * @param onComment - Callback for comment lines.
 */
function applyLine(state, line, onComment) {
    if (line === '')
        return;
    if (line.startsWith(':')) {
        onComment?.(line.slice(1));
        return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon is wire syntax rather than part of the value.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');
    switch (field) {
        case 'data':
            state.data.push(value);
            state.seen = true;
            return;
        case 'event':
            state.event = value;
            state.seen = true;
            return;
        case 'id':
            state.id = value;
            state.seen = true;
            return;
        default:
            // `retry` and any other field are wire metadata this transport does not use.
            return;
    }
}
/**
 * Turn accumulated state into one record.
 *
 * @param state - The completed record state.
 * @returns The record, with its data lines joined by newlines.
 */
function toFrame(state) {
    const data = state.data.join('\n');
    return {
        data,
        ...state.event === undefined ? {} : { event: state.event },
        ...state.id === undefined ? {} : { id: state.id },
    };
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
export async function* readSseFrames(body, options = {}) {
    const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
    const decoder = new TextDecoder('utf-8');
    const reader = body.getReader();
    let buffered = '';
    let state = { data: [], seen: false };
    let sawFirstLine = false;
    let truncatedTail;
    /** Hand over the accumulated record, if any field was seen for it. */
    const dispatchable = () => {
        if (!state.seen)
            return undefined;
        const frame = toFrame(state);
        state = { data: [], seen: false };
        return frame;
    };
    try {
        while (true) {
            const result = await reader.read();
            const atEnd = result.done === true;
            // A chunk boundary may fall inside a UTF-8 sequence, so the decoder carries state
            // and is flushed only once the body has ended.
            buffered += atEnd ? decoder.decode() : decoder.decode(result.value, { stream: true });
            while (true) {
                const split = takeLine(buffered, atEnd);
                if (split === undefined)
                    break;
                buffered = split.rest;
                if (split.line === '') {
                    const frame = dispatchable();
                    if (frame !== undefined)
                        yield frame;
                    continue;
                }
                // A byte-order mark precedes the first field of a stream some gateways emit.
                const line = sawFirstLine ? split.line : split.line.replace(/^\uFEFF/u, '');
                sawFirstLine = true;
                applyLine(state, line, options.onComment);
                if (split.final === true) {
                    // EOF never dispatches a record: what a provider left half-written is not an
                    // event, and reporting it as one would hand a consumer a partial payload.
                    truncatedTail = state.data.join('\n');
                    break;
                }
            }
            if (buffered.length > maxLineChars) {
                throw new LlmError(`the provider stream sent a line longer than ${maxLineChars} characters without ending it`, MALFORMED_RESPONSE_CODE);
            }
            if (atEnd) {
                if (truncatedTail !== undefined || state.seen) {
                    return { truncated: true, tail: boundedTail(truncatedTail ?? state.data.join('\n')) };
                }
                return { truncated: false, tail: '' };
            }
        }
    }
    finally {
        // Cancelling releases the socket; a read still pending settles by rejection, which no
        // caller observes because this generator is already unwinding.
        void reader.cancel().catch(() => { });
    }
}
/**
 * Bound a discarded record for a diagnostic.
 *
 * @param text - The discarded text.
 * @returns Its head, with an ellipsis when it was cut.
 */
function boundedTail(text) {
    return text.length > TAIL_CHARS ? `${text.slice(0, TAIL_CHARS)}…` : text;
}
//# sourceMappingURL=sse.js.map