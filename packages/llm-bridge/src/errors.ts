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

import { providerRequestId } from './contract.ts'
import type { LlmFailure } from './contract.ts'

/** Credential rejected or absent at the provider boundary. */
export const AUTH_CODE = 'AUTH'
/** Account quota, balance or credits exhausted; distinct from a transient rate limit. */
export const QUOTA_CODE = 'QUOTA'
/** Request-rate limit; retryable after the provider's own delay. */
export const RATE_LIMIT_CODE = 'RATE_LIMIT'
/** Request exceeded the model's context window. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
/** Request rejected on its own merits; resending it identically cannot succeed. */
export const INVALID_REQUEST_CODE = 'INVALID_REQUEST'
/** Provider-side failure; retryable. */
export const SERVER_CODE = 'SERVER'
/** Request or stream deadline; retryable. */
export const TIMEOUT_CODE = 'TIMEOUT'
/** Connection-level failure; retryable. */
export const TRANSPORT_CODE = 'TRANSPORT'
/** Caller cancellation. */
export const ABORTED_CODE = 'ABORTED'
/** A stream that violates its own wire protocol, such as unparsable event JSON. */
export const MALFORMED_RESPONSE_CODE = 'MALFORMED_RESPONSE'
/** A stream that ended before the provider's terminal event; retryable. */
export const STREAM_CLOSED_CODE = 'STREAM_CLOSED'
/** A completed response that carried no content at all; retryable. */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
/** Content this route cannot carry, such as an image on a text-only route. */
export const UNSUPPORTED_CONTENT_CODE = 'UNSUPPORTED_CONTENT'
/** A request option this route cannot express on the wire. */
export const UNSUPPORTED_OPTION_CODE = 'UNSUPPORTED_OPTION'
/** No credential resolved for a route that needs one. */
export const MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL'
/** The requested model is not one this route's configuration declares. */
export const UNKNOWN_MODEL_CODE = 'UNKNOWN_MODEL'

/** Options carrying the structured provider facts a failure may retain. */
export interface LlmErrorOptions {
  /** HTTP status observed at the provider boundary. */
  status?: number
  /** Positive provider-requested delay in milliseconds. */
  providerRetryAfterMs?: number
  /** Opaque provider request id. */
  requestId?: string
  /** Chained cause, for diagnostics only. */
  cause?: unknown
}

/**
 * Typed failure with a stable machine code and the serializable facts beside it.
 *
 * The message never carries a credential: it is rendered by diagnostics and notices, and
 * a provider error body is the one place a key can be echoed back.
 */
export class LlmError extends Error {
  /** Stable provider-neutral failure class; route on this, never on the message. */
  readonly code: string

  /** Serializable facts retained beside this live Error. */
  readonly failure: LlmFailure

  /**
   * @param message - Non-empty human-readable failure summary.
   * @param code - Non-empty stable machine code.
   * @param options - Optional structured provider facts and cause.
   */
  constructor(message: string, code: string, options: LlmErrorOptions = {}) {
    super(redact(message), options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.code = code
    const status = options.status
    const retryAfter = options.providerRetryAfterMs
    const requestId = options.requestId
    this.failure = Object.freeze({
      message: this.message,
      code,
      ...status === undefined || !Number.isInteger(status) || status < 100 || status > 599 ? {} : { status },
      ...retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter <= 0
        ? {}
        : { providerRetryAfterMs: retryAfter },
      ...requestId === undefined || requestId.length === 0 ? {} : { requestId: providerRequestId(requestId) },
    })
  }
}

/**
 * Whether a thrown value is this package's typed failure.
 *
 * @param value - The caught value.
 * @returns `true` only for a real {@link LlmError}.
 */
export function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError
}

/** A provider error body reduced to the fields worth classifying. */
interface ProviderErrorDetail {
  /** Combined `type`, `code` and `message` text used for wording checks. */
  detail: string
  /** Provider-supplied message, when the body carried one. */
  message?: string
}

