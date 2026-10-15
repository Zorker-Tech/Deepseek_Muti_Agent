/**
 * The Pi providers `models.json` declares, registered as harness LLM routes.
 *
 * A route is the user's own declaration, so this module adds no endpoint, no model and no
 * credential of its own: it reads `models.json` once (through `models.ts`, the same read the
 * catalog SPI uses), registers an adapter for every provider entry whose `api` this bridge
 * can speak, and declares those routes in the harness's configurable-provider directory so
 * the model selector lists them.
 *
 * What is registered, and what is not:
 *
 * - `api: 'openai-completions'` with an absolute http(s) `baseUrl` is routed through
 *   `@zorker/muti-agent-llm-bridge`.
 * - Any other `api`, a missing `baseUrl`, or a `!command` `apiKey` refuses that one route
 *   and returns a note. Declaring a route this plugin cannot speak would put a model in the
 *   selector that fails on use, and running the user's command as part of a model call is a
 *   decision of its own.
 * - A model whose own entry declares an `api` or `baseUrl` is not offered, because the
 *   request would go to the provider's endpoint under a protocol the model did not declare.
 *
 * Credential values are resolved per request and never logged, reported or persisted: a
 * `$NAME` reference is read from the host environment, a literal from the file itself, and
 * a miss refuses the request with the variable's name rather than an empty header.
 *
 * @module @zorker/muti-agent-adapter-pi/llm
 */

import { agentId } from '@zorker/muti-agent-contracts'
import type { AgentModel } from '@zorker/muti-agent-contracts'
import { FileProbe } from '@zorker/muti-agent-core'
import type { AdapterRuntimeConfig, Logger } from '@zorker/muti-agent-core'
import { LlmAdapter, reasoningEffortId, streamChatCompletions } from '@zorker/muti-agent-llm-bridge'
import type {
  AppIdentity,
  ChatCompletionsTarget,
  FetchLike,
  GenerateOptions,
  LlmConfigurableProvider,
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmService,
  StreamChunk,
} from '@zorker/muti-agent-llm-bridge'
import { LlmError, MISSING_CREDENTIAL_CODE, UNKNOWN_MODEL_CODE, UNSUPPORTED_OPTION_CODE } from '@zorker/muti-agent-llm-bridge'
import { readPiModelCatalogWithRoutes } from './models.ts'
import type { PiDeclaredCredential, PiLlmDeclaration } from './models.ts'
import type { PiReadContext } from './sessions.ts'

/** Route-key prefix keeping a user-declared Pi provider from shadowing a shipped one. */
export const PI_ROUTE_PREFIX = 'pi:'

/** Default settings namespace: the plugin row the harness mounts this adapter under. */
export const PI_LLM_SETTINGS_NS = 'muti-agent'

/** The `models.json` `api` value this bridge speaks. */
const SUPPORTED_API = 'openai-completions'

/** Logger for a read whose diagnostics travel as returned notes instead. */
const SILENT_LOGGER: Logger = { debug: () => {}, warn: () => {} }

/** One Pi provider route the harness can select and run. */
export interface PiLlmRoute {
  /** Harness provider route key, e.g. `pi:local-qwen`. */
  provider: string
  /** Pi's own provider id, verbatim. */
  providerId: string
  /** Human name for the selector. */
  displayName: string
  /** Chat-completions endpoint the route sends to. */
  endpoint: string
  /** Headers the provider entry declares; may carry the gateway's own credential. */
  headers?: Readonly<Record<string, string>>
  /** How the route authenticates. */
  credential: PiDeclaredCredential
  /** Models the configuration declares for this route, as the catalog projected them. */
  models: readonly AgentModel[]
}

/** What the adapter needs: the environment a credential resolves against, and the routes. */
export interface PiLlmAdapterDeps {
  /** Host environment; `$NAME` credential references are resolved against it per request. */
  env: NodeJS.ProcessEnv
  /** The routes this adapter serves, from one configuration read. */
  routes: readonly PiLlmRoute[]
  /** Attribution identity for provider requests; defaults to this product's own. */
  identity?: AppIdentity
  /** Injected transport, for tests; defaults to the global `fetch`. */
  fetch?: FetchLike
}

