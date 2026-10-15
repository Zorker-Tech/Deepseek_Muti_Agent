/**
 * The harness LLM seam in minimal structural form (ADR-0006).
 *
 * This plugin never imports a harness package, so the vocabulary an adapter must speak
 * is declared here, field for field, exactly as `@deepseek-ai/dsh-llm` declares it. The
 * harness dispatches through a registered adapter's methods, so a structural object with
 * these members is what it receives; nothing here is a re-implementation of harness
 * behaviour, only the shape of the seam crossed at runtime.
 *
 * Every doc comment that states a *rule* (what a delta means, when usage may be emitted)
 * is the adapter contract, not a restatement of the field: an adapter that violates one
 * produces chunks the harness's `BlockAssembler` and agent loop cannot consume.
 *
 * @module @zorker/muti-agent-llm-bridge/contract
 */
declare const brand: unique symbol;
/**
 * A nominal wrapper around a primitive identity.
 *
 * @typeParam B - Discriminant label distinguishing brands of the same primitive.
 */
export type Branded<B extends string> = string & {
    readonly [brand]: B;
};
/** Correlates a model-issued tool call with the tool result that answers it. */
export type ToolCallId = Branded<'ToolCallId'>;
/**
 * Brand a provider-issued tool-call id.
 *
 * @param value - The id as the provider sent it; possibly empty when the provider
 *   has not yet sent one in the same stream.
 * @returns The same value, branded.
 */
export declare function toolCallId(value: string): ToolCallId;
/** Adapter-owned identifier for one selectable reasoning effort. */
export type ReasoningEffortId = Branded<'ReasoningEffortId'>;
/**
 * Brand an adapter-owned reasoning-effort identifier.
 *
 * @param value - The opaque effort identifier this adapter accepts.
 * @returns The same value, branded.
 */
export declare function reasoningEffortId(value: string): ReasoningEffortId;
/** Provider-issued request identifier retained for diagnostics. */
export type ProviderRequestId = Branded<'ProviderRequestId'>;
/**
 * Brand a provider-issued request identifier.
 *
 * @param value - The opaque provider-issued string.
 * @returns The same value, branded.
 */
