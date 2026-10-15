/**
 * Codex provider routes as runnable DeepSeek Harness model routes.
 *
 * Codex's `config.toml` is the only place a Codex model and endpoint are
 * declared, and this module turns that same configuration into harness-registerable
 * routes: `[model_providers.*]` entries plus the built-in `openai` endpoint become
 * `codex:<provider-id>` routes speaking the Responses wire (`llm-responses.ts`),
 * each advertising exactly the models the configuration names for it, so the
 * harness model selector can offer them and a call can actually run.
 *
 * Route naming is prefixed so a user-declared Codex provider can never shadow a
 * harness route: the harness's own routes (`openai`, `deepseek`, …) and this
 * adapter's (`codex:openai`, `codex:corp-gateway`) live in different namespaces,
 * and the distinct name also lets a request name which stack it wants.
 *
 * Credentials come from the provider entry's `env_key`, or — for a provider entry
 * that requires OpenAI auth, and for the built-in endpoint — from the Codex auth
 * store this adapter already reads. A value is only ever placed in the request's
 * `Authorization` header; nothing here logs, persists or projects one, and every
 * diagnostic names a variable or an action instead.
 *
 * The transport, framing and failure classification are the shared
 * `@zorker/muti-agent-llm-bridge` ones, so the SSE reader, the in-band error
 * classifier and the attribution headers are the same code the Pi and Grok Build
 * routes use rather than a second implementation.
 *
 * @module @zorker/muti-agent-adapter-codex/llm
 */

import { agentId as toAgentId } from '@zorker/muti-agent-contracts'
import type { AgentModel, AgentModelCatalog } from '@zorker/muti-agent-contracts'
import { FileProbe } from '@zorker/muti-agent-core'
import {
  ABORTED_CODE,
  classifyHttpFailure,
  classifyTransportFailure,
  EMPTY_RESPONSE_CODE,
  isLlmError,
  LlmAdapter,
  LlmError,
  MALFORMED_RESPONSE_CODE,
  mergedHeaders,
  MISSING_CREDENTIAL_CODE,
  readSseFrames,
  reasoningEffortId,
} from '@zorker/muti-agent-llm-bridge'
import type {
  AdapterRegistrationHandle,
  AppIdentity,
  FetchLike,
  GenerateOptions,
  LlmConfigurableProvider,
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmService,
  PreparedAdapterCall,
  SseFrame,
  SseStreamEnd,
  StreamChunk,
} from '@zorker/muti-agent-llm-bridge'
import { codexBearerSource } from './llm-credentials.ts'
import type { CodexBearer, CodexBearerSource } from './llm-credentials.ts'
import { RESPONSES_PATH, ResponsesTranslator, responsesRequestBody, streamClosedFailure } from './llm-responses.ts'
import { readCodexModelCatalog } from './models.ts'
import type { CodexConfigFact, CodexProviderAuthFacts } from './models.ts'
import { resolveCodexHome } from './sessions.ts'
import type { CodexHome } from './sessions.ts'

/**
 * Prefix of every route this adapter owns.
 *
 * The harness registry is keyed by route, so an unprefixed `openai` here would
 * collide with a shipped route and registration would fail atomically; the
 * prefix also keeps the origin of a route visible in a selector.
 */
export const CODEX_LLM_ROUTE_PREFIX = 'codex:'

/** Codex's own default endpoint for a ChatGPT-authenticated built-in provider. */
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Codex's own default endpoint for an API-key-authenticated built-in provider. */
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'

/** Default settings namespace: the plugin row the harness mounts this adapter under. */
export const CODEX_LLM_SETTINGS_NS = 'muti-agent'

/** Cap on the error-body text a refused request keeps for its diagnostic. */
const ERROR_BODY_CHARS = 16 * 1024

/** The declared input modalities of every route this adapter owns. */
const TEXT_ONLY: readonly ('text')[] = ['text']

/** The route key one Codex provider id is registered under. */
export function codexLlmRoute(providerId: string): string {
  return `${CODEX_LLM_ROUTE_PREFIX}${providerId}`
}