/** Matches the provider error envelope shapes an OpenAI-compatible endpoint uses. */
const ERROR_FIELDS = ['error', 'detail', 'message'] as const

/**
 * Read the classified fields out of a provider error body.
 *
 * A gateway may return a non-JSON body or omit the envelope entirely; the HTTP status is
 * authoritative in that case and the raw text is kept only as a bounded diagnostic.
 *
 * @param body - Response body text, exactly as received.
 * @returns The combined detail text and the provider's own message when present.
 */
export function providerErrorDetail(body: string): ProviderErrorDetail {
  const trimmed = body.trim()
  if (trimmed === '') return { detail: '' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (_nonJsonProviderError) {
    // Some gateways answer with plain text; the status still classifies it.
    return { detail: bounded(trimmed) }
  }
  if (typeof parsed !== 'object' || parsed === null) return { detail: bounded(trimmed) }
  const envelope = parsed as Record<string, unknown>
  for (const field of ERROR_FIELDS) {
    const value = envelope[field]
    if (typeof value === 'string' && value.trim() !== '') return { detail: bounded(value.trim()) }
    if (typeof value === 'object' && value !== null) {
      const nested = value as Record<string, unknown>
      const parts = [nested.type, nested.code, nested.message, nested.detail]
        .filter((part): part is string => typeof part === 'string' && part !== '')
      if (parts.length > 0) {
        return { detail: bounded(parts.join(' ')), message: bounded(parts.join(' ')) }
      }
    }
  }
  return { detail: '' }
}

/** Longest provider detail any diagnostic keeps. */
const MAX_DETAIL_CHARS = 500

/** Bound a provider-supplied string; a hostile body must not become a log line of its own. */
function bounded(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text
}

/**
 * Remove anything that looks like a credential from text a provider sent back.
 *
 * A provider error body is echoed to a user through a notice, and gateways routinely
 * quote the offending header — the request's own key included — in that body.
 *
 * @param text - Provider-supplied text.
 * @returns The same text with credential-shaped substrings replaced.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '<redacted>')
    .replace(/\b(?:sk|sk-ant|sk-proj|xai|gsk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/g, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
}

/**
 * Classify one provider HTTP failure.
 *
 * @param status - HTTP status of the failed response.
 * @param body - Response body text.
 * @param headers - Response headers, read for `retry-after` and a request id.
 * @returns A typed failure whose code selects the harness's retry policy.
 */
export function classifyHttpFailure(status: number, body: string, headers?: Headers): LlmError {
  const { detail, message } = providerErrorDetail(body)
  const facts = responseFacts(headers)
  const text = message ?? `provider request failed with HTTP ${status}${detail === '' ? '' : `: ${detail}`}`
  return new LlmError(`HTTP ${status}: ${text}`, classifyCode(status, detail), { status, ...facts })
}

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
export function classifyInBandFailure(payload: unknown): LlmError {
  const { detail, message } = providerErrorDetail(stringify(payload))
  return new LlmError(`stream error: ${message ?? (detail === '' ? 'provider reported an error' : detail)}`, classifyCode(undefined, detail))
}

/** Render one already-decoded provider event back to text for the shared classifier. */
function stringify(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? ''
  } catch (_unserializableProviderEvent) {
    return ''
  }
}

/** Read the retry delay and request id a provider returned. */
function responseFacts(headers: Headers | undefined): Pick<LlmErrorOptions, 'providerRetryAfterMs' | 'requestId'> {
  if (headers === undefined) return {}
  const retryAfter = headers.get('retry-after')
  const delay = retryAfter === null ? undefined : retryDelayMs(retryAfter)
  const requestId =
    headers.get('request-id') ?? headers.get('x-request-id') ?? headers.get('x-grok-request-id') ?? undefined
  return {
    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
    ...requestId === null || requestId === '' || requestId === undefined ? {} : { requestId },
  }
}