export declare function providerRequestId(value: string): ProviderRequestId;
/** Serializable provider or transport failure facts. */
export interface LlmFailure {
    /** Human-readable provider or transport failure. */
    readonly message: string;
    /** Stable provider-neutral machine-routing code. */
    readonly code: string;
    /** HTTP status returned by the provider, when available. */
    readonly status?: number;
    /** Provider-requested delay in milliseconds, when valid and available. */
    readonly providerRetryAfterMs?: number;
    /** Opaque provider-issued request identifier for diagnostics. */
    readonly requestId?: ProviderRequestId;
}
/**
 * Token accounting for one model call. Counts are DISJOINT: `inputTokens` excludes
 * cached input, which is reported separately, because the harness prices billed input as
 * the sum of all three.
 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    /** Exact full-call total when the provider reports one. */
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
/** Accepted request modality; absent means unknown, an explicit omission is negative capability. */
export type ModelModality = 'text' | 'image';
/** Provider-owned context capacity for one exact route. */
export interface LlmModelContext {
    contextWindow: number;
}
/** Display metadata for one adapter-owned reasoning effort. */
export interface LlmReasoningEffortInfo {
    id: ReasoningEffortId;
    name: string;
    description?: string;
}
/** Selectable reasoning efforts for one exact route; the list is least to greatest. */
export interface LlmModelReasoningInfo {
    efforts: readonly LlmReasoningEffortInfo[];
    /** Effort materialized when a caller omits one; absence preserves the provider's own default. */
    defaultEffort?: ReasoningEffortId;
}
/** How a model applies a system prompt that changes mid-conversation. */
export type SystemPromptUpdate = 'in-history';
/** How a model accepts tool declarations that change mid-conversation. */
export type ToolUpdate = 'in-history' | 'addition-only';
/** One model an adapter advertises for one of its own provider routes. */
export interface LlmModelInfo {
    /** Provider route that owns this model entry; must equal the route it was listed under. */
    provider: string;
    id: string;
    name: string;
    description?: string;
    inputModalities?: readonly ModelModality[];
}
/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: LlmModelContext;
    /** Per-request output cap materialized when callers omit one. */
    defaultMaxTokens?: number;
    reasoning?: LlmModelReasoningInfo;
    systemPromptUpdate?: SystemPromptUpdate;
    toolUpdate?: ToolUpdate;
}
/** Display metadata for one registered provider route. */
export interface LlmProviderInfo {
    /** Provider route key a request names in `GenerateOptions.provider`. */
    id: string;
    /** Human-readable provider name for selectors and diagnostics. */
    name: string;
}
/** Authentication a provider route performs without a credential reference in its profile. */
export interface LlmNativeAuth {
    /** Environment variables the route's authentication reads, in lookup order. */
    env: readonly string[];
    /** Whether a stored sign-in can authenticate the route. */
    oauth: boolean;
}
/** One provider route a plugin can activate through configuration, live or dormant. */
export interface LlmConfigurableProvider {
    /** Provider route key this entry activates. */
    provider: string;
    /** Human-readable provider name for configuration surfaces. */
    displayName: string;
    /** User-settings namespace whose section configures this provider. */
    settingsNs: string;
    /** Path from that namespace's section root to this provider's profile object. */
    settingsPath: readonly string[];
    /** Whether the route is known only because configuration declared it. */
    declared?: boolean;
    /** Endpoint used when the profile sets no base URL. */
    defaultBaseURL?: string;
    /** Environment variables used to construct the endpoint, when any are reported. */
    baseURLEnv?: readonly string[];
    /** Authentication performed when the profile names no credential reference. */
    nativeAuth?: LlmNativeAuth;
    /** Configuration diagnostic for repair; unaffected models may remain serviceable. */
    error?: string;
}
/** JSON-schema description of a tool, as sent to the model. */
export interface ToolSchema {
    name: string;
    description: string;
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>;
}
/** Plain text visible to the end user. */
export interface TextBlock {
    type: 'text';
    text: string;
}
/** Reasoning content, distinct from visible text. */
export interface ReasoningBlock {
    type: 'reasoning';
    text: string;
}
/** A tool invocation requested by the model. */
export interface ToolCallBlock {
    type: 'tool-call';
    id: ToolCallId;
    name: string;
    /** Raw JSON string as produced by the model, never a parsed object. */
    arguments: string;
}
/** A content block this bridge can both produce and serialize. */
export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock;
/** Where a model response stopped. */
export type FinishReason = {
    kind: 'stop';
} | {
    kind: 'tool-calls';
} | {
    kind: 'max-tokens';
} | {
    kind: 'aborted';
    failure: LlmFailure;
} | {
    kind: 'error';
    failure: LlmFailure;
};
/**
 * One message of a request. Identity and source are deliberately absent: a provider
 * request carries only the role and the model-facing content.
 */
export interface RequestMessage {
    readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
    readonly content: readonly ContentBlock[];
    /** Provider-issued id of the tool call a `tool` message answers. */
    readonly toolCallId?: ToolCallId;
    /** Whether the tool invocation a `tool` message answers failed. */
    readonly isError?: boolean;
}
/** A single model request, fully assembled by the harness. */
export interface GenerateOptions {
    /** Registered provider route selecting the adapter instance. */
    provider: string;
    model: string;
    /** Adapter-owned reasoning effort selected for this exact model. */
    reasoningEffort?: ReasoningEffortId;
    messages: readonly RequestMessage[];
    /** System prompt text for one-shot callers; a loop-built request carries it as a message. */
    system?: string;
    tools?: readonly ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    /** Generation halts as soon as the model produces any one of these strings. */
    stop?: readonly string[];
    /** Caller cancellation; implementations must settle promptly once it aborts. */
    signal?: AbortSignal;
    /** Session identity stamped by the loop for request routing. */
    sessionId?: string;
}
/**
 * Raw streaming protocol emitted by adapters. Block indexes correlate interleaved
 * deltas and `block-end` carries the assembled block. Usage is emitted before the
 * terminal finish and nothing follows it; tool arguments stay raw JSON strings.
 */
export type StreamChunk = {
    type: 'block-start';
    index: number;
    blockType: ContentBlock['type'];
} | {
    type: 'text-delta';
    index: number;
    text: string;
} | {
    type: 'reasoning-delta';
    index: number;
    text: string;
} | {
    type: 'tool-call-delta';
    index: number;
    id: ToolCallId;
    name?: string;
    argumentsDelta: string;
} | {
    type: 'block-end';
    index: number;
    block: ContentBlock;
} | {
    type: 'usage';
    usage: TokenUsage;
} | {
    type: 'finish';
    reason: FinishReason;
};
/**
 * The fields of a durable image reference an image request projection resolves.
 *
 * Declared structurally because the attachment reference is another package's type and
 * nothing here reads more than these three numbers.
 */