/** Options for {@link registerPiLlm}. */
export interface PiLlmRegistrationOptions {
  /** Host environment credentials and the store layout resolve against. */
  env: NodeJS.ProcessEnv
  /** Pi's agent directory; defaults to `$PI_CODING_AGENT_DIR`, then `~/.pi/agent`. */
  agentDir?: string
  /** Directory whose `.pi` project tier is reported; defaults to the process working directory. */
  cwd?: string
  /** Logger for the read; the returned notes carry the same diagnostics when absent. */
  log?: Logger
  /** Settings namespace the directory entries are declared under; defaults to `muti-agent`. */
  settingsNs?: string
  /** Attribution identity for provider requests; defaults to this product's own. */
  identity?: AppIdentity
  /** Injected transport, for tests; defaults to the global `fetch`. */
  fetch?: FetchLike
}

/** What one registration produced. */
export interface PiLlmRegistration {
  /** Release the adapter routes and the directory entries together. */
  dispose(): void
  /** Provider route keys the harness can now select. */
  readonly providers: readonly string[]
  /** Declared refusals and catalog gaps, phrased for a human; never a credential value. */
  readonly notes: readonly string[]
}

/**
 * The harness route key for one Pi provider id.
 *
 * The prefix is what keeps a user's own provider from shadowing a route the harness ships:
 * a `models.json` entry named `deepseek` becomes `pi:deepseek`, which no shipped provider
 * claims.
 *
 * @param providerId - Pi's provider id, verbatim.
 * @returns The route key.
 */
export function piRouteKey(providerId: string): string {
  return `${PI_ROUTE_PREFIX}${providerId}`
}

/**
 * Resolve one route's credential for a single request.
 *
 * @param credential - The shape `models.json` declared.
 * @param env - Host environment to resolve references against.
 * @param route - Route key, for diagnostics.
 * @returns The credential to send, or nothing when the configuration declares none.
 * @throws LlmError with code `MISSING_CREDENTIAL` when a named variable is unset, and
 *   `UNSUPPORTED_OPTION` for a `!command` reference, which is never executed.
 */
export function resolvePiCredential(
  credential: PiDeclaredCredential,
  env: NodeJS.ProcessEnv,
  route: string,
): { readonly value: string } | undefined {
  switch (credential.kind) {
    case 'none':
      // A self-hosted endpoint that authenticates by header or not at all: sending no
      // Authorization is what the configuration says, so the request carries none.
      return undefined
    case 'literal':
      return { value: credential.value }
    case 'command':
      throw new LlmError(
        `Pi route "${route}" authenticates with a !command apiKey, which this adapter never executes`,
        UNSUPPORTED_OPTION_CODE,
      )
    case 'env': {
      const missing = credential.names.filter(name => {
        const value = env[name]
        return value === undefined || value === ''
      })
      if (missing.length > 0) {
        throw new LlmError(
          `Pi route "${route}" resolves its apiKey from ${missing.map(name => `$${name}`).join(', ')}, ` +
            `which ${missing.length === 1 ? 'is' : 'are'} not set in this environment`,
          MISSING_CREDENTIAL_CODE,
        )
      }
      const first = credential.names[0]
      if (first === undefined) {
        throw new LlmError(`Pi route "${route}" declares an empty apiKey reference`, MISSING_CREDENTIAL_CODE)
      }
      const value = env[first]
      /* v8 ignore next -- the filter above already proved every named variable is set */
      if (value === undefined) {
        throw new LlmError(`Pi route "${route}" resolves its apiKey from $${first}, which is not set`, MISSING_CREDENTIAL_CODE)
      }
      return { value }
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
function withoutHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  reserved: readonly string[],
): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!reserved.includes(name.toLowerCase())) kept[name] = value
  }
  return kept
}

