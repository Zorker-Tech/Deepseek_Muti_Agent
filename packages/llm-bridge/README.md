# `@zorker/muti-agent-llm-bridge`

The transport MutiAgent's Pi and Grok Build harness LLM routes share: SSE framing, an
OpenAI-compatible chat-completions caller, the harness stream vocabulary, and provider-failure
classification. Hand-rolled over the global `fetch` — no third-party dependency, in keeping
with the layering rule that `contracts` is the only package every other one may import.

## Why it exists

Two adapters speak the same wire protocol against different endpoints, and the parts that go
subtly wrong are exactly the parts that must not be written twice:

| Module | Responsibility |
|---|---|
| `src/sse.ts` | response bytes → SSE records |
| `src/openai.ts` | request body from `GenerateOptions`, deltas → `StreamChunk` |
| `src/contract.ts` | the harness LLM seam in structural form (ADR-0006) |
| `src/errors.ts` | `LlmError`, and HTTP/in-band failures → the harness's codes |
| `src/attribution.ts` | the `User-Agent` every provider request must carry |

## The harness seam is structural, not imported

The plugin reaches DeepSeek Harness only through probed seams (ADR-0006), so `contract.ts`
declares the vocabulary an adapter must speak — `LlmAdapter`, `StreamChunk`, `GenerateOptions`,
`LlmService`, the registration handles — field for field as `@deepseek-ai/dsh-llm` declares it.
The harness dispatches through a registered adapter's methods, so it receives a structural
object; nothing here re-implements harness behaviour.

`src/index.ts` re-exports the whole surface, and the adapters import it by package name.

## What the transport guarantees

- **The SSE rules a provider relies on.** Multi-line `data` (joined with newlines), `CR`/`LF`/
  `CRLF` terminators split across chunks, comments, a chunk boundary inside a UTF-8 sequence,
  a byte-order mark, and a record is dispatched only when a blank line closes it — a stream cut
  mid-record discards the pending record and reports the truncation.
- **Tool calls are assembled, not passed through.** The first fragment opens the block, the
  provider's call index identifies the call across fragments, and `block-end` carries the
  concatenated raw JSON arguments. A call the provider never gave an id for keeps a synthesized
  one so the tool result can answer it; a call with no name is refused as malformed.
- **`usage` before exactly one `finish`, and nothing after.** Usage is reported at the terminal
  point even when the provider sent it earlier, so the harness contract holds in every ordering.
- **A stream without the provider's terminal signal fails.** `finish_reason` or `[DONE]` settles
  the response; a body that ends without either is `STREAM_CLOSED` (retryable). A body cut after
  the terminal record is accepted, and only the counts that would have followed are missing.
- **Attribution on every request.** `attributionHeaders()` merges last, so a route-declared
  `user-agent` cannot suppress it. The default identity is this product's
  (`muti-agent/<version> (+repo url)`, version read from the manifest at runtime) and a host may
  pass its own.
- **Failure codes the retry policy routes on.** `AUTH` (401/403), `QUOTA` (402/quota wording),
  `RATE_LIMIT` (429/rate-limit wording, with `Retry-After` as `providerRetryAfterMs`),
  `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST` (400/404/413/422), `SERVER` (5xx/api_error),
  `TIMEOUT` (408/timeout wording), `TRANSPORT`, `ABORTED`, and `HTTP_<status>` for anything else.
  Only `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT` and `EMPTY_RESPONSE` are in the harness's
  default retryable set, which is why a permanent failure must not land on one of them.
- **Failures keep their facts across the package boundary.** `LlmError` carries `code` and
  `failure` as own data properties, which is what the harness's `normalizeLlmFailure` reads
  when class identity does not survive (status, retry delay, request id).
- **Nothing logged is a credential.** A provider error body is echoed to a user through a
  notice, and gateways quote the offending header in it, so `redact()` scrubs Bearer/Basic
  values, key-shaped tokens and JWTs before the message is built.

## Choices the harness vocabulary leaves open

- **`reasoningEffort` → OpenAI's `reasoning_effort`**, and only when the route sets
  `supportsReasoningEffort`. A route without it refuses an effort-bearing request
  (`UNSUPPORTED_OPTION`) rather than sending a field its provider never reads. Other dialects
  (`chat_template_kwargs`, thinking budgets) are not implemented.
- **`maxTokens` → `max_tokens`**, the field every OpenAI-compatible server accepts; the newer
  `max_completion_tokens` spelling is not used.
- **Reasoning blocks are not resent.** No OpenAI-compatible request field carries a previous
  turn's thinking, and providers reject one that echoes it back, so a `reasoning` block in a
  request message contributes nothing. A message that reduces to nothing is omitted, because a
  role with no content is invalid on the wire.
- **A non-streaming answer is refused**, not guessed at: an `application/json` response to a
  `stream: true` request is `MALFORMED_RESPONSE`, because inventing the events a provider never
  sent would be the transport's fiction.
- **`content_filter` is a failure**, not a short answer: the visible text is incomplete and
  retrying produces the same filter.
- **`tool_choice` is not sent** — the harness request has no field for it.
- **Usage counts are disjoint**, as the harness requires: `prompt_tokens` minus
  `prompt_tokens_details.cached_tokens` is `inputTokens`, and the cached share is reported as
  `cacheReadTokens`. The provider's `total_tokens` is kept only when it equals
  `prompt_tokens + completion_tokens`.
- **No idle watchdog.** The transport honors `options.signal` and fails a truncated stream, but
  it does not implement the harness's own idle deadline; a host that wants one passes a signal
  it controls.

## Verification

```sh
node --test packages/llm-bridge/tests/stub-provider.test.ts
```

A real HTTP server on loopback emits the bytes a chat-completions endpoint sends — text deltas,
a tool call split across three chunks, a usage record, `[DONE]` — and the test asserts the
entire `StreamChunk` sequence member by member, plus the framing cases above, the code each
failure shape classifies to, cancellation, and the request body built from the harness
vocabulary.

The package has no build step of its own: like every other package here, nothing under `lib/`
is source, and its consumers bundle it (`scripts/build.mjs` for the plugin, esbuild in the
adapters' registration tests).