export interface ImageRequestShape {
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
}
/** The dimensions and byte target an adapter sends for one image. */
export interface ImageRequestTargetShape {
    readonly width: number;
    readonly height: number;
    readonly maxBytes: number;
}
/** One adapter-owned model-resolution generation bound to its eventual stream call. */
export interface PreparedAdapterCall {
    /** Exact model metadata from the same adapter generation as {@link stream}. */
    readonly model: LlmResolvedModelInfo;
    /**
     * Dispatch through that generation without re-reading dynamic connection facts.
     *
     * @param options - The fully-assembled request.
     * @returns The chunk stream.
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * Provider-wire adapter for the harness message and stream vocabulary.
 *
 * `stream()` is the only member an implementation must provide; every other member exists
 * because the harness *calls* it on a registered adapter — a missing one is a `TypeError` at
 * dispatch time, not a degraded feature — so each has the same default the harness's own
 * abstract class gives it.
 */
export declare abstract class LlmAdapter {
    /**
     * Describe one provider route owned by this adapter.
     *
     * @param provider - A route this adapter was registered for.
     * @returns Display metadata whose `id` must equal the route.
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * Return the provider-owned retry policy captured with this route.
     *
     * @param _provider - A route this adapter was registered for.
     * @returns `undefined` to use the harness's normal retry defaults.
     */
    providerRetryPolicy(_provider: string): undefined;
    /**
     * Resolve provider-side request-image pricing for one exact model route.
     *
     * @param _provider - Registered provider route.
     * @param _model - Exact model id.
     * @returns `undefined`: these routes declare none, so consumers use their own estimate.
     */
    imageRequestPricing(_provider: string, _model: string): undefined;
    /**
     * Resolve the image dimensions and byte target this adapter sends.
     *
     * @param _provider - Registered provider route.
     * @param _model - Exact model id.
     * @param image - Normalized image whose request projection is being resolved.
     * @returns The image unchanged: these adapters never resize.
     */
    imageRequestTarget(_provider: string, _model: string, image: ImageRequestShape): ImageRequestTargetShape;
    /**
     * List models this adapter advertises for one owned route.
     *
     * @param _provider - One provider route owned by this adapter.
     * @returns Discoverable models in adapter-preferred order.
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * Resolve all metadata available for one exact model.
     *
     * @param provider - One provider route owned by this adapter.
     * @param model - Exact model id passed to {@link GenerateOptions.model}.
     * @param _signal - Cancellation for this exact-model lookup.
     * @returns Provider/model identity plus any context and reasoning metadata.
     */
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * Bind exact model metadata and the eventual request dispatch to one adapter generation.
     *
     * @param provider - Registered provider route.
     * @param model - Exact model id.
     * @param signal - Cancellation for model resolution.
     * @returns Model metadata and a one-generation stream entry point.
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    /**
     * Stream one model call as raw chunks.
     *
     * @param options - The fully-assembled request; `options.signal` must be honored.
     * @returns The chunk stream, obeying the contract documented on {@link StreamChunk}.
     */
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** The disposer {@link LlmService.registerAdapter} returns, plus an atomic route replacement. */
export interface AdapterRegistrationHandle {
    /** Release every route this registration currently holds. */
    (): void;
    /**
     * Replace this registration's routes with `providers`, keeping the same adapter.
     *
     * @param providers - The complete next route set; an empty array is legal.
     */
    replace(providers: string[]): void;
}
/** The disposer {@link LlmService.registerConfigurableProviders} returns. */
export interface DirectoryRegistrationHandle {
    /** Withdraw every entry this registration currently holds. */
    (): void;
    /**
     * Replace this registration's entries.
     *
     * @param entries - The complete next entry set; an empty array is legal.
     */
    replace(entries: readonly LlmConfigurableProvider[]): void;
}
/**
 * The `llm` service, narrowed to the two registrations an adapter plugin performs.
 * The host obtains it from the live context and hands it over already narrowed.
 */
export interface LlmService {
    /**
     * Register an adapter for the given provider routes.
     *
     * @param providers - Every provider route this adapter should serve; must be non-empty.
     * @param adapter - The adapter that streams calls for those providers.
     * @returns The disposer for those routes, carrying `replace`.
     */
    registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle;
    /**
     * Declare provider routes this plugin can activate, whether or not they are registered.
     *
     * @param entries - Every configurable provider this plugin owns; must be non-empty.
     * @returns The handle that withdraws, and atomically replaces, those entries.
     */
    registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle;
}
export {};
//# sourceMappingURL=contract.d.ts.map