/**
 * Read a `Retry-After` value in either RFC 9110 form.
 *
 * @param raw - The header value, verbatim.
 * @returns The delay in milliseconds, or `undefined` when it is not a usable value.
 */
function retryDelayMs(raw: string): number | undefined {
  const value = raw.trim()
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const seconds = Number(value) * 1000
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
  }
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  const delay = at - Date.now()
  return delay > 0 ? delay : undefined
}

/** Wording that identifies an exhausted account quota rather than a request-rate limit. */
const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient[\s_-]+(?:quota|balance|credits?)/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)/i,
  /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)/i,
]

/** Wording that identifies a request exceeding the model's context window. */
const CONTEXT_PATTERNS: readonly RegExp[] = [
  /\bcontext[\s_-](?:length|window)[\s_-](?:exceed|overflow|limit)/i,
  /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i,
  /\b(?:request|prompt|input|messages?)\b.{0,40}too\s+(?:large|long)\b/i,
  /\bexceed(?:s|ed)?\b.{0,40}\bcontext\s+(?:length|window)\b/i,
]

/** Wording that identifies a rate limit on a body that carries no `429`. */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate[\s_-]?limit/i,
  /too[\s_-]+many[\s_-]+requests/i,
]

/** Wording that identifies an authentication or authorization failure. */
const AUTH_PATTERNS: readonly RegExp[] = [
  /authentication_error/i,
  /permission_error/i,
  /invalid[\s_-]+api[\s_-]?key/i,
  /unauthoriz/i,
  /no[\s_-]+api[\s_-]?key/i,
]

/** Wording that identifies an overloaded or internally failing provider. */
const SERVER_PATTERNS: readonly RegExp[] = [
  /api_error/i,
  /overloaded/i,
  /internal[\s_-]?error/i,
  /service[\s_-]?unavailable/i,
]

/**
 * Map an HTTP status and provider wording onto one stable code.
 *
 * @param status - HTTP status, or `undefined` for an in-band error.
 * @param detail - Combined provider `type`/`code`/`message` text.
 * @returns The code the harness's retry policy and consumers route on.
 */
function classifyCode(status: number | undefined, detail: string): string {
  if (status === 401 || status === 403 || AUTH_PATTERNS.some(pattern => pattern.test(detail))) return AUTH_CODE
  if (status === 402 || QUOTA_PATTERNS.some(pattern => pattern.test(detail))) return QUOTA_CODE
  if (status === 429 || RATE_LIMIT_PATTERNS.some(pattern => pattern.test(detail))) return RATE_LIMIT_CODE
  if (CONTEXT_PATTERNS.some(pattern => pattern.test(detail))) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status === 408) return TIMEOUT_CODE
  if (status === 400 || status === 404 || status === 413 || status === 422
    || /invalid_request_error/i.test(detail)) return INVALID_REQUEST_CODE
  if ((status !== undefined && status >= 500) || SERVER_PATTERNS.some(pattern => pattern.test(detail))) return SERVER_CODE
  return status === undefined ? SERVER_CODE : `HTTP_${status}`
}

/**
 * Classify a transport-level failure that never produced a response.
 *
 * @param error - The caught value from `fetch` or from reading the response body.
 * @param signal - The caller's cancellation signal; an aborted caller owns the outcome.
 * @returns A typed failure: `ABORTED` for caller cancellation, otherwise `TRANSPORT`.
 */
export function classifyTransportFailure(error: unknown, signal?: AbortSignal): LlmError {
  if (signal?.aborted === true) {
    return new LlmError('the model request was aborted by the caller', ABORTED_CODE, { cause: error })
  }
  const text = error instanceof Error ? error.message : String(error)
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) {
    return new LlmError(`the model request timed out: ${redact(text)}`, TIMEOUT_CODE, { cause: error })
  }
  return new LlmError(`the model request failed: ${redact(text)}`, TRANSPORT_CODE, { cause: error })
}
