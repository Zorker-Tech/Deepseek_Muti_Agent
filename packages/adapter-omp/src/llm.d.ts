/**
 * The OMP providers `models.yml` declares, registered as harness LLM routes.
 *
 * A route is the user's own declaration, so this module adds no endpoint, no model and no
 * credential of its own: it reads `models.yml` once (through `models.ts`, the same read
 * the catalog SPI uses), registers an adapter for every provider entry whose `api` this
 * bridge can speak, and declares those routes in the harness's configurable-provider
 * directory so the model selector lists them.
 *
 * What is registered, and what is not:
 *
 * - `api: 'openai-completions'` with an absolute http(s) `baseUrl` is routed through
 *   `@zorker/muti-agent-llm-bridge`.
 * - Any other `api` — OMP names a dozen chat transports and several runner apis — a missing
 *   `baseUrl`, or a `!command` `apiKey` refuses that one route and returns a note.
 *   Declaring a route this plugin cannot speak would put a model in the selector that
 *   fails on use, and running the user's command as part of a model call is a decision of
 *   its own.
 * - A model whose own entry declares an `api` or `baseUrl` is not offered, because the
 *   request would go to the provider's endpoint under a protocol the model did not declare.
 *
 * Credential values are resolved per request and never logged, reported or persisted: an
 * exact environment-variable name is read from the host environment, a literal from the
 * file itself, and a miss refuses the request with the variable's name rather than an
 * empty header.
 *
 * @module @zorker/muti-agent-adapter-omp/llm
 */
import type { AgentModel } from '@zorker/muti-agent-contracts';
import type { Logger } from '@zorker/muti-agent-core';
import { LlmAdapter } from '@zorker/muti-agent-llm-bridge';
import type { AppIdentity, FetchLike, LlmService } from '@zorker/muti-agent-llm-bridge';
import type { OmpDeclaredCredential } from './models.ts';
/** Route-key prefix keeping a user-declared OMP provider from shadowing a shipped one. */
export declare const OMP_ROUTE_PREFIX = "omp:";
/** Default settings namespace: the plugin row the harness mounts this adapter under. */
export declare const OMP_LLM_SETTINGS_NS = "muti-agent";
/** One OMP provider route the harness can select and run. */
export interface OmpLlmRoute {
    /** Harness provider route key, e.g. `omp:local-qwen`. */
    provider: string;
    /** OMP's own provider id, verbatim. */
    providerId: string;
    /** Human name for the selector. */
    displayName: string;
    /** Chat-completions endpoint the route sends to. */
    endpoint: string;
    /** Headers the provider entry declares; may carry the gateway's own credential. */
    headers?: Readonly<Record<string, string>>;
    /** How the route authenticates. */
    credential: OmpDeclaredCredential;
    /** Models the configuration declares for this route, as the catalog projected them. */
    models: readonly AgentModel[];
}
/** What the adapter needs: the environment a credential resolves against, and the routes. */
export interface OmpLlmAdapterDeps {
    /** Host environment; exact-name credential values are resolved against it per request. */
    env: NodeJS.ProcessEnv;
    /** The routes this adapter serves, from one configuration read. */
    routes: readonly OmpLlmRoute[];
    /** Attribution identity for provider requests; defaults to this product's own. */
    identity?: AppIdentity;
    /** Injected transport, for tests; defaults to the global `fetch`. */
    fetch?: FetchLike;
}
/** Options for {@link registerOmpLlm}. */
export interface OmpLlmRegistrationOptions {
    /** Host environment credentials and the store layout resolve against. */
    env: NodeJS.ProcessEnv;
    /** OMP's agent directory; defaults to `$PI_CODING_AGENT_DIR`, then `~/.omp/agent`. */
    agentDir?: string;
    /** Directory whose `.omp` project tier is reported; defaults to the process working directory. */
    cwd?: string;
    /** Logger for the read; the returned notes carry the same diagnostics when absent. */
    log?: Logger;
    /** Settings namespace the directory entries are declared under; defaults to `muti-agent`. */
    settingsNs?: string;
    /** Attribution identity for provider requests; defaults to this product's own. */
    identity?: AppIdentity;
    /** Injected transport, for tests; defaults to the global `fetch`. */
    fetch?: FetchLike;
}
/** What one registration produced. */
export interface OmpLlmRegistration {
    /** Release the adapter routes and the directory entries together. */
    dispose(): void;
    /** Provider route keys the harness can now select. */
    readonly providers: readonly string[];
    /** Declared refusals and catalog gaps, phrased for a human; never a credential value. */
    readonly notes: readonly string[];
}
/**
 * The harness route key for one OMP provider id.
 *
 * The prefix is what keeps a user's own provider from shadowing a route the harness ships:
 * a `models.yml` entry named `deepseek` becomes `omp:deepseek`, which no shipped provider
 * claims.
 *
 * @param providerId - OMP's provider id, verbatim.
 * @returns The route key.
 */
export declare function ompRouteKey(providerId: string): string;
/**
 * Resolve one route's credential for a single request.
 *
 * @param credential - The shape `models.yml` declared.
 * @param env - Host environment to resolve an exact variable name against.
 * @param route - Route key, for diagnostics.
 * @returns The credential to send, or nothing when the configuration declares none.
 * @throws LlmError with code `MISSING_CREDENTIAL` when the named variable is unset, and
 *   `UNSUPPORTED_OPTION` for a `!command` reference, which is never executed.
 */
export declare function resolveOmpCredential(credential: OmpDeclaredCredential, env: NodeJS.ProcessEnv, route: string): {
    readonly value: string;
} | undefined;
/**
 * Create the OMP LLM adapter over one configuration read.
 *
 * @param deps - Environment and the routes read from `models.yml`.
 * @returns The adapter, ready to register with the harness.
 */
export declare function createOmpLlmAdapter(deps: OmpLlmAdapterDeps): LlmAdapter;
/**
 * Read OMP's configuration and register the routes the harness can select and run.
 *
 * Both registrations are made from one read, so the model selector lists exactly the models
 * the configuration declares, and the returned disposer releases them together.
 *
 * @param ctx - The harness LLM service, already narrowed by the host.
 * @param options - Environment, agent directory, project directory, logger and namespace.
 * @returns The disposer, the registered route keys, and every declared refusal or gap.
 * @throws Whatever the harness throws for a conflicting route or an invalid entry; the
 *   registration that did succeed is released first.
 */
export declare function registerOmpLlm(ctx: {
    llm: LlmService;
}, options: OmpLlmRegistrationOptions): Promise<OmpLlmRegistration>;
//# sourceMappingURL=llm.d.ts.map