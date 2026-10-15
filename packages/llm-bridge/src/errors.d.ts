/**
 * Provider-neutral failures and the classification of provider responses onto them.
 *
 * The harness routes retries by `code`, never by message text, and its default retry
 * policy makes exactly `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT` and
 * `TRANSPORT` retryable — so a transient provider failure must land on one of those
 * codes and a permanent one must not.
 *
 * `LlmError` carries `code` and `failure` as own data properties, which is what lets a
 * failure thrown by this plugin reach the harness's runtime with its status, retry delay
 * and request id intact: the runtime rebuilds a serializable failure from those two
 * properties instead of trusting class identity across packages.
 *
 * @module @zorker/muti-agent-llm-bridge/errors
 */
import type { LlmFailure } from './contract.ts';
/** Credential rejected or absent at the provider boundary. */
export declare const AUTH_CODE = "AUTH";
/** Account quota, balance or credits exhausted; distinct from a transient rate limit. */
export declare const QUOTA_CODE = "QUOTA";
/** Request-rate limit; retryable after the provider's own delay. */
export declare const RATE_LIMIT_CODE = "RATE_LIMIT";
/** Request exceeded the model's context window. */
export declare const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";
/** Request rejected on its own merits; resending it identically cannot succeed. */
export declare const INVALID_REQUEST_CODE = "INVALID_REQUEST";
/** Provider-side failure; retryable. */
export declare const SERVER_CODE = "SERVER";
/** Request or stream deadline; retryable. */
export declare const TIMEOUT_CODE = "TIMEOUT";
/** Connection-level failure; retryable. */
export declare const TRANSPORT_CODE = "TRANSPORT";
/** Caller cancellation. */
export declare const ABORTED_CODE = "ABORTED";
/** A stream that violates its own wire protocol, such as unparsable event JSON. */
export declare const MALFORMED_RESPONSE_CODE = "MALFORMED_RESPONSE";
/** A stream that ended before the provider's terminal event; retryable. */
export declare const STREAM_CLOSED_CODE = "STREAM_CLOSED";
/** A completed response that carried no content at all; retryable. */
export declare const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
/** Content this route cannot carry, such as an image on a text-only route. */
export declare const UNSUPPORTED_CONTENT_CODE = "UNSUPPORTED_CONTENT";
/** A request option this route cannot express on the wire. */
export declare const UNSUPPORTED_OPTION_CODE = "UNSUPPORTED_OPTION";
/** No credential resolved for a route that needs one. */
export declare const MISSING_CREDENTIAL_CODE = "MISSING_CREDENTIAL";
/** The requested model is not one this route's configuration declares. */
export declare const UNKNOWN_MODEL_CODE = "UNKNOWN_MODEL";
/** Options carrying the structured provider facts a failure may retain. */
export interface LlmErrorOptions {
    /** HTTP status observed at the provider boundary. */
    status?: number;
    /** Positive provider-requested delay in milliseconds. */
    providerRetryAfterMs?: number;
    /** Opaque provider request id. */
    requestId?: string;
    /** Chained cause, for diagnostics only. */
    cause?: unknown;
}
/**
 * Typed failure with a stable machine code and the serializable facts beside it.
 *
 * The message never carries a credential: it is rendered by diagnostics and notices, and
 * a provider error body is the one place a key can be echoed back.
 */
export declare class LlmError extends Error {
    /** Stable provider-neutral failure class; route on this, never on the message. */
    readonly code: string;
    /** Serializable facts retained beside this live Error. */
    readonly failure: LlmFailure;
    /**
     * @param message - Non-empty human-readable failure summary.
     * @param code - Non-empty stable machine code.
     * @param options - Optional structured provider facts and cause.
     */
    constructor(message: string, code: string, options?: LlmErrorOptions);
}
/**
 * Whether a thrown value is this package's typed failure.
 *
 * @param value - The caught value.
 * @returns `true` only for a real {@link LlmError}.
 */
export declare function isLlmError(value: unknown): value is LlmError;
/** A provider error body reduced to the fields worth classifying. */
interface ProviderErrorDetail {
    /** Combined `type`, `code` and `message` text used for wording checks. */
    detail: string;
    /** Provider-supplied message, when the body carried one. */
    message?: string;
}
/**
 * Read the classified fields out of a provider error body.
 *
 * A gateway may return a non-JSON body or omit the envelope entirely; the HTTP status is
 * authoritative in that case and the raw text is kept only as a bounded diagnostic.
 *
 * @param body - Response body text, exactly as received.
 * @returns The combined detail text and the provider's own message when present.
 */
export declare function providerErrorDetail(body: string): ProviderErrorDetail;
/**
 * Remove anything that looks like a credential from text a provider sent back.
 *
 * A provider error body is echoed to a user through a notice, and gateways routinely
 * quote the offending header — the request's own key included — in that body.
 *
 * @param text - Provider-supplied text.
 * @returns The same text with credential-shaped substrings replaced.
 */
export declare function redact(text: string): string;
/**
 * Classify one provider HTTP failure.
 *
 * @param status - HTTP status of the failed response.
 * @param body - Response body text.
 * @param headers - Response headers, read for `retry-after` and a request id.
 * @returns A typed failure whose code selects the harness's retry policy.
 */
export declare function classifyHttpFailure(status: number, body: string, headers?: Headers): LlmError;
/**
 * Classify an error the provider delivered inside the stream itself.
 *
 * A mid-stream error carries no HTTP status, so only its own wording classifies it; the
 * absence of a status is why an unrecognized one maps to `SERVER` rather than to an
 * `HTTP_<status>` code — the request did reach the provider.
 *
 * @param payload - The decoded provider event carrying the error.
 * @returns A typed failure with no HTTP status.
 */
export declare function classifyInBandFailure(payload: unknown): LlmError;
/**
 * Classify a transport-level failure that never produced a response.
 *
 * @param error - The caught value from `fetch` or from reading the response body.
 * @param signal - The caller's cancellation signal; an aborted caller owns the outcome.
 * @returns A typed failure: `ABORTED` for caller cancellation, otherwise `TRANSPORT`.
 */
export declare function classifyTransportFailure(error: unknown, signal?: AbortSignal): LlmError;
export {};
//# sourceMappingURL=errors.d.ts.map