/** How a route's endpoint is chosen. */
export type CodexEndpoint =
  /** A configured `base_url`. */
  | { readonly kind: 'fixed'; readonly baseURL: string }
  /**
   * The built-in OpenAI endpoint, whose host depends on how the credential
   * authenticates: Codex sends a ChatGPT credential to its own backend and an
   * API key to the public API.
   */
  | { readonly kind: 'openai-default' }

/** Where a route takes its credential from. */
export type CodexCredentialPlan =
  /** The configured `env_key`, read from the environment this adapter was given. */
  | { readonly kind: 'env'; readonly variable: string }
  /** The Codex auth store, for a provider entry that requires OpenAI auth. */
  | { readonly kind: 'codex-auth-store' }
  /** The endpoint authenticates nothing (a local or network-position gateway). */
  | { readonly kind: 'none' }
  /**
   * The entry carries `experimental_bearer_token`: a credential written into
   * configuration, whose value this adapter never reads, leaving the route with
   * nothing it can authenticate with.
   */
  | { readonly kind: 'literal-token-in-config' }

/** One model the configuration names for a route. */
export interface CodexLlmModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly contextWindow?: number
  readonly reasoningEfforts?: readonly string[]
  readonly defaultReasoningEffort?: string
}

/** One routable Codex provider endpoint, with the models configured for it. */
export interface CodexLlmRoute {
  /** Harness provider route key, `codex:<providerId>`. */
  readonly route: string
  /** Codex's own provider id, as `config.toml` writes it. */
  readonly providerId: string
  /** Human-readable name for selectors. */
  readonly displayName: string
  readonly endpoint: CodexEndpoint
  readonly credential: CodexCredentialPlan
  /** Whether this route is Codex's built-in endpoint rather than a configured one. */
  readonly builtin: boolean
  /** Every model the configuration names for this route, in configuration order. */
  readonly models: readonly CodexLlmModel[]
}

/** Everything one registration installs into the adapter. */
export interface CodexLlmPlan {
  readonly routes: readonly CodexLlmRoute[]
  /** Route-level or catalog-level losses worth showing beside a registration. */
  readonly notes: readonly string[]
}

/** Credential source attachable to a plan, resolved per request. */
export interface CodexLlmPlanSource {
  /** Reads the Codex auth store for routes whose credential is `codex-auth-store`. */
  readonly bearer: CodexBearerSource
}

/** Everything {@link readCodexLlmPlan} needs, all of it read-only. */
export interface CodexLlmPlanRead {
  /** Read-only filesystem helpers. */
  readonly files: FileProbe
  /** Resolved Codex home layout. */
  readonly home: CodexHome
  /** Environment consulted for provider credential variables. */
  readonly env: NodeJS.ProcessEnv
  /** Directory whose project layers are read, standing in for Codex's `$PWD`. */
  readonly projectDir?: string
  /** Credential source for auth-store routes. */
  readonly bearer: CodexBearerSource
}

/** One configuration read, projected into routes, plus the credential source. */
export interface CodexLlmPlanResult {
  readonly plan: CodexLlmPlan
  readonly source: CodexLlmPlanSource
}

