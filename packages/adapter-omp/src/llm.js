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
import { agentId } from '@zorker/muti-agent-contracts';
import { FileProbe } from '@zorker/muti-agent-core';
import { LlmAdapter, reasoningEffortId, streamChatCompletions } from '@zorker/muti-agent-llm-bridge';
import { LlmError, MISSING_CREDENTIAL_CODE, UNKNOWN_MODEL_CODE, UNSUPPORTED_OPTION_CODE } from '@zorker/muti-agent-llm-bridge';
import { readOmpModelCatalogWithRoutes } from "./models.js";
/** Route-key prefix keeping a user-declared OMP provider from shadowing a shipped one. */
export const OMP_ROUTE_PREFIX = 'omp:';
/** Default settings namespace: the plugin row the harness mounts this adapter under. */
export const OMP_LLM_SETTINGS_NS = 'muti-agent';
/** The `models.yml` `api` value this bridge speaks. */
const SUPPORTED_API = 'openai-completions';
/** Logger for a read whose diagnostics travel as returned notes instead. */
const SILENT_LOGGER = { debug: () => { }, warn: () => { } };
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
export function ompRouteKey(providerId) {
    return `${OMP_ROUTE_PREFIX}${providerId}`;
}
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
export function resolveOmpCredential(credential, env, route) {
    switch (credential.kind) {
        case 'none':
            // A self-hosted endpoint that authenticates by header or not at all: sending no
            // Authorization is what the configuration says, so the request carries none.
            return undefined;
        case 'literal':
            return { value: credential.value };
        case 'command':
            throw new LlmError(`OMP route "${route}" authenticates with a !command apiKey, which this adapter never executes`, UNSUPPORTED_OPTION_CODE);
        case 'env': {
            const missing = credential.names.filter(name => {
                const value = env[name];
                return value === undefined || value === '';
            });
            if (missing.length > 0) {
                throw new LlmError(`OMP route "${route}" resolves its apiKey from ${missing.map(name => `$${name}`).join(', ')}, ` +
                    `which ${missing.length === 1 ? 'is' : 'are'} not set in this environment`, MISSING_CREDENTIAL_CODE);
            }
            const first = credential.names[0];
            if (first === undefined) {
                throw new LlmError(`OMP route "${route}" declares an empty apiKey reference`, MISSING_CREDENTIAL_CODE);
            }
            const value = env[first];
            /* v8 ignore next -- the filter above already proved every named variable is set */
            if (value === undefined) {
                throw new LlmError(`OMP route "${route}" resolves its apiKey from $${first}, which is not set`, MISSING_CREDENTIAL_CODE);
            }
            return { value };
        }
    }
}
/**
 * Read one header set without the names this adapter sets itself.
 *
 * HTTP field names are case-insensitive, so a declared `Authorization` would otherwise
 * reach the wire as a second value beside the one the route's own credential produces.
 *
 * @param headers - Declared headers, when the entry has any.
 * @param reserved - Lowercase names the caller sets itself.
 * @returns The remaining headers.
 */
function withoutHeaders(headers, reserved) {
    const kept = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        if (!reserved.includes(name.toLowerCase()))
            kept[name] = value;
    }
    return kept;
}
/**
 * The selectable reasoning efforts for one configured model, or none.
 *
 * OMP's own selector treats an absent effort as "send nothing", which is byte-for-byte the
 * request that names no effort at all, so `off` is not offered as a choice — the harness
 * would be showing a control that cannot change the request. A model whose only level is
 * `off` is a non-reasoning model as far as this route can tell.
 *
 * @param model - The configured model.
 * @returns The `reasoning` field, or an empty object when nothing selectable is declared.
 */
