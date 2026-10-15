/**
 * Grok Build's CLI chat proxy, registered as a harness LLM route.
 *
 * Grok keeps no model table on disk: `grok models` asks the endpoint, and the configuration
 * only narrows or extends that list. So this route is the endpoint itself, registered once:
 *
 * - the endpoint is `https://cli-chat-proxy.grok.com/v1` unless the configuration or the
 *   environment overrides it (`[endpoints].cli_chat_proxy_base_url`,
 *   `$GROK_CLI_CHAT_PROXY_BASE_URL`, `[endpoints].xai_api_base_url`, `$GROK_XAI_API_BASE_URL`);
 * - `listModels` returns the `[models].allowed_models` ids the configuration names, else the
 *   default model id it names, and otherwise **nothing** — the endpoint is authoritative and
 *   this plugin makes no discovery request, so offering models it did not read would be a
 *   guess a user cannot correct;
 * - a request for an id the configuration does not name is still dispatched, because the
 *   proxy decides what exists and refusing a hand-built call would be this plugin inventing
 *   a rule the configuration never stated.
 *
 * The credential is a bearer for the proxy: `XAI_API_KEY` when it is set (grok's own
 * documented precedence), else the key a `grok login` wrote to `auth.json`. It is read per
 * request, sent, and never logged, persisted or reported — diagnostics name the variable it
 * came from, never its value.
 *
 * @module @zorker/muti-agent-adapter-grok/llm
 */

import type { AgentModel } from '@zorker/muti-agent-contracts'
import { FileProbe } from '@zorker/muti-agent-core'
import type { Logger } from '@zorker/muti-agent-core'
import { LlmAdapter, reasoningEffortId, streamChatCompletions } from '@zorker/muti-agent-llm-bridge'
import type {
  AppIdentity,
  FetchLike,
  GenerateOptions,
  LlmConfigurableProvider,
  LlmModelInfo,
  LlmResolvedModelInfo,
  LlmService,
  StreamChunk,
} from '@zorker/muti-agent-llm-bridge'
import { LlmError, MISSING_CREDENTIAL_CODE } from '@zorker/muti-agent-llm-bridge'
import { parseGrokAuthStore, selectGrokAuthEntry } from './auth.ts'
import { asRecord } from './events.ts'
import { readGrokModelCatalog } from './models.ts'
import type { GrokLlmFacts } from './models.ts'
import { resolveGrokPaths } from './sessions.ts'

/** Route-key prefix keeping the declared route from shadowing a provider the harness ships. */
export const GROK_ROUTE_PREFIX = 'grok:'

/** The one route this adapter serves: Grok Build's CLI chat proxy. */
export const GROK_CLI_ROUTE = `${GROK_ROUTE_PREFIX}cli-chat-proxy`

/** Default settings namespace: the plugin row the harness mounts this adapter under. */
export const GROK_LLM_SETTINGS_NS = 'muti-agent'

/**
 * Environment variables this route reads the proxy bearer from, in that order.
 *
 * Other variables grok honours (`GROK_AUTH`, `GROK_DEPLOYMENT_KEY`) address its management
 * API rather than this proxy, so they are deliberately not read here.
 */
export const GROK_LLM_CREDENTIAL_ENV_KEYS: readonly string[] = ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']

/** Longest credential store read; a larger file is refused rather than half-parsed. */
const CREDENTIAL_READ_BYTES = 256 * 1024

/** Header telling the proxy which credential kind is being presented. */
const TOKEN_AUTH_HEADER = 'X-XAI-Token-Auth'

/** Its required value for a credential the CLI would present. */
const TOKEN_AUTH_VALUE = 'xai-grok-cli'

/** Logger for a read whose diagnostics travel as returned notes instead. */
const SILENT_LOGGER: Logger = { debug: () => {}, warn: () => {} }

/** One Grok Build route the harness can select and run. */
export interface GrokLlmRoute {
  /** Harness provider route key. */
  provider: string
  /** Human name for the selector. */
  displayName: string
  /** Chat-completions endpoint every request goes to. */
  endpoint: string
  /** Models the configuration names; empty when it names none. */
  models: readonly AgentModel[]
}