/** Adapter construction inputs. */
export interface CodexLlmAdapterDeps {
  /** Environment inspected for `env_key` credentials; never logged. */
  readonly env: NodeJS.ProcessEnv
  /** Reads the Codex auth store; omitted makes `requires_openai_auth` routes unusable. */
  readonly bearer?: CodexBearerSource
  /** Attribution identity for provider requests; defaults to this product's own. */
  readonly identity?: AppIdentity
  /** Injected transport, for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike
}

/** Options for {@link registerCodexLlm}. */
export interface CodexLlmRegistrationOptions {
  /** Codex home holding `config.toml` and `auth.json`. */
  readonly homeDir: string
  /** Environment consulted for provider credentials and configuration paths. */
  readonly env: NodeJS.ProcessEnv
  /** Directory whose project layers stand in for Codex's `$PWD`; defaults to the process's. */
  readonly cwd?: string
  /** Settings namespace the directory entries belong to; defaults to `muti-agent`. */
  readonly settingsNs?: string
  /** Attribution identity for provider requests; defaults to this product's own. */
  readonly identity?: AppIdentity
  /** Injected transport, for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike
}

/** What {@link registerCodexLlm} returns: the disposer, plus what it registered. */
export interface CodexLlmRegistration {
  /** Release both registrations. */
  dispose(): void
  /** The provider routes this registration holds, in registration order. */
  readonly providers: readonly string[]
  /** Why a route or a model is absent, for the caller's own diagnostics. */
  readonly notes: readonly string[]
}

/** The credential one request carries, or why the route cannot serve one. */
type CodexRouteCredential =
  | { readonly usable: true; readonly bearer?: CodexBearer }
  | { readonly usable: false; readonly reason: string }

/** What resolving one route's credential reads. */
interface CodexCredentialRead {
  readonly env: NodeJS.ProcessEnv
  readonly bearer?: CodexBearerSource
}

/**
 * Resolve the credential one request carries, or the reason it cannot be served.
 *
 * One function answers this for every consumer — a request that must carry the
 * credential, a model listing that must not advertise what cannot run, and the
 * note a registration shows — so the three cannot disagree. The value is read
 * here and placed in a header by the caller; it is never returned for display.
 *
 * @param route - The route to resolve a credential for.
 * @param read - Environment and auth-store source.
 * @returns The credential, or the reason the route cannot serve a request now.
 */
async function resolveRouteCredential(route: CodexLlmRoute, read: CodexCredentialRead): Promise<CodexRouteCredential> {
  switch (route.credential.kind) {
    case 'none':
      // A self-hosted endpoint that authenticates by its own headers or not at all:
      // sending no Authorization is what the configuration says.
      return { usable: true }
    case 'literal-token-in-config':
      return {
        usable: false,
        reason:
          `[model_providers.${route.providerId}] carries experimental_bearer_token, a literal secret in configuration`
          + ' that MutiAgent never reads; move it to env_key to make this route usable',
      }
    case 'env': {
      const variable = route.credential.variable
      const value = (read.env[variable] ?? '').trim()
      if (value === '') {
        return {
          usable: false,
          reason:
            `[model_providers.${route.providerId}] resolves its credential from ${variable}, which is not set in the`
            + ' environment this adapter was given; export it to make this route usable',
        }
      }
      return { usable: true, bearer: { value, kind: 'api_key' } }
    }
    case 'codex-auth-store': {
      const source = read.bearer
      if (source === undefined) {
        return {
          usable: false,
          reason: `Codex provider "${route.providerId}" requires OpenAI auth, and no Codex auth store was read for it`,
        }
      }
      const stored = await source.read()
      return stored.bearer === undefined
        ? { usable: false, reason: `Codex provider "${route.providerId}" requires OpenAI auth: ${stored.reason}` }
        : { usable: true, bearer: stored.bearer }
    }
  }
}

/**
 * A Codex route table as a harness adapter.
 *
 * One instance owns every route the plan declares. The plan is installed rather
 * than read per call, so the route set a registration was validated against is the
 * route set requests are served from; a configuration change is picked up by
 * disposing the registration and registering again.
 *
 * Every member of the harness's abstract `LlmAdapter` is implemented here,
 * including the ones the bridge's base class already defaults, so the object the
 * harness dispatches through carries the complete seam whatever it is mounted
 * under.
 */
export class CodexLlmAdapter extends LlmAdapter {
  private readonly deps: CodexLlmAdapterDeps

  private plan: CodexLlmPlan | undefined

  /**
   * @param deps - environment, credential source and optional identity/transport.
   */
  constructor(deps: CodexLlmAdapterDeps) {
    super()
    this.deps = deps
  }

  /**
   * Install one configuration read as the routes this adapter serves.
   *
   * @param plan - routes read from Codex's configuration.
   */
  install(plan: CodexLlmPlan): void {
    this.plan = plan
  }

  /** {@inheritDoc LlmAdapter.providerInfo} */
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.routeOf(this.plan, provider).displayName }
  }