/**
 * The selectable reasoning efforts for one configured model, or none.
 *
 * Pi's `off` level means "send nothing", which is byte-for-byte the request that names no
 * effort at all, so it is not offered as a choice — the harness would be showing a control
 * that cannot change the request. A model whose only level is `off` is a non-reasoning
 * model as far as this route can tell.
 *
 * @param model - The configured model.
 * @returns The `reasoning` field, or an empty object when nothing selectable is declared.
 */
function reasoningOf(model: AgentModel): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  const declared = model.reasoningEfforts
  if (declared === undefined) return {}
  const selectable = declared.filter(level => level !== 'off')
  if (selectable.length === 0) return {}
  return {
    reasoning: {
      efforts: selectable.map(level => ({
        id: reasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
    },
  }
}

/** One Pi route served through the shared chat-completions bridge. */
class PiLlmAdapter extends LlmAdapter {
  private readonly deps: PiLlmAdapterDeps

  /**
   * @param deps - Environment and the routes read from Pi's configuration.
   */
  constructor(deps: PiLlmAdapterDeps) {
    super()
    this.deps = deps
  }

  /**
   * The route for one key, or the not-owned failure.
   *
   * @param provider - Route key from the request.
   * @returns The route.
   */
  private routeOf(provider: string): PiLlmRoute {
    const route = this.deps.routes.find(candidate => candidate.provider === provider)
    if (route === undefined) throw new LlmError(`Pi adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    return route
  }

  /**
   * Headers for one request: the route's own credential, then the entry's declared ones.
   *
   * @param route - The route.
   * @returns The header set, without attribution (the transport merges that).
   */
  private requestHeaders(route: PiLlmRoute): Record<string, string> {
    const credential = resolvePiCredential(route.credential, this.deps.env, route.provider)
    const declared = withoutHeaders(route.headers, ['authorization'])
    return {
      ...declared,
      ...credential === undefined ? {} : { authorization: `Bearer ${credential.value}` },
    }
  }

  override providerInfo(provider: string): { id: string; name: string } {
    const route = this.routeOf(provider)
    return { id: route.provider, name: route.displayName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const route = this.routeOf(provider)
      try {
        resolvePiCredential(route.credential, this.deps.env, route.provider)
      } catch (error: unknown) {
        // A route whose named variable is unset cannot serve a request, so it offers no
        // models until the environment provides one; the directory entry says why.
        if (error instanceof LlmError && error.code === MISSING_CREDENTIAL_CODE) return []
        throw error
      }
      return route.models.map(model => ({
        provider: route.provider,
        id: model.id,
        name: model.displayName ?? model.id,
        inputModalities: ['text'] as const,
      }))
    })
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const route = this.routeOf(provider)
      const configured = route.models.find(candidate => candidate.id === model)
      if (configured === undefined) {
        throw new LlmError(
          `Pi route "${provider}" has no configured model "${model}"`,
          UNKNOWN_MODEL_CODE,
        )
      }
      return {
        provider,
        id: model,
        name: configured.displayName ?? model,
        inputModalities: ['text'] as const,
        ...configured.contextWindow === undefined ? {} : { context: { contextWindow: configured.contextWindow } },
        ...reasoningOf(configured),
      }
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamRoute(options)
  }

  /**
   * Dispatch one request to the route's endpoint.
   *
   * @param options - The harness request.
   * @returns The chunk stream from the shared transport.
   */
  private async * streamRoute(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const route = this.routeOf(options.provider)
    const model = route.models.find(candidate => candidate.id === options.model)
    if (model === undefined) {
      // The endpoint may still serve an id the file does not declare, but routing it would
      // be this adapter guessing at a model the configuration never named.
      throw new LlmError(`Pi route "${route.provider}" has no configured model "${options.model}"`, UNKNOWN_MODEL_CODE)
    }
    const target: ChatCompletionsTarget = {
      provider: route.provider,
      endpoint: route.endpoint,
      headers: this.requestHeaders(route),
      wireModel: model.id,
      supportsReasoningEffort: true,
      ...this.deps.identity === undefined ? {} : { identity: this.deps.identity },
      ...this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch },
    }
    yield* streamChatCompletions(options, target)
  }
}

/**
 * Create the Pi LLM adapter over one configuration read.
 *
 * @param deps - Environment and the routes read from `models.json`.
 * @returns The adapter, ready to register with the harness.
 */
export function createPiLlmAdapter(deps: PiLlmAdapterDeps): LlmAdapter {
  return new PiLlmAdapter(deps)
}

/**
 * Read Pi's configuration and register the routes the harness can select and run.
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
export async function registerPiLlm(
  ctx: { llm: LlmService },
  options: PiLlmRegistrationOptions,
): Promise<PiLlmRegistration> {
  const notes: string[] = []
  const read = await readPiModelCatalogWithRoutes(readContext(options), agentId('pi'), {
    env: options.env,
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
  })
  for (const note of read.catalog.notes) notes.push(`${note.field}: ${note.reason}`)

  const routes: PiLlmRoute[] = []
  const routeNotes = new Map<string, string>()
  const catalogModels = new Map<string, readonly AgentModel[]>()
  for (const model of read.catalog.models) {
    if (model.providerId === undefined) continue
    const existing = catalogModels.get(model.providerId)
    catalogModels.set(model.providerId, existing === undefined ? [model] : [...existing, model])
  }

  for (const declaration of read.declarations) {
    const decision = routeDecision(declaration)
    if (!decision.ok) {
      notes.push(decision.note)
      continue
    }
    const declaredModels = catalogModels.get(declaration.providerId) ?? []
    const offered = declaredModels.filter(model => !declaration.transportOverrides.includes(model.id))
    // A model the catalog dropped is already declared by the catalog's own note about
    // `settings.enabledModels`; only the per-model transport override needs naming here.
    if (declaration.transportOverrides.length > 0) {
      notes.push(
        `${declaration.providerId}: model(s) ${declaration.transportOverrides.join(', ')} declare their own api or ` +
          'baseUrl, which this route cannot follow, so they are not offered',
      )
    }
    if (offered.length === 0) {
      notes.push(
        `${declaration.providerId}: this route offers no model — nothing is declared, or every declared model is ` +
          'declared elsewhere or scoped out — so it is registered with an empty catalogue',
      )
    }
    if (displacesAuthorization(declaration)) {
      notes.push(
        `${declaration.providerId}: models.json declares an authorization header, which the apiKey the same entry ` +
          'declares replaces on every request',
      )
    }
    const provider = piRouteKey(declaration.providerId)
    const credentialFailure = credentialNote(declaration, options.env)
    if (credentialFailure !== undefined) {
      notes.push(`${declaration.providerId}: ${credentialFailure}`)
      routeNotes.set(provider, credentialFailure)
    }
    routes.push({
      provider,
      providerId: declaration.providerId,
      displayName: `Pi · ${declaration.providerId}`,
      endpoint: decision.endpoint,
      ...declaration.headers === undefined ? {} : { headers: declaration.headers },
      credential: declaration.credential,
      models: offered,
    })
  }

  if (routes.length === 0) {
    notes.push('no models.json provider declares api "openai-completions" with an http(s) baseUrl, so nothing was registered')
    return { dispose: () => {}, providers: [], notes }
  }

  const adapter = createPiLlmAdapter({
    env: options.env,
    routes,
    ...options.identity === undefined ? {} : { identity: options.identity },
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
  })
  const settingsNs = options.settingsNs ?? PI_LLM_SETTINGS_NS
  const entries: LlmConfigurableProvider[] = routes.map(route => ({
    provider: route.provider,
    displayName: route.displayName,
    settingsNs,
    // The profile is Pi's own models.json entry, not a harness settings section, so the
    // whole declared route is the profile and there is no path within a section.
    settingsPath: [],
    declared: true,
    defaultBaseURL: route.endpoint,
    // A route that authenticates from a named variable says so; a stored `auth.json`
    // sign-in is reported but never used by this route, so `oauth` is false.
    ...route.credential.kind !== 'env'
      ? {}
      : { nativeAuth: { env: route.credential.names, oauth: false } },
    ...routeNotes.get(route.provider) === undefined ? {} : { error: routeNotes.get(route.provider) ?? '' },
  }))
  const directory = ctx.llm.registerConfigurableProviders(entries)
  let registration: { (): void } | undefined
  try {
    registration = ctx.llm.registerAdapter(routes.map(route => route.provider), adapter)
  } catch (error: unknown) {
    directory()
    throw error
  }
  return {
    dispose: () => {
      registration?.()
      directory()
    },
    providers: routes.map(route => route.provider),
    notes,
  }
}

/** Either the endpoint one declaration routes to, or the reason it is refused. */
type RouteDecision = { ok: true; endpoint: string } | { ok: false; note: string }

/**
 * Decide whether one declaration describes a route this bridge can speak.
 *
 * @param declaration - One `models.json` provider declaration.
 * @returns The endpoint to send to, or the note explaining why nothing was registered for it.
 */
function routeDecision(declaration: PiLlmDeclaration): RouteDecision {
  const refuse = (note: string): RouteDecision => ({ ok: false, note: `${declaration.providerId}: ${note}` })
  if (declaration.api === undefined) {
    return refuse(
      'models.json declares no api, so the wire protocol is unknown and the route was not registered ' +
        `(declare "api": "${SUPPORTED_API}" to route it through this adapter)`,
    )
  }
  if (declaration.api !== SUPPORTED_API) {
    return refuse(
      `models.json declares api "${declaration.api}", which this bridge does not speak, so the route was not ` +
        `registered (only "${SUPPORTED_API}" is routed through it)`,
    )
  }
  const baseUrl = declaration.baseUrl
  if (baseUrl === undefined) {
    return refuse('models.json declares no baseUrl, so the route was not registered')
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return refuse(
      `models.json declares baseUrl "${baseUrl}", which is not an absolute http(s) URL, so the route was not registered`,
    )
  }
  if (declaration.credential.kind === 'command') {
    return refuse(
      "models.json declares a !command apiKey; running the user's command as part of a model call needs its own " +
        'decision, so the route was not registered',
    )
  }
  return { ok: true, endpoint: chatCompletionsEndpoint(baseUrl) }
}

/**
 * The chat-completions endpoint for one declared base URL.
 *
 * A `models.json` `baseUrl` is the OpenAI-compatible root (`.../v1`), which is what the
 * protocol appends `/chat/completions` to; a value that already names the operation is used
 * as it stands.
 *
 * @param baseUrl - The declared base URL.
 * @returns The endpoint to POST to.
 */
function chatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

/**
 * Whether a declared header would be replaced by the credential the same entry declares.
 *
 * @param declaration - One provider declaration.
 * @returns Whether an `authorization` header is displaced.
 */
function displacesAuthorization(declaration: PiLlmDeclaration): boolean {
  if (declaration.credential.kind === 'none' || declaration.credential.kind === 'command') return false
  return Object.keys(declaration.headers ?? {}).some(name => name.toLowerCase() === 'authorization')
}

/**
 * The diagnostic a route carries when its credential does not resolve right now.
 *
 * @param declaration - One provider declaration.
 * @param env - Host environment.
 * @returns The note, or `undefined` when the credential resolves or none is declared.
 */
function credentialNote(declaration: PiLlmDeclaration, env: NodeJS.ProcessEnv): string | undefined {
  const credential = declaration.credential
  if (credential.kind !== 'env') return undefined
  const missing = credential.names.filter(name => {
    const value = env[name]
    return value === undefined || value === ''
  })
  if (missing.length === 0) return undefined
  return (
    `the apiKey resolves from ${missing.map(name => `$${name}`).join(', ')}, which ` +
    `${missing.length === 1 ? 'is' : 'are'} not set in this environment, so this route offers no models ` +
    'until the variable is exported to the harness'
  )
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
function readContext(options: PiLlmRegistrationOptions): PiReadContext {
  const config: AdapterRuntimeConfig = {
    enabled: true,
    env: {},
    envMode: 'minimal',
    timeoutMs: 0,
    settings: {},
    ...options.agentDir === undefined ? {} : { homeDir: options.agentDir },
  }
  return { log: options.log ?? SILENT_LOGGER, config, files: new FileProbe() }
}