/** What the adapter needs: the environment, the route, and where the stored sign-in lives. */
export interface GrokLlmAdapterDeps {
  /** Host environment the proxy bearer is read from. */
  env: NodeJS.ProcessEnv
  /** The route, from one configuration read. */
  route: GrokLlmRoute
  /** `auth.json` holding a stored sign-in; omitted skips the store entirely. */
  credentialPath?: string
  /** Read-only file helpers for the store read; a bounded probe is created when absent. */
  files?: FileProbe
  /** Attribution identity for provider requests; defaults to this product's own. */
  identity?: AppIdentity
  /** Injected transport, for tests; defaults to the global `fetch`. */
  fetch?: FetchLike
}

/** Options for {@link registerGrokLlm}. */
export interface GrokLlmRegistrationOptions {
  /** Host environment: credential variables, endpoint overrides and the store location. */
  env: NodeJS.ProcessEnv
  /** Grok's home directory; defaults to `$GROK_HOME`, then `~/.grok`. */
  homeDir?: string
  /** Directory whose project `.grok/config.toml` tier is reported; defaults to the process cwd. */
  cwd?: string
  /** Logger for the read; the returned notes carry the same diagnostics when absent. */
  log?: Logger
  /** Settings namespace the directory entry is declared under; defaults to `muti-agent`. */
  settingsNs?: string
  /** Attribution identity for provider requests; defaults to this product's own. */
  identity?: AppIdentity
  /** Injected transport, for tests; defaults to the global `fetch`. */
  fetch?: FetchLike
}

/** What one registration produced. */
export interface GrokLlmRegistration {
  /** Release the adapter route and the directory entry together. */
  dispose(): void
  /** Provider route keys the harness can now select. */
  readonly providers: readonly string[]
  /** Declared gaps and the model-list decision, phrased for a human; never a credential value. */
  readonly notes: readonly string[]
}

/** A resolved bearer and where it came from, for diagnostics that never quote the value. */
interface GrokBearer {
  /** The credential to send. */
  value: string
  /** Where it was read from, as a name a user can act on. */
  source: string
  /** Whether the stored sign-in had already expired when it was read. */
  expired: boolean
}

/**
 * Resolve the proxy bearer for one request.
 *
 * @param options - Environment, credential path and file probe.
 * @returns The bearer and its source, or `undefined` when nothing is stored.
 */