  /** No route-owned retry policy: the harness's normal defaults apply. */
  override providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  /** No route-owned request-image pricing: this adapter declares text-only input. */
  override imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** {@inheritDoc LlmAdapter.imageRequestTarget} */
  override imageRequestTarget(
    _provider: string,
    _model: string,
    image: { readonly width: number; readonly height: number; readonly bytes: number },
  ): { readonly width: number; readonly height: number; readonly maxBytes: number } {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /** {@inheritDoc LlmAdapter.listModels} */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.routeOf(this.plan, provider)
    // A route whose credential does not resolve cannot serve a request, so it offers
    // no model until the credential exists; the configurable-provider directory
    // carries the reason, and the value itself is never read out for display.
    const credential = await resolveRouteCredential(route, this.deps)
    if (!credential.usable) return []
    return route.models.map(model => modelInfo(provider, model))
  }

  /** {@inheritDoc LlmAdapter.resolveModel} */
  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => this.describe(this.routeOf(this.plan, provider), provider, model))
  }

  /**
   * {@inheritDoc LlmAdapter.prepareCall}
   *
   * The installed plan is captured here, so a route set swapped between
   * preparation and dispatch cannot combine one configuration's endpoint with
   * another's model metadata.
   */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const plan = this.plan
    const resolved = await this.resolveModel(provider, model, signal)
    return { model: resolved, stream: options => this.run(plan, options) }
  }

  /** {@inheritDoc LlmAdapter.stream} */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.run(this.plan, options)
  }

  /** One route's exact-model metadata, using whatever the configuration declared for it. */
  private describe(route: CodexLlmRoute, provider: string, model: string): LlmResolvedModelInfo {
    const declared = route.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: declared?.name ?? model,
      // The Responses wire accepts images, but this adapter has no attachment
      // access through its seam: declaring text-only input makes the runtime
      // project images to placeholder text before dispatch.
      inputModalities: TEXT_ONLY,
      // A system prompt is carried as a developer input message at its position in
      // the conversation, so a changed prompt can follow the cached history.
      systemPromptUpdate: 'in-history',
      ...declared === undefined ? {} : modelMetadata(declared),
    }
  }

  /** Resolve the route and credential, then stream the Responses events. */
  private async * run(plan: CodexLlmPlan | undefined, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const route = this.routeOf(plan, options.provider)
    const credential = await resolveRouteCredential(route, this.deps)
    if (!credential.usable) throw new LlmError(credential.reason, MISSING_CREDENTIAL_CODE)
    yield* this.dispatch(route, credential.bearer, options)
  }

  /**
   * One HTTP request and its translated event stream.
   *
   * @param route - The route serving this call.
   * @param bearer - The resolved credential, when the route has one.
   * @param options - The fully-assembled request.
   * @returns The harness chunk stream, ending in exactly one `finish`.
   */
  private async * dispatch(
    route: CodexLlmRoute,
    bearer: CodexBearer | undefined,
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk> {
    const body = responsesRequestBody(options)
    const headers: Record<string, string> = {
      ...mergedHeaders(credentialHeaders(bearer), this.deps.identity),
      // Set after the merge: content negotiation is what makes the response an event
      // stream, and a route-declared value cannot be allowed to break the framing.
      accept: 'text/event-stream',
      'content-type': 'application/json',
    }
    const send = this.deps.fetch ?? globalThis.fetch
    let response: Response
    try {
      response = await send(requestUrl(route, bearer), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // A redirect would carry the credential to a host the configuration never
        // named, so the request fails instead of following one.
        redirect: 'error',
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error: unknown) {
      throw classifyTransportFailure(error, options.signal)
    }
    if (!response.ok) {
      throw classifyHttpFailure(response.status, await errorBody(response), response.headers)
    }
    const stream = response.body
    if (stream === null) {
      throw new LlmError(`route "${route.route}" returned no response body`, EMPTY_RESPONSE_CODE)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (/^\s*application\/json\b/iu.test(contentType)) {
      // The endpoint answered a streaming request with one JSON document: it ignored
      // `stream: true`, and guessing at the framing would invent events it never sent.
      throw new LlmError(
        `route "${route.route}" ignored stream: true and answered with ${contentType}`,
        MALFORMED_RESPONSE_CODE,
      )
    }
    yield* translate(route, stream, options)
  }

  /** The route for one key, or the failure naming the route that is missing. */
  private routeOf(plan: CodexLlmPlan | undefined, provider: string): CodexLlmRoute {
    const route = plan?.routes.find(entry => entry.route === provider)
    if (route === undefined) {
      throw new LlmError(`no Codex route is registered for provider "${provider}"`, 'NO_ADAPTER')
    }
    return route
  }
}

/**
 * Turn one response body into harness chunks.
 *
 * The terminal signal is required: a stream that ends before the provider's own
 * terminal event is a transient truncation (`STREAM_CLOSED`), never a short answer,
 * and the translator's stored failure is what a terminal event reported.
 *
 * @param route - The route serving this call, for diagnostics.
 * @param body - The response body bytes.
 * @param options - The request, for its cancellation signal.
 * @returns The chunk stream.
 * @throws LlmError classified from the provider event, the transport, or the
 *   caller's cancellation.
 */
async function* translate(
  route: CodexLlmRoute,
  body: ReadableStream<Uint8Array>,
  options: GenerateOptions,
): AsyncGenerator<StreamChunk> {
  const frames = readSseFrames(body)[Symbol.asyncIterator]()
  const translator = new ResponsesTranslator()
  let end: SseStreamEnd = { truncated: false, tail: '' }
  try {
    while (true) {
      let step: IteratorResult<SseFrame, SseStreamEnd>
      try {
        step = await frames.next()
      } catch (error: unknown) {
        // The framing reader reports its own protocol failures as typed errors, and
        // those keep their code; only a body the caller's abort or the socket killed
        // is classified here, because it surfaces at this call rather than at `fetch`.
        if (isLlmError(error)) throw error
        throw classifyTransportFailure(error, options.signal)
      }
      if (step.done === true) {
        end = step.value
        break
      }
      if (options.signal?.aborted === true) {
        throw new LlmError(`route "${route.route}" request aborted by the caller`, ABORTED_CODE)
      }
      for (const chunk of translator.push(step.value)) yield chunk
      if (translator.terminal) break
    }
  } finally {
    // Leaving early (a terminal event, a failure, or an abandoned consumer) cancels
    // the body, so nothing keeps streaming into a response nobody reads.
    await frames.return({ truncated: false, tail: '' }).catch(() => undefined)
  }
  if (!translator.terminal) throw streamClosedFailure(end.truncated)
  for (const chunk of translator.finish()) yield chunk
}

/** The headers one credential adds; attribution is merged over these. */
function credentialHeaders(bearer: CodexBearer | undefined): Record<string, string> | undefined {
  if (bearer === undefined) return undefined
  return {
    authorization: `Bearer ${bearer.value}`,
    // Codex sends the account id beside a ChatGPT credential; the backend selects
    // the account by it.
    ...bearer.kind === 'chatgpt' && bearer.accountId !== undefined
      ? { 'chatgpt-account-id': bearer.accountId }
      : {},
  }
}

/** The URL one request is posted to: the route's endpoint plus the Responses path. */
function requestUrl(route: CodexLlmRoute, bearer: CodexBearer | undefined): string {
  const base = route.endpoint.kind === 'fixed'
    ? route.endpoint.baseURL
    : bearer?.kind === 'chatgpt' ? CHATGPT_CODEX_BASE_URL : OPENAI_API_BASE_URL
  return `${base.replace(/\/+$/u, '')}/${RESPONSES_PATH}`
}

/**
 * Read a refused request's body into a bounded diagnostic.
 *
 * The HTTP status classifies the failure on its own, so an unreadable body costs
 * nothing; the kept text is bounded because a provider error body is the one place
 * a credential can be echoed back and it is rendered in a notice.
 *
 * @param response - The failed response.
 * @returns The body text, trimmed and bounded.
 */
async function errorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length <= ERROR_BODY_CHARS ? text.trim() : `${text.slice(0, ERROR_BODY_CHARS).trim()}…`
  } catch (_unreadableErrorBody) {
    return ''
  }
}

