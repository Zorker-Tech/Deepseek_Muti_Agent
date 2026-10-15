/**
 * Shared transport for the harness LLM adapters this plugin registers.
 *
 * Two adapters speak the same wire protocol with different routes — Pi's configured
 * `openai-completions` providers, and Grok Build's CLI chat proxy — so the framing, the
 * delta-to-chunk mapping and the failure classification live here once, hand-rolled over
 * `fetch` with no third-party dependency.
 *
 * `contract.ts` is the harness seam in structural form (ADR-0006): the plugin reaches the
 * harness only through probed seams, so the vocabulary a registered adapter must speak is
 * declared here rather than imported from a harness package.
 *
 * @module @zorker/muti-agent-llm-bridge
 */
export { APP_IDENTITY, attributionHeaders, mergedHeaders, userAgent } from './attribution.ts';
export type { AppIdentity } from './attribution.ts';
export { LlmAdapter, providerRequestId, reasoningEffortId, toolCallId, } from './contract.ts';
export type { AdapterRegistrationHandle, Branded, ContentBlock, DirectoryRegistrationHandle, FinishReason, GenerateOptions, ImageRequestShape, ImageRequestTargetShape, LlmConfigurableProvider, LlmFailure, LlmModelContext, LlmModelInfo, LlmModelReasoningInfo, LlmNativeAuth, LlmProviderInfo, LlmReasoningEffortInfo, LlmResolvedModelInfo, LlmService, ModelModality, PreparedAdapterCall, ProviderRequestId, ReasoningEffortId, RequestMessage, StreamChunk, SystemPromptUpdate, TokenUsage, ToolCallBlock, ToolCallId, ToolSchema, ToolUpdate, TextBlock, ReasoningBlock, } from './contract.ts';
export { ABORTED_CODE, AUTH_CODE, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, INVALID_REQUEST_CODE, isLlmError, LlmError, MALFORMED_RESPONSE_CODE, MISSING_CREDENTIAL_CODE, QUOTA_CODE, RATE_LIMIT_CODE, redact, SERVER_CODE, STREAM_CLOSED_CODE, TIMEOUT_CODE, TRANSPORT_CODE, UNKNOWN_MODEL_CODE, UNSUPPORTED_CONTENT_CODE, UNSUPPORTED_OPTION_CODE, classifyHttpFailure, classifyInBandFailure, classifyTransportFailure, } from './errors.ts';
export { readSseFrames } from './sse.ts';
export type { SseFrame, SseReadOptions, SseStreamEnd } from './sse.ts';
export { buildChatBody, decodeChatEvent, mapFinishReason, mapUsage, streamChatCompletions } from './openai.ts';
export type { ChatCompletionsTarget, FetchLike } from './openai.ts';
//# sourceMappingURL=index.d.ts.map