export async function readGrokBearer(options: {
  env: NodeJS.ProcessEnv
  credentialPath?: string
  files: FileProbe
}): Promise<GrokBearer | undefined> {
  for (const name of GROK_LLM_CREDENTIAL_ENV_KEYS) {
    const value = options.env[name]
    if (value !== undefined && value.trim() !== '') {
      return { value: value.trim(), source: `$${name}`, expired: false }
    }
  }
  const credentialPath = options.credentialPath
  if (credentialPath === undefined) return undefined
  const read = await options.files.readHead(credentialPath, CREDENTIAL_READ_BYTES)
  if (read.missing || read.truncated) return undefined
  const trimmed = read.text.trim()
  if (trimmed === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (_unparsableCredentialStore) {
    return undefined
  }
  const selected = selectGrokAuthEntry(parseGrokAuthStore(parsed))
  if (selected === undefined) return undefined
  const store = asRecord(parsed)
  const entry = store === undefined ? undefined : asRecord(store[selected.scope])
  const key = entry === undefined ? undefined : entry.key
  if (typeof key !== 'string' || key.trim() === '') return undefined
  return {
    value: key.trim(),
    source: `auth.json (${selected.authMode === '' ? 'unknown mode' : selected.authMode})`,
    expired: selected.expired,
  }
}

/**
 * The selectable reasoning efforts for one declared model, or none.
 *
 * @param model - The declared model.
 * @returns The `reasoning` field, or an empty object when the configuration declares none.
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

/**
 * The chat-completions endpoint for one base URL.
 *
 * @param baseUrl - The proxy base URL in force.
 * @returns The endpoint to POST to.
 */
function chatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

/** Grok Build's CLI chat proxy as a harness route. */
class GrokLlmAdapter extends LlmAdapter {
  private readonly deps: GrokLlmAdapterDeps
  private readonly files: FileProbe

  /**
   * @param deps - Environment, route and store location.
   */
  constructor(deps: GrokLlmAdapterDeps) {
    super()
    this.deps = deps
    this.files = deps.files ?? new FileProbe()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.deps.route.displayName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(
      this.deps.route.provider === provider
        ? this.deps.route.models.map(model => ({
          provider,
          id: model.id,
          name: model.displayName ?? model.id,
          inputModalities: ['text'] as const,
        }))
        : [],
    )
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      // The endpoint decides which ids exist, so any id is described with whatever the
      // configuration knows about it — refusing one would invent a rule the file never stated.
      const declared = this.deps.route.models.find(candidate => candidate.id === model)
      return {
        provider,
        id: model,
        name: declared?.displayName ?? model,
        inputModalities: ['text'] as const,
        ...declared?.contextWindow === undefined ? {} : { context: { contextWindow: declared.contextWindow } },
        ...declared === undefined ? {} : reasoningOf(declared),
      }
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamRoute(options)
  }

  /**
   * Dispatch one request to the proxy.
   *
   * @param options - The harness request.
   * @returns The chunk stream from the shared transport.
   * @throws LlmError with code `MISSING_CREDENTIAL` when no bearer resolves.
   */
  private async * streamRoute(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const bearer = await readGrokBearer({
      env: this.deps.env,
      ...this.deps.credentialPath === undefined ? {} : { credentialPath: this.deps.credentialPath },
      files: this.files,
    })
    if (bearer === undefined) {
      throw new LlmError(
        `Grok route "${this.deps.route.provider}" has no credential: set ${GROK_LLM_CREDENTIAL_ENV_KEYS.join(' or ')} ` +
          'for this process, or sign in with `grok login` so auth.json holds a token',
        MISSING_CREDENTIAL_CODE,
      )
    }
    yield* streamChatCompletions(options, {
      provider: this.deps.route.provider,
      endpoint: this.deps.route.endpoint,
      // The proxy routes by this header rather than by the body's model field, so both
      // carry the requested id and a routing override cannot disagree with the request.
      headers: {
        authorization: `Bearer ${bearer.value}`,
        [TOKEN_AUTH_HEADER]: TOKEN_AUTH_VALUE,
        'x-grok-model-override': options.model,
      },
      wireModel: options.model,
      supportsReasoningEffort: true,
      ...this.deps.identity === undefined ? {} : { identity: this.deps.identity },
      ...this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch },
    })
  }
}

/**
 * Create the Grok LLM adapter over one configuration read.
 *
 * @param deps - Environment, route and credential store location.
 * @returns The adapter, ready to register with the harness.
 */
export function createGrokLlmAdapter(deps: GrokLlmAdapterDeps): LlmAdapter {
  return new GrokLlmAdapter(deps)
}

/**
 * Read grok's configuration and register the CLI chat proxy route.
 *
 * @param ctx - The harness LLM service, already narrowed by the host.
 * @param options - Environment, home directory, project directory, logger and namespace.
 * @returns The disposer, the registered route keys, and every declared gap.
 * @throws Whatever the harness throws for a conflicting route or an invalid entry; the
 *   registration that did succeed is released first.
 */