function reasoningOf(model) {
    const declared = model.reasoningEfforts;
    if (declared === undefined)
        return {};
    const selectable = declared.filter(level => level !== 'off');
    if (selectable.length === 0)
        return {};
    return {
        reasoning: {
            efforts: selectable.map(level => ({
                id: reasoningEffortId(level),
                name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
            })),
        },
    };
}
/** One OMP route served through the shared chat-completions bridge. */
class OmpLlmAdapter extends LlmAdapter {
    deps;
    /**
     * @param deps - Environment and the routes read from OMP's configuration.
     */
    constructor(deps) {
        super();
        this.deps = deps;
    }
    /**
     * The route for one key, or the not-owned failure.
     *
     * @param provider - Route key from the request.
     * @returns The route.
     */
    routeOf(provider) {
        const route = this.deps.routes.find(candidate => candidate.provider === provider);
        if (route === undefined)
            throw new LlmError(`OMP adapter does not own provider "${provider}"`, 'NO_ADAPTER');
        return route;
    }
    /**
     * Headers for one request: the route's own credential, then the entry's declared ones.
     *
     * @param route - The route.
     * @returns The header set, without attribution (the transport merges that).
     */
    requestHeaders(route) {
        const credential = resolveOmpCredential(route.credential, this.deps.env, route.provider);
        const declared = withoutHeaders(route.headers, ['authorization']);
        return {
            ...declared,
            ...credential === undefined ? {} : { authorization: `Bearer ${credential.value}` },
        };
    }
    providerInfo(provider) {
        const route = this.routeOf(provider);
        return { id: route.provider, name: route.displayName };
    }
    listModels(provider) {
        return Promise.resolve().then(() => {
            const route = this.routeOf(provider);
            try {
                resolveOmpCredential(route.credential, this.deps.env, route.provider);
            }
            catch (error) {
                // A route whose named variable is unset cannot serve a request, so it offers no
                // models until the environment provides one; the directory entry says why.
                if (error instanceof LlmError && error.code === MISSING_CREDENTIAL_CODE)
                    return [];
                throw error;
            }
            return route.models.map(model => ({
                provider: route.provider,
                id: model.id,
                name: model.displayName ?? model.id,
                inputModalities: ['text'],
            }));
        });
    }
    resolveModel(provider, model, _signal) {
        return Promise.resolve().then(() => {
            const route = this.routeOf(provider);
            const configured = route.models.find(candidate => candidate.id === model);
            if (configured === undefined) {
                throw new LlmError(`OMP route "${provider}" has no configured model "${model}"`, UNKNOWN_MODEL_CODE);
            }
            return {
                provider,
                id: model,
                name: configured.displayName ?? model,
                inputModalities: ['text'],
                ...configured.contextWindow === undefined ? {} : { context: { contextWindow: configured.contextWindow } },
                ...reasoningOf(configured),
            };
        });
    }
    stream(options) {
        return this.streamRoute(options);
    }
    /**
     * Dispatch one request to the route's endpoint.
     *
     * @param options - The harness request.
     * @returns The chunk stream from the shared transport.
     */
    async *streamRoute(options) {
        const route = this.routeOf(options.provider);
        const model = route.models.find(candidate => candidate.id === options.model);
        if (model === undefined) {
            // The endpoint may still serve an id the file does not declare, but routing it would
            // be this adapter guessing at a model the configuration never named.
            throw new LlmError(`OMP route "${route.provider}" has no configured model "${options.model}"`, UNKNOWN_MODEL_CODE);
        }
        const target = {
            provider: route.provider,
            endpoint: route.endpoint,
            headers: this.requestHeaders(route),
            wireModel: model.id,
            supportsReasoningEffort: true,
            ...this.deps.identity === undefined ? {} : { identity: this.deps.identity },
            ...this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch },
        };
        yield* streamChatCompletions(options, target);
    }
}
/**
 * Create the OMP LLM adapter over one configuration read.
 *
 * @param deps - Environment and the routes read from `models.yml`.
 * @returns The adapter, ready to register with the harness.
 */