/** One declared model as catalog metadata. */
function modelInfo(provider: string, model: CodexLlmModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: TEXT_ONLY,
  }
}

/** The capabilities one declared model resolves to. */
function modelMetadata(model: CodexLlmModel): Partial<LlmResolvedModelInfo> {
  const efforts = model.reasoningEfforts ?? []
  const defaultEffort = model.defaultReasoningEffort
  return {
    ...model.description === undefined ? {} : { description: model.description },
    ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
    // A configured default is only materialized when the model itself declares
    // that level; the harness rejects a default outside the advertised set.
    ...efforts.length === 0
      ? {}
      : {
          reasoning: {
            efforts: efforts.map(effort => ({ id: reasoningEffortId(effort), name: effortLabel(effort) })),
            ...defaultEffort === undefined || !efforts.includes(defaultEffort)
              ? {}
              : { defaultEffort: reasoningEffortId(defaultEffort) },
          },
        },
  }
}

/** Readable label for one reasoning-effort id, which is the wire spelling Codex uses. */
function effortLabel(effort: string): string {
  switch (effort) {
    case 'none': return 'None'
    case 'minimal': return 'Minimal'
    case 'low': return 'Low'
    case 'medium': return 'Medium'
    case 'high': return 'High'
    case 'xhigh': return 'Extra high'
    case 'max': return 'Max'
    case 'ultra': return 'Ultra'
    case 'persistent': return 'Persistent'
    default: return effort
  }
}