export async function registerGrokLlm(
  ctx: { llm: LlmService },
  options: GrokLlmRegistrationOptions,
): Promise<GrokLlmRegistration> {
  const notes: string[] = []
  const files = new FileProbe()
  const paths = resolveGrokPaths({
    ...options.homeDir === undefined ? {} : { homeDir: options.homeDir },
    env: options.env,
    files,
  })
  let facts: GrokLlmFacts | undefined
  const catalog = await readGrokModelCatalog({
    files,
    paths,
    hostEnv: options.env,
    cwd: files.resolvePath(options.cwd ?? process.cwd()),
    log: options.log ?? SILENT_LOGGER,
    collect: collected => {
      facts = collected
    },
  })
  for (const note of catalog.notes) notes.push(`${note.field}: ${note.reason}`)
  if (facts === undefined) {
    // The reader always collects before returning; a host that replaced it must not get a
    // half-registered route.
    notes.push('grok configuration produced no endpoint facts, so nothing was registered')
    return { dispose: () => {}, providers: [], notes }
  }

  const endpoint = chatCompletionsEndpoint(facts.chatProxyBaseUrl)
  if (facts.customModelsEndpoint) {
    notes.push(
      'a custom models endpoint ([endpoints].models_base_url or $GROK_MODELS_BASE_URL) is configured; this route still ' +
        `targets the CLI chat proxy at ${endpoint}, because that is the endpoint this adapter speaks`,
    )
  }
  const declaredModels = facts.allowedModelIds.length > 0
    ? facts.allowedModelIds.map(id => modelFor(id, catalog.models))
    : facts.defaultModel === undefined ? [] : [modelFor(facts.defaultModel, catalog.models)]
  if (facts.allowedGlobs.length > 0) {
    notes.push(
      `[models].allowed_models contains picker globs (${facts.allowedGlobs.join(', ')}), which name no model this route ` +
        'can offer',
    )
  }
  if (declaredModels.length === 0) {
    notes.push(
      'grok\'s configuration names no model, so this route offers none: the endpoint is authoritative and this plugin ' +
        'makes no discovery request. Declare [models] default (or allowed_models) to offer a model here, or select an ' +
        'id the endpoint serves by hand.',
    )
  }
  const bearer = await readGrokBearer({
    env: options.env,
    credentialPath: paths.credentialPath,
    files,
  })
  if (bearer === undefined) {
    notes.push(
      `no credential resolves for this route: neither ${GROK_LLM_CREDENTIAL_ENV_KEYS.join(' nor ')} is set, and ` +
        `${paths.credentialPath} holds no usable token. Sign in with \`grok login\` or export the key.`,
    )
  } else if (bearer.expired) {
    notes.push(
      `the stored sign-in in auth.json is past its expiry (tokens last 7 days); run \`grok login\` before using this route`,
    )
  }

  const route: GrokLlmRoute = {
    provider: GROK_CLI_ROUTE,
    displayName: 'Grok Build',
    endpoint,
    models: declaredModels,
  }
  const adapter = createGrokLlmAdapter({
    env: options.env,
    route,
    credentialPath: paths.credentialPath,
    files,
    ...options.identity === undefined ? {} : { identity: options.identity },
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
  })
  const entry: LlmConfigurableProvider = {
    provider: GROK_CLI_ROUTE,
    displayName: route.displayName,
    settingsNs: options.settingsNs ?? GROK_LLM_SETTINGS_NS,
    // The profile is grok's own configuration, not a harness settings section.
    settingsPath: [],
    declared: true,
    defaultBaseURL: endpoint,
    baseURLEnv: ['GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_XAI_API_BASE_URL'],
    nativeAuth: { env: GROK_LLM_CREDENTIAL_ENV_KEYS, oauth: true },
    ...bearer === undefined
      ? { error: `no credential: set ${GROK_LLM_CREDENTIAL_ENV_KEYS[0] ?? 'XAI_API_KEY'} or run \`grok login\`` }
      : {},
  }
  const directory = ctx.llm.registerConfigurableProviders([entry])
  let registration: { (): void } | undefined
  try {
    registration = ctx.llm.registerAdapter([GROK_CLI_ROUTE], adapter)
  } catch (error: unknown) {
    directory()
    throw error
  }
  return {
    dispose: () => {
      registration?.()
      directory()
    },
    providers: [GROK_CLI_ROUTE],
    notes,
  }
}

/**
 * One declared model id with whatever metadata the same configuration read knows.
 *
 * @param id - Model id the configuration names.
 * @param models - The catalog's rows.
 * @returns The model row the route offers.
 */
function modelFor(id: string, models: readonly AgentModel[]): AgentModel {
  const known = models.find(model => model.id === id)
  return known ?? { id, source: 'config' }
}