export function createOmpLlmAdapter(deps) {
    return new OmpLlmAdapter(deps);
}
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
export async function registerOmpLlm(ctx, options) {
    const notes = [];
    const read = await readOmpModelCatalogWithRoutes(readContext(options), agentId('omp'), {
        env: options.env,
        ...options.cwd === undefined ? {} : { cwd: options.cwd },
    });
    for (const note of read.catalog.notes)
        notes.push(`${note.field}: ${note.reason}`);
    const routes = [];
    const routeNotes = new Map();
    const catalogModels = new Map();
    for (const model of read.catalog.models) {
        if (model.providerId === undefined)
            continue;
        const existing = catalogModels.get(model.providerId);
        catalogModels.set(model.providerId, existing === undefined ? [model] : [...existing, model]);
    }
    for (const declaration of read.declarations) {
        const decision = routeDecision(declaration);
        if (!decision.ok) {
            notes.push(decision.note);
            continue;
        }
        const declaredModels = catalogModels.get(declaration.providerId) ?? [];
        const offered = declaredModels.filter(model => !declaration.transportOverrides.includes(model.id));
        // A model the catalog dropped is already declared by the catalog's own note about
        // `enabledModels`; only the per-model transport override needs naming here.
        if (declaration.transportOverrides.length > 0) {
            notes.push(`${declaration.providerId}: model(s) ${declaration.transportOverrides.join(', ')} declare their own api or ` +
                'baseUrl, which this route cannot follow, so they are not offered');
        }
        if (offered.length === 0) {
            notes.push(`${declaration.providerId}: this route offers no model — nothing is declared, or every declared model is ` +
                'declared elsewhere or scoped out — so it is registered with an empty catalogue');
        }
        if (displacesAuthorization(declaration)) {
            notes.push(`${declaration.providerId}: models.yml declares an authorization header, which the apiKey the same entry ` +
                'declares replaces on every request');
        }
        const provider = ompRouteKey(declaration.providerId);
        const credentialFailure = credentialNote(declaration, options.env);
        if (credentialFailure !== undefined) {
            notes.push(`${declaration.providerId}: ${credentialFailure}`);
            routeNotes.set(provider, credentialFailure);
        }
        routes.push({
            provider,
            providerId: declaration.providerId,
            displayName: `OMP · ${declaration.providerId}`,
            endpoint: decision.endpoint,
            ...declaration.headers === undefined ? {} : { headers: declaration.headers },
            credential: declaration.credential,
            models: offered,
        });
    }
    if (routes.length === 0) {
        notes.push('no models.yml provider declares api "openai-completions" with an http(s) baseUrl, so nothing was registered');
        return { dispose: () => { }, providers: [], notes };
    }
    const adapter = createOmpLlmAdapter({
        env: options.env,
        routes,
        ...options.identity === undefined ? {} : { identity: options.identity },
        ...options.fetch === undefined ? {} : { fetch: options.fetch },
    });
    const settingsNs = options.settingsNs ?? OMP_LLM_SETTINGS_NS;
    const entries = routes.map(route => ({
        provider: route.provider,
        displayName: route.displayName,
        settingsNs,
        // The profile is OMP's own models.yml entry, not a harness settings section, so the
        // whole declared route is the profile and there is no path within a section.
        settingsPath: [],
        declared: true,
        defaultBaseURL: route.endpoint,
        // A route that authenticates from a named variable says so; a stored `agent.db`
        // credential is reported by authStatus but never used by this route, so `oauth` is false.
        ...route.credential.kind !== 'env'
            ? {}
            : { nativeAuth: { env: route.credential.names, oauth: false } },
        ...routeNotes.get(route.provider) === undefined ? {} : { error: routeNotes.get(route.provider) ?? '' },
    }));
    const directory = ctx.llm.registerConfigurableProviders(entries);
    let registration;
    try {
        registration = ctx.llm.registerAdapter(routes.map(route => route.provider), adapter);
    }
    catch (error) {
        directory();
        throw error;
    }
    return {
        dispose: () => {
            registration?.();
            directory();
        },
        providers: routes.map(route => route.provider),
        notes,
    };
}
/**
 * Decide whether one declaration describes a route this bridge can speak.
 *
 * OMP names a dozen chat transports (`openai-completions`, `openai-responses`,
 * `anthropic-messages`, `google-generative-ai`, `bedrock-converse-stream`, …) plus runner
 * apis; only the one this bridge implements is routed, and every other value is named in
 * the refusal.
 *
 * @param declaration - One `models.yml` provider declaration.
 * @returns The endpoint to send to, or the note explaining why nothing was registered for it.
 */