/**
 * Create a Codex LLM adapter with no routes installed.
 *
 * `registerCodexLlm` installs the configuration read immediately after; the
 * two-step construction exists so the adapter can also be driven directly, which
 * is how the wire behaviour is tested against a stub provider.
 *
 * @param deps - environment, credential source and optional identity/transport.
 * @returns the adapter, holding no routes until {@link CodexLlmAdapter.install} runs.
 */
export function createCodexLlmAdapter(deps: CodexLlmAdapterDeps): CodexLlmAdapter {
  return new CodexLlmAdapter(deps)
}

/**
 * Read Codex's configuration and project it into the plan one registration installs.
 *
 * The read is the same `readCodexModelCatalog` the Models page uses — one parse,
 * one precedence chain, one trust decision — with a fact sink for the provider
 * keys the canonical catalog has no field for (`requires_openai_auth`, a literal
 * bearer token) and for the configured default reasoning effort. Routes come from
 * exactly the reader's `providers` rows; models are attached to the route their
 * own configuration assigns them.
 *
 * @param read - filesystem helpers, home, environment, project directory and credential source.
 * @returns the plan and the source the adapter resolves credentials through.
 */
export async function readCodexLlmPlan(read: CodexLlmPlanRead): Promise<CodexLlmPlanResult> {
  const providerAuth = new Map<string, CodexProviderAuthFacts>()
  let defaultReasoningEffort: string | undefined
  const catalog = await readCodexModelCatalog({
    files: read.files,
    home: read.home,
    agentId: toAgentId('codex'),
    env: read.env,
    ...read.projectDir === undefined ? {} : { projectDir: read.projectDir },
    onFact: (fact: CodexConfigFact) => {
      if (fact.kind === 'provider') {
        providerAuth.set(fact.providerId, {
          requiresOpenAiAuth: fact.requiresOpenAiAuth,
          literalBearerToken: fact.literalBearerToken,
        })
      } else {
        defaultReasoningEffort = fact.reasoningEffort
      }
    },
  })
  return {
    plan: projectPlan(catalog, providerAuth, defaultReasoningEffort),
    source: { bearer: read.bearer },
  }
}

/**
 * Project one catalog read into routes and models.
 *
 * A configured provider becomes a route only when it names a `base_url`: without
 * one there is nothing to post to, and a route that can never serve a request
 * would be a dead control. Every such route is registered even when its credential
 * is currently unusable — the reason travels into the configurable-provider
 * directory, and a user who fixes the credential gets a working route without a
 * restart, because every request resolves its credential then. The built-in
 * `openai` endpoint is the adapter's own route rather than a user declaration, so
 * it is registered only when the configuration names a model for it and the auth
 * store holds a credential, which is its only way to authenticate.
 *
 * @param catalog - the reader's output.
 * @param providerAuth - per-provider auth facts collected during the same read.
 * @param defaultReasoningEffort - the configuration's own default effort, when it sets one.
 * @returns the plan.
 */
