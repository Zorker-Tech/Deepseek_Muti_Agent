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
/**
 * Brand a provider-issued tool-call id.
 *
 * @param value - The id as the provider sent it; possibly empty when the provider
 *   has not yet sent one in the same stream.
 * @returns The same value, branded.
 */
export function toolCallId(value) {
    return value;
}
/**
 * Brand an adapter-owned reasoning-effort identifier.
 *
 * @param value - The opaque effort identifier this adapter accepts.
 * @returns The same value, branded.
 */
export function reasoningEffortId(value) {
    return value;
}
/**
 * Brand a provider-issued request identifier.
 *
 * @param value - The opaque provider-issued string.
 * @returns The same value, branded.
 */
export function providerRequestId(value) {
    return value;
}
/**
 * Provider-wire adapter for the harness message and stream vocabulary.
 *
 * `stream()` is the only member an implementation must provide; every other member exists
 * because the harness *calls* it on a registered adapter — a missing one is a `TypeError` at
 * dispatch time, not a degraded feature — so each has the same default the harness's own
 * abstract class gives it.
 */
export class LlmAdapter {
    /**
     * Describe one provider route owned by this adapter.
     *
     * @param provider - A route this adapter was registered for.
     * @returns Display metadata whose `id` must equal the route.
     */
    providerInfo(provider) {
        return { id: provider, name: provider };
    }
    /**
     * Return the provider-owned retry policy captured with this route.
     *
     * @param _provider - A route this adapter was registered for.
     * @returns `undefined` to use the harness's normal retry defaults.
     */
    providerRetryPolicy(_provider) {
        return undefined;
    }
    /**
     * Resolve provider-side request-image pricing for one exact model route.
     *
     * @param _provider - Registered provider route.
     * @param _model - Exact model id.
     * @returns `undefined`: these routes declare none, so consumers use their own estimate.
     */
    imageRequestPricing(_provider, _model) {
        return undefined;
    }
    /**
     * Resolve the image dimensions and byte target this adapter sends.
     *
     * @param _provider - Registered provider route.
     * @param _model - Exact model id.
     * @param image - Normalized image whose request projection is being resolved.
     * @returns The image unchanged: these adapters never resize.
     */
    imageRequestTarget(_provider, _model, image) {
        return { width: image.width, height: image.height, maxBytes: image.bytes };
    }
    /**
     * List models this adapter advertises for one owned route.
     *
     * @param _provider - One provider route owned by this adapter.
     * @returns Discoverable models in adapter-preferred order.
     */
    listModels(_provider) {
        return Promise.resolve([]);
    }
    /**
     * Resolve all metadata available for one exact model.
     *
     * @param provider - One provider route owned by this adapter.
     * @param model - Exact model id passed to {@link GenerateOptions.model}.
     * @param _signal - Cancellation for this exact-model lookup.
     * @returns Provider/model identity plus any context and reasoning metadata.
     */
    resolveModel(provider, model, _signal) {
        return Promise.resolve({ provider, id: model, name: model });
    }
    /**
     * Bind exact model metadata and the eventual request dispatch to one adapter generation.
     *
     * @param provider - Registered provider route.
     * @param model - Exact model id.
     * @param signal - Cancellation for model resolution.
     * @returns Model metadata and a one-generation stream entry point.
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: options => this.stream(options),
        };
    }
}
//# sourceMappingURL=contract.js.map