/**
 * Non-secret product identity every provider request carries (the harness's app
 * attribution rule).
 *
 * The harness requires each provider request to identify the app as `User-Agent`; nothing
 * may suppress it, and a deployment that needs a white-label identity passes its own
 * {@link AppIdentity}. This plugin cannot import the harness's `attributionHeaders()`
 * (ADR-0006 keeps every harness import behind a probed seam), so the same header is built
 * here from this product's own manifest: a public product token, its version and its home
 * URL — no secrets, local paths, session ids, prompt text or per-user identifiers, and
 * nothing per-request influences the value.
 *
 * @module @zorker/muti-agent-llm-bridge/attribution
 */
/** Static public application identity sent to LLM providers. */
export interface AppIdentity {
    /** `User-Agent` product token (lowercase, hyphenated). */
    product: string;
    /** Product version. */
    version: string;
    /** Repository home URL of the app, rendered as the `User-Agent` comment. */
    url: string;
}
/**
 * The product token this plugin sends.
 *
 * The identity section of `User-Agent` names the requested version here; the version is
 * read from the nearest manifest at runtime, so it cannot drift from what is shipped.
 */
export declare const APP_IDENTITY: AppIdentity;
/**
 * The standard `User-Agent` value: `product/version (+url)`, the RFC 9110 product and
 * comment form.
 *
 * @param identity - Identity to render; defaults to {@link APP_IDENTITY}.
 * @returns The ready-to-send header value.
 */
export declare function userAgent(identity?: AppIdentity): string;
/**
 * Build the attribution headers every provider request must carry.
 *
 * @param identity - Identity to send; defaults to {@link APP_IDENTITY}, so omission
 *   cannot suppress attribution.
 * @returns Headers to merge into a provider request, with lowercase field names.
 */
export declare function attributionHeaders(identity?: AppIdentity): Record<string, string>;
/**
 * Merge one route's declared headers under the attribution headers.
 *
 * A deployment's header list is deployment-owned, and attribution names are harness-owned,
 * so a declared `user-agent` loses the collision instead of suppressing attribution.
 *
 * @param declared - Headers the route's configuration declares, when any.
 * @param identity - Identity to send; defaults to {@link APP_IDENTITY}.
 * @returns The merged header set.
 */
export declare function mergedHeaders(declared: Readonly<Record<string, string>> | undefined, identity?: AppIdentity): Record<string, string>;
//# sourceMappingURL=attribution.d.ts.map