export function projectPlan(
  catalog: AgentModelCatalog,
  providerAuth: ReadonlyMap<string, CodexProviderAuthFacts>,
  defaultReasoningEffort: string | undefined,
): CodexLlmPlan {
  const notes: string[] = []
  const drafts: CodexRouteDraft[] = []
  for (const provider of catalog.providers) {
    if (provider.id === 'openai' && provider.source === 'builtin') continue
    if (provider.source !== 'config') {
      // Codex's other built-in providers (lmstudio, ollama, the Bedrock entries)
      // name no endpoint in this configuration, and a model assigned to one of them
      // is reported by the unserved-provider note below.
      continue
    }
    const baseURL = provider.baseUrl
    if (baseURL === undefined) {
      notes.push(`[model_providers.${provider.id}] names no base_url, so it has no endpoint to post to and is not registered`)
      continue
    }
    const facts = providerAuth.get(provider.id)
    const authStore = facts?.requiresOpenAiAuth === true
    const variable = provider.apiKeyEnv
    drafts.push({
      route: codexLlmRoute(provider.id),
      providerId: provider.id,
      displayName: `Codex · ${provider.name ?? provider.id}`,
      endpoint: { kind: 'fixed', baseURL },
      credential: variable !== undefined
        ? { kind: 'env', variable }
        : authStore
          ? { kind: 'codex-auth-store' }
          : facts?.literalBearerToken === true
            ? { kind: 'literal-token-in-config' }
            : { kind: 'none' },
      builtin: false,
    })
  }
  const builtin = catalog.providers.find(provider => provider.id === 'openai' && provider.source === 'builtin')
  const builtinRequested = catalog.models.some(model => ownerOf(model, catalog) === 'openai')
  if (builtin !== undefined && builtinRequested) {
    if (builtin.credentialPresent === true) {
      drafts.push({
        route: codexLlmRoute('openai'),
        providerId: 'openai',
        displayName: 'Codex · OpenAI',
        endpoint: { kind: 'openai-default' },
        credential: { kind: 'codex-auth-store' },
        builtin: true,
      })
    } else {
      notes.push(
        'the built-in openai route is not registered: the Codex auth store holds no credential, and that endpoint'
        + ' authenticates only through it (run `codex login`, or declare a [model_providers.*] entry with an env_key)',
      )
    }
  }
  return { routes: serveModels(catalog, drafts, notes, defaultReasoningEffort), notes }
}

/** One route before the configuration's models are attached to it. */
type CodexRouteDraft = Omit<CodexLlmRoute, 'models'>

/**
 * Attach every configured model to the route its provider assigns it.
 *
 * Only the default model carries the configured `model_provider`, so every other
 * id a layer names — `review_model`, a catalog entry — belongs to that same
 * provider unless the model's own row says otherwise; with no `model_provider`
 * configured they run through the built-in OpenAI provider, exactly as Codex
 * routes them.
 *
 * @param catalog - the reader's output.
 * @param drafts - routes to attach models to, in registration order.
 * @param notes - notes this projection appends to.
 * @param defaultReasoningEffort - the configuration's own default effort, when it sets one.
 * @returns the routes, each carrying the models configured for it.
 */
function serveModels(
  catalog: AgentModelCatalog,
  drafts: readonly CodexRouteDraft[],
  notes: string[],
  defaultReasoningEffort: string | undefined,
): CodexLlmRoute[] {
  const served = new Map(drafts.map(draft => [draft.providerId, draft]))
  const attached = new Map<string, CodexLlmModel[]>()
  const unserved = new Set<string>()
  for (const model of catalog.models) {
    const owner = ownerOf(model, catalog)
    if (!served.has(owner)) {
      // A model whose provider the configuration assigns to a route this adapter
      // does not serve is listed under no route; naming it here keeps the loss
      // visible instead of silently dropping the model.
      unserved.add(owner)
      continue
    }
    const models = attached.get(owner) ?? []
    models.push({
      id: model.id,
      name: model.displayName ?? model.id,
      ...model.isDefault === true ? { description: 'the model this configuration selects by default' } : {},
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts },
      ...defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort },
    })
    attached.set(owner, models)
  }
  if (unserved.size > 0) {
    notes.push(
      `no route serves ${[...unserved].sort().join(', ')}, so the models the configuration assigns to those providers`
      + ' are offered under no route',
    )
  }
  return drafts.map(draft => ({ ...draft, models: attached.get(draft.providerId) ?? [] }))
}

