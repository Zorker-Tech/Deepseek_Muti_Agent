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
import { readFileSync } from 'node:fs';
/** Version used when the manifest cannot be read; a request must never fail over attribution. */
const FALLBACK_VERSION = '0.0.0';
/**
 * The product token this plugin sends.
 *
 * The identity section of `User-Agent` names the requested version here; the version is
 * read from the nearest manifest at runtime, so it cannot drift from what is shipped.
 */
export const APP_IDENTITY = {
    product: 'muti-agent',
    version: readManifestVersion(),
    url: 'https://github.com/Zorker-Tech/Deepseek_Muti_Agent',
};
/**
 * Read this package's version out of the manifest published beside its built entry.
 *
 * The relative path resolves from `src/` in development and from the bundled entry the
 * host loads in production; both land on the manifest whose `version` is the release
 * version. A missing or unreadable manifest degrades to {@link FALLBACK_VERSION} rather
 * than failing a model call.
 *
 * @returns The manifest version, or the fallback when it cannot be read.
 */
function readManifestVersion() {
    try {
        const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) {
            const version = parsed.version;
            if (typeof version === 'string' && version !== '')
                return version;
        }
    }
    catch (_unreadableManifest) {
        // Attribution must never be the reason a request fails.
    }
    return FALLBACK_VERSION;
}
/**
 * The standard `User-Agent` value: `product/version (+url)`, the RFC 9110 product and
 * comment form.
 *
 * @param identity - Identity to render; defaults to {@link APP_IDENTITY}.
 * @returns The ready-to-send header value.
 */
export function userAgent(identity = APP_IDENTITY) {
    return `${identity.product}/${identity.version} (+${identity.url})`;
}
/**
 * Build the attribution headers every provider request must carry.
 *
 * @param identity - Identity to send; defaults to {@link APP_IDENTITY}, so omission
 *   cannot suppress attribution.
 * @returns Headers to merge into a provider request, with lowercase field names.
 */
export function attributionHeaders(identity = APP_IDENTITY) {
    return { 'user-agent': userAgent(identity) };
}
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
export function mergedHeaders(declared, identity = APP_IDENTITY) {
    const attribution = attributionHeaders(identity);
    const reserved = new Set(Object.keys(attribution));
    const kept = {};
    for (const [name, value] of Object.entries(declared ?? {})) {
        if (!reserved.has(name.toLowerCase()))
            kept[name] = value;
    }
    return { ...kept, ...attribution };
}
//# sourceMappingURL=attribution.js.map