function routeDecision(declaration) {
    const refuse = (note) => ({ ok: false, note: `${declaration.providerId}: ${note}` });
    if (declaration.api === undefined) {
        return refuse('models.yml declares no api, so the wire protocol is unknown and the route was not registered ' +
            `(declare "api": "${SUPPORTED_API}" to route it through this adapter)`);
    }
    if (declaration.api !== SUPPORTED_API) {
        return refuse(`models.yml declares api "${declaration.api}", which this bridge does not speak, so the route was not ` +
            `registered (only "${SUPPORTED_API}" is routed through it)`);
    }
    const baseUrl = declaration.baseUrl;
    if (baseUrl === undefined) {
        return refuse('models.yml declares no baseUrl, so the route was not registered');
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
        return refuse(`models.yml declares baseUrl "${baseUrl}", which is not an absolute http(s) URL, so the route was not registered`);
    }
    if (declaration.credential.kind === 'command') {
        return refuse("models.yml declares a !command apiKey; running the user's command as part of a model call needs its own " +
            'decision, so the route was not registered');
    }
    return { ok: true, endpoint: chatCompletionsEndpoint(baseUrl) };
}
/**
 * The chat-completions endpoint for one declared base URL.
 *
 * A `models.yml` `baseUrl` is the OpenAI-compatible root (`.../v1`), which is what the
 * protocol appends `/chat/completions` to; a value that already names the operation is used
 * as it stands.
 *
 * @param baseUrl - The declared base URL.
 * @returns The endpoint to POST to.
 */
function chatCompletionsEndpoint(baseUrl) {
    const trimmed = baseUrl.replace(/\/+$/, '');
    return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}
/**
 * Whether a declared header would be replaced by the credential the same entry declares.
 *
 * @param declaration - One provider declaration.
 * @returns Whether an `authorization` header is displaced.
 */
function displacesAuthorization(declaration) {
    if (declaration.credential.kind === 'none' || declaration.credential.kind === 'command')
        return false;
    return Object.keys(declaration.headers ?? {}).some(name => name.toLowerCase() === 'authorization');
}
/**
 * The diagnostic a route carries when its credential does not resolve right now.
 *
 * @param declaration - One provider declaration.
 * @param env - Host environment.
 * @returns The note, or `undefined` when the credential resolves or none is declared.
 */
function credentialNote(declaration, env) {
    const credential = declaration.credential;
    if (credential.kind !== 'env')
        return undefined;
    const missing = credential.names.filter(name => {
        const value = env[name];
        return value === undefined || value === '';
    });
    if (missing.length === 0)
        return undefined;
    return (`the apiKey resolves from ${missing.map(name => `$${name}`).join(', ')}, which ` +
        `${missing.length === 1 ? 'is' : 'are'} not set in this environment, so this route offers no models ` +
        'until the variable is exported to the harness');
}
/**
 * The read context the catalog runs through.
 *
 * A host that registers these routes is not running agent processes, so the runtime config
 * carries the agent directory and nothing else; `log` is only used by reads that report
 * through a logger, and every diagnostic here travels as a returned note instead.
 *
 * @param options - Registration options.
 * @returns A minimal context for the configuration read.
 */
function readContext(options) {
    const config = {
        enabled: true,
        env: {},
        envMode: 'minimal',
        timeoutMs: 0,
        settings: {},
        ...options.agentDir === undefined ? {} : { homeDir: options.agentDir },
    };
    return { log: options.log ?? SILENT_LOGGER, config, files: new FileProbe() };
}
//# sourceMappingURL=llm.js.map