/** The provider a model's own configuration assigns it, or the one it runs with by default. */
function ownerOf(model: AgentModel, catalog: AgentModelCatalog): string {
  const configured = catalog.models.find(entry => entry.isDefault)?.providerId
  return model.providerId ?? configured ?? 'openai'
}

/**
 * Register every Codex provider route the configuration declares.
 *
 * Two registrations are made and released together: the adapter for the routes
 * themselves, and the configurable-provider directory entry for each of them, so a
 * configuration surface can list them with their endpoint, the environment variable
 * their credential comes from, and any reason they cannot serve a request right now.
 *
 * @param ctx - harness context exposing the `llm` service.
 * @param options - home, environment, project directory, settings namespace and transport.
 * @returns the disposer for both registrations, carrying the routes and the notes.
 */
export async function registerCodexLlm(
  ctx: { readonly llm: LlmService },
  options: CodexLlmRegistrationOptions,
): Promise<CodexLlmRegistration> {
  const notes: string[] = []
  const files = new FileProbe()
  const home = await resolveCodexHome(files, options.homeDir)
  const read = await readCodexLlmPlan({
    files,
    home,
    env: options.env,
    bearer: codexBearerSource(files, home),
    ...options.cwd === undefined ? {} : { projectDir: options.cwd },
  })
  for (const note of read.plan.notes) notes.push(note)
  const routes = read.plan.routes
  if (routes.length === 0) {
    notes.push('no Codex provider route can be registered from this configuration, so nothing was registered')
    return { dispose: () => {}, providers: [], notes }
  }
  const adapter = createCodexLlmAdapter({
    env: options.env,
    bearer: read.source.bearer,
    ...options.identity === undefined ? {} : { identity: options.identity },
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
  })
  adapter.install(read.plan)
  const settingsNs = options.settingsNs ?? CODEX_LLM_SETTINGS_NS
  const entries: LlmConfigurableProvider[] = []
  for (const route of routes) {
    const credential = await resolveRouteCredential(route, { env: options.env, bearer: read.source.bearer })
    const unavailable = credential.usable ? undefined : credential.reason
    if (unavailable !== undefined) notes.push(`${route.providerId}: ${unavailable}`)
    entries.push(directoryEntry(route, settingsNs, unavailable))
  }
  const directory = ctx.llm.registerConfigurableProviders(entries)
  let registration: AdapterRegistrationHandle | undefined
  try {
    registration = ctx.llm.registerAdapter(routes.map(route => route.route), adapter)
  } catch (error: unknown) {
    directory()
    throw error
  }
  return {
    dispose: () => {
      // Both handles are idempotent disposers; releasing the adapter first keeps the
      // directory from advertising a route that is already gone.
      registration?.()
      directory()
    },
    providers: routes.map(route => route.route),
    notes,
  }
}

/** The configurable-provider entry one route publishes. */
function directoryEntry(route: CodexLlmRoute, settingsNs: string, unavailable: string | undefined): LlmConfigurableProvider {
  return {
    provider: route.route,
    displayName: route.displayName,
    settingsNs,
    // The path inside Codex's own configuration, so a surface can point a user at
    // the file and key that actually owns this route; the built-in endpoint is not
    // a configuration entry, so it has no path within a section.
    settingsPath: route.builtin ? [] : ['model_providers', route.providerId],
    // The built-in endpoint is the adapter's own route rather than a declaration.
    declared: !route.builtin,
    ...route.endpoint.kind === 'fixed' ? { defaultBaseURL: route.endpoint.baseURL } : {},
    ...nativeAuthOf(route),
    ...unavailable === undefined ? {} : { error: unavailable },
  }
}

/** The authentication one route performs without a credential reference in its profile. */
function nativeAuthOf(route: CodexLlmRoute): Pick<LlmConfigurableProvider, 'nativeAuth'> | Record<string, never> {
  switch (route.credential.kind) {
    case 'env':
      return { nativeAuth: { env: [route.credential.variable], oauth: false } }
    case 'codex-auth-store':
      return { nativeAuth: { env: [], oauth: true } }
    case 'none':
    case 'literal-token-in-config':
      // The route reads no variable and performs no sign-in; a literal token in
      // configuration is reported as the route's error instead.
      return {}
  }
}
