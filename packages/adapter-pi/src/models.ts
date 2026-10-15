/**
 * Pi's model and provider catalog, read from Pi's own configuration files.
 *
 * Pi resolves the models a machine can actually run from two JSON files: the agent
 * directory's `models.json` (compatible endpoints, their models, and metadata patches for
 * models Pi ships) and the effective `settings.json` (the saved default model and the
 * enabled-model scope). This module projects those files onto `AgentModelCatalog`
 * (ADR-0002), read-only and credential-blind: a `models.json` `apiKey` is classified by
 * shape (`$NAME` environment reference, literal, or `!command`) and never read into the
 * catalog, and `credentialPresent` comes from whether the referenced variable is set or
 * `auth.json` holds a credential for the provider.
 *
 * What is deliberately not read: Pi's generated built-in catalog (its model list is
 * compiled into Pi and overlaid from pi.dev). It is versioned with Pi itself, it is not a
 * user's configuration, and a catalog built from it would describe Pi rather than this
 * machine. The result is therefore the **configured subset** — exactly what a user's own
 * files change — and every read says so in `notes`.
 *
 * Two facts about the file model shape the code:
 *
 * - `modelOverrides` lives **inside a provider** (Pi's `models.schema.json`), where it
 *   patches the metadata of a model Pi already knows; an override can therefore name a
 *   model this reader cannot enumerate, which is reported as `source: 'catalog'` rather
 *   than invented.
 * - A parse failure is a declared gap, never an error: the reader returns whatever else
 *   was recoverable and names the file and the reason in `sources` and `notes`.
 *
 * @module @zorker/muti-agent-adapter-pi/models
 */

import { dirname } from 'node:path'
import type {
  AgentId,
  AgentModel,
  AgentModelCatalog,
  AgentProvider,
  ModelSource,
  ModelSourceFile,
  ProjectionNote,
} from '@zorker/muti-agent-contracts'
import { readPiCredentials, type PiStoredCredential } from './auth.ts'
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString, resolvePiStore } from './sessions.ts'
import type { PiReadContext } from './sessions.ts'

/** Pi thinking levels, in Pi's own `getSupportedThinkingLevels` order. */
const PI_THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Levels Pi reports only when a model's `thinkingLevelMap` names them explicitly. */
const PI_EXTENDED_THINKING_LEVELS: readonly string[] = ['xhigh', 'max']

/** Provider keys with no canonical field, checked so a configured value is declared, not dropped. */
const UNPROJECTED_PROVIDER_KEYS: readonly string[] = ['headers', 'compat', 'oauth', 'authHeader']

/** Model keys with no canonical field, checked so a configured value is declared, not dropped. */
const UNPROJECTED_MODEL_KEYS: readonly string[] = [
  'api',
  'baseUrl',
  'input',
  'inputLimits',
  'cost',
  'promptCache',
  'maxTokens',
  'samplingParams',
  'samplingParamsByThinkingLevel',
  'headers',
  'compat',
]

/** Environment credential names Pi resolves for well-known providers. Names only. */
const PI_PROVIDER_ENV_BY_ID: Readonly<Record<string, readonly string[]>> = {
  // Pi's own list (`packages/ai/src/env-api-keys.ts`) checks the bearer token first for
  // anthropic because it participates in env discovery; the API key is named first here
  // because that is the variable `apiKeyEnv` means.
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'],
  'ant-ling': ['ANT_LING_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  typesafe: ['TYPESAFE_API_KEY'],
  radius: ['RADIUS_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  meta: ['META_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  // Ambient sources Pi also supports (AWS profiles and IAM keys, Google application
  // default credentials) are deliberately absent, matching Pi's own `findEnvKeys`: they
  // cannot be classified by the presence of one variable.
}

/** The built-in-catalog caveat, present on every catalog this module returns. */
const PI_BUILTIN_CATALOG_NOTE: ProjectionNote = {
  field: 'models',
  reason:
    "Pi's built-in catalog, and the overlay Pi fetches from pi.dev, are deliberately not read: " +
    'this catalog is the configured subset that models.json and settings.json declare, which is ' +
    "what a user's own configuration changes",
}

/** Options for {@link readPiModelCatalog}. */
export interface PiModelCatalogOptions {
  /** Environment credential references are resolved against; defaults to the host's. */
  env?: NodeJS.ProcessEnv
  /** Directory whose `.pi` project tier is read; defaults to the process working directory. */
  cwd?: string
  /** Observation time in milliseconds; injected for testability. */
  now?: number
}


/**
 * How Pi resolves one provider's declared `apiKey` (`resolve-config-value.ts`).
 *
 * The value itself is carried only for a literal, because only that form can be sent
 * without running the user's command or interpolating the environment first.
 */
export type PiDeclaredCredential =
  /** `!command`: Pi runs a shell command. Refused by the LLM route rather than executed. */
  | { kind: 'command' }
  /** No reference: the value itself. */
  | { kind: 'literal'; value: string }
  /** `$NAME`/`${NAME}` references, or the variable Pi's own discovery reads for this provider. */
  | { kind: 'env'; names: readonly string[] }
  /** Nothing declared and no ambient variable Pi is known to read. */
  | { kind: 'none' }

/**
 * One `models.json` provider declaration, projected for the harness LLM bridge.
 *
 * This is the same parse the catalog is built from, projected differently: a route needs
 * the endpoint, the declared headers and the credential shape, which the canonical
 * `AgentProvider` deliberately does not carry (ADR-0002 keeps that schema provider-neutral).
 */
export interface PiLlmDeclaration {
  /** Provider id, verbatim. */
  providerId: string
  /** `api`, verbatim; absent when the entry declares none. */
  api?: string
  /** `baseUrl`, verbatim. */
  baseUrl?: string
  /** Provider-declared request headers. May carry a credential-shaped value; never logged. */
  headers?: Readonly<Record<string, string>>
  credential: PiDeclaredCredential
  /** Model ids this provider's own `models` array declares. */
  modelIds: readonly string[]
  /** Declared models whose own entry overrides `api` or `baseUrl`, which a route cannot honour. */
  transportOverrides: readonly string[]
}

/** One read of Pi's configuration: the canonical catalog, and the LLM routes it declares. */
export interface PiCatalogRead {
  /** What the catalog SPI consumes. */
  catalog: AgentModelCatalog
  /** One entry per `models.json` provider, in file order. */
  declarations: readonly PiLlmDeclaration[]
}

/** One JSON file read as an object, with the reason when it yielded none. */
interface JsonRead {
  /** Whether the file exists. */
  present: boolean
  /** Decoded object, when the file exists and holds one. */
  value?: Record<string, unknown>
  /** Why the file yielded no object, when it exists but could not be used. */
  error?: string
}

/** The settings.json keys this catalog reads. */
interface PiSettingsValues {
  /** Saved startup provider, from `settings.defaultProvider`. */
  defaultProvider?: string
  /** Saved startup model id, from `settings.defaultModel`. */
  defaultModel?: string
  /** Saved startup thinking level; carried only to declare the loss. */
  defaultThinkingLevel?: string
  /** `settings.enabledModels`, the model scope Pi uses for startup and cycling. */
  enabledModels?: readonly string[]
  /** Agent-directory-only project trust fallback; never merged from the project tier. */
  defaultProjectTrust?: string
  /** Whether per-model startup thinking levels are configured (no canonical field). */
  modelThinkingLevels: boolean
  /** Whether custom thinking budgets are configured (no canonical field). */
  thinkingBudgets: boolean
}

/** What `auth.json` and the environment say about one provider's credential. */
interface CredentialFacts {
  /** Provider ids a stored credential exists for, usable or expired. */
  stored: ReadonlySet<string>
  /** Providers whose stored key is a `!command` reference. */
  command: ReadonlySet<string>
}

/** One provider's credential decision, with no secret material inside. */
interface ProviderCredential {
  /** Environment variable name the declaration references, when it names exactly one. */
  apiKeyEnv?: string
  /** Whether a usable credential declaration exists for this provider. */
  present: boolean
}

/** Whether Pi would load the project tier for the directory being read. */
export interface ProjectTrust {
  /** The decision, as Pi resolves it. */
  trusted: boolean
  /** Why the decision came out that way, for a declared note. */
  reason: string
}

/** Options for {@link resolvePiProjectTrust}. */
export interface PiProjectTrustOptions {
  /** Directory whose project tier the decision is about; defaults to the process working directory. */
  cwd?: string
  /** Environment the agent directory is resolved from; defaults to the host's. */
  env?: NodeJS.ProcessEnv
  /**
   * Already-projected agent-directory settings, so a caller that read `settings.json` does
   * not read it twice. Omitted means this call reads it.
   */
  agentSettings?: Pick<PiSettingsValues, 'defaultProjectTrust'>
}

/** One project-trust decision with the `sources` rows of the files it was read from. */
export interface PiProjectTrustRead {
  /** Whether Pi would load the project tier, and why. */
  decision: ProjectTrust
  /** The `sources` row for `trust.json`. */
  trustSource: ModelSourceFile
  /** The `sources` row for the settings file, present only when this call read it. */
  settingsSource?: ModelSourceFile
}

/**
 * Resolve whether Pi would load a directory's project tier, exactly as Pi does: the nearest
 * `trust.json` entry for an ancestor of the cwd wins, else the `defaultProjectTrust`
 * setting, whose `ask` cannot be answered by a non-interactive reader.
 *
 * Shared by every reader that must know whether `.pi` files apply — the model catalog and
 * the capability inventory — so one parse decides it for both.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param options - Project directory, environment, and already-read agent settings.
 * @returns The decision and the source rows of the files it came from.
 */
export async function resolvePiProjectTrust(
  ctx: PiReadContext,
  options: PiProjectTrustOptions = {},
): Promise<PiProjectTrustRead> {
  const env = options.env ?? process.env
  const cwd = ctx.files.resolvePath(options.cwd ?? process.cwd())
  const layout = await resolvePiStore(ctx, env)
  const trustPath = `${layout.agentDir}/trust.json`
  const trustFile = await readJsonObject(ctx, trustPath)
  let agentSettings = options.agentSettings
  let settingsSource: ModelSourceFile | undefined
  if (agentSettings === undefined) {
    const read = await readSettings(ctx, layout.settingsPath)
    agentSettings = read.values
    settingsSource = sourceOf(layout.settingsPath, read.read)
  }
  return {
    decision: projectTrustFor(trustFile, cwd, agentSettings),
    trustSource: sourceOf(trustPath, trustFile),
    ...(settingsSource === undefined ? {} : { settingsSource }),
  }
}

/** The model reference an `enabledModels` pattern is matched against. */
interface ModelReference {
  /** Model id, verbatim. */
  id: string
  /** Provider the model belongs to, when one is known. */
  providerId?: string
}

/** Accumulator for one projection run. */
interface CatalogDraft {
  providers: AgentProvider[]
  models: AgentModel[]
  sources: ModelSourceFile[]
  notes: ProjectionNote[]
}

/**
 * Read Pi's configured model and provider catalog. Read-only, and never throwing for an
 * absent file, a missing agent directory or a malformed `models.json`: each degrades into a
 * `sources` entry and a {@link ProjectionNote}.
 *
 * @param ctx - Ambient services (logger, runtime config, read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment, project directory and observation time; injected for testability.
 * @returns The catalog of what Pi's own configuration declares on this machine.
 */
export async function readPiModelCatalog(
  ctx: PiReadContext,
  agent: AgentId,
  options: PiModelCatalogOptions = {},
): Promise<AgentModelCatalog> {
  return (await readPiModelCatalogWithRoutes(ctx, agent, options)).catalog
}

/**
 * Read Pi's configuration once, as both the canonical catalog and the provider declarations
 * an LLM route needs.
 *
 * One parse feeds both projections, so a route can never describe an endpoint or a model
 * set that the catalog does not: the same `models.json` text decides what this machine can
 * run and what the harness may select.
 *
 * @param ctx - Ambient services (logger, runtime config, read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment, project directory and observation time; injected for testability.
 * @returns The catalog plus one declaration per `models.json` provider.
 */
export async function readPiModelCatalogWithRoutes(
  ctx: PiReadContext,
  agent: AgentId,
  options: PiModelCatalogOptions = {},
): Promise<PiCatalogRead> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const cwd = ctx.files.resolvePath(options.cwd ?? process.cwd())
  const layout = await resolvePiStore(ctx, env)
  const draft: CatalogDraft = {
    providers: [],
    models: [],
    sources: [],
    notes: [PI_BUILTIN_CATALOG_NOTE],
  }
  let declarations: readonly PiLlmDeclaration[] = []

  const modelsPath = `${layout.agentDir}/models.json`
  const projectSettingsPath = `${cwd}/.pi/settings.json`
  const projectModelsPath = `${cwd}/.pi/models.json`

  const auth = await readPiCredentials(ctx, layout.credentialPath, now)
  const credentials = credentialFactsFrom(auth)

  const modelsFile = await readJsonObject(ctx, modelsPath)
  draft.sources.push(sourceOf(modelsPath, modelsFile))
  if (modelsFile.value !== undefined) {
    declarations = projectModelsJson(draft, modelsFile.value, env, credentials)
  } else if (modelsFile.error !== undefined) {
    draft.notes.push({
      field: 'providers',
      reason: `${modelsPath} ${modelsFile.error}, so no configured providers or models were read from it`,
    })
  }

  const agentSettingsFile = await readSettings(ctx, layout.settingsPath)
  draft.sources.push(sourceOf(layout.settingsPath, agentSettingsFile.read))

  // auth.json is read through auth.ts for credential presence only; its content is never
  // projected, and the fingerprint only answers whether the file exists.
  const credentialFile = await ctx.files.fingerprint(layout.credentialPath)
  draft.sources.push({ path: layout.credentialPath, present: credentialFile.size >= 0 })

  const trustRead = await resolvePiProjectTrust(ctx, {
    cwd,
    env,
    agentSettings: agentSettingsFile.values,
  })
  draft.sources.push(trustRead.trustSource)
  const trust = trustRead.decision

  const projectSettingsFile = await readSettings(ctx, projectSettingsPath)
  draft.sources.push(projectSettingsSourceOf(projectSettingsPath, projectSettingsFile.read, trust))
  if (
    projectSettingsFile.read.present &&
    projectSettingsFile.read.error === undefined &&
    !trust.trusted
  ) {
    draft.notes.push({
      field: '*',
      reason:
        `${projectSettingsPath} exists, but Pi loads project settings only after project trust ` +
        `(${trust.reason}), so the catalog is built from the agent-directory files alone`,
    })
  }

  const projectModelsFile = await readJsonObject(ctx, projectModelsPath)
  draft.sources.push(projectModelsSourceOf(projectModelsPath, projectModelsFile))

  const settings = mergeSettings(
    agentSettingsFile.values,
    trust.trusted ? projectSettingsFile.values : EMPTY_SETTINGS,
  )
  projectDefaultModel(draft, settings)
  applyEnabledModels(draft, settings.enabledModels)
  declareSettingsLosses(draft, settings)

  return {
    catalog: {
      agentId: agent,
      ...(settings.defaultModel === undefined ? {} : { defaultModel: settings.defaultModel }),
      providers: draft.providers,
      models: draft.models,
      sources: draft.sources,
      notes: draft.notes,
      observedAt: new Date(now).toISOString(),
    },
    declarations,
  }
}

/** Settings with nothing configured. */
const EMPTY_SETTINGS: PiSettingsValues = { modelThinkingLevels: false, thinkingBudgets: false }

/**
 * Read one JSON file as an object, tolerating absence and corruption.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param path - Absolute path.
 * @returns Presence, the object when there is one, and why there is not.
 */
async function readJsonObject(ctx: PiReadContext, path: string): Promise<JsonRead> {
  const parsed = await ctx.files.readJson<unknown>(path)
  if (!parsed.ok) {
    return parsed.missing
      ? { present: false }
      : { present: true, error: `could not be parsed as JSON (${parsed.error})` }
  }
  if (!isRecord(parsed.value)) return { present: true, error: 'does not hold a JSON object' }
  return { present: true, value: parsed.value }
}

/**
 * One `sources` row for a file read, carrying its parse failure as the note when there is one.
 *
 * @param path - Absolute path.
 * @param read - The read result.
 * @returns The source file row.
 */
function sourceOf(path: string, read: JsonRead): ModelSourceFile {
  return read.error === undefined
    ? { path, present: read.present }
    : { path, present: read.present, note: read.error }
}

/**
 * The `sources` row for the project tier's `settings.json`, explaining a present file that
 * was withheld because Pi would not load it.
 *
 * @param path - Absolute path.
 * @param read - The read result.
 * @param trust - The project trust decision.
 * @returns The source file row.
 */
function projectSettingsSourceOf(path: string, read: JsonRead, trust: ProjectTrust): ModelSourceFile {
  if (!read.present) return { path, present: false }
  if (read.error !== undefined) return { path, present: true, note: read.error }
  if (trust.trusted) return { path, present: true }
  return { path, present: true, note: `present but not projected: ${trust.reason}` }
}

/**
 * The `sources` row for the project tier's `models.json`.
 *
 * Pi reads `models.json` from the agent directory only (its own `docs/configuration.md`
 * lists no project-tier equivalent), so a project file is reported and never merged: an
 * entry Pi would not honor must not appear in this catalog.
 *
 * @param path - Absolute path.
 * @param read - The read result.
 * @returns The source file row.
 */
function projectModelsSourceOf(path: string, read: JsonRead): ModelSourceFile {
  if (!read.present) return { path, present: false }
  const defect = read.error === undefined ? '' : `; it also ${read.error}`
  return {
    path,
    present: true,
    note: `present but not projected: Pi reads models.json from the agent directory only${defect}`,
  }
}

/**
 * Read one settings file and project the keys this catalog uses.
 *
 * @param ctx - Adapter context.
 * @param path - Absolute settings path.
 * @returns The read result and the projected values.
 */
async function readSettings(ctx: PiReadContext, path: string): Promise<{ read: JsonRead; values: PiSettingsValues }> {
  const read = await readJsonObject(ctx, path)
  return { read, values: read.value === undefined ? EMPTY_SETTINGS : projectSettingsValues(read.value) }
}

/**
 * Project the settings keys this catalog reads.
 *
 * @param raw - The decoded settings object.
 * @returns The projected settings.
 */
function projectSettingsValues(raw: Record<string, unknown>): PiSettingsValues {
  const defaultProvider = configuredText(readString(raw, 'defaultProvider'))
  const defaultModel = configuredText(readString(raw, 'defaultModel'))
  const defaultThinkingLevel = configuredText(readString(raw, 'defaultThinkingLevel'))
  const defaultProjectTrust = configuredText(readString(raw, 'defaultProjectTrust'))
  const patterns = (readArray(raw, 'enabledModels') ?? []).filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  )
  return {
    ...(defaultProvider === undefined ? {} : { defaultProvider }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
    ...(defaultProjectTrust === undefined ? {} : { defaultProjectTrust }),
    ...(patterns.length === 0 ? {} : { enabledModels: patterns }),
    modelThinkingLevels: readRecord(raw, 'modelThinkingLevels') !== undefined,
    thinkingBudgets: readRecord(raw, 'thinkingBudgets') !== undefined,
  }
}

/**
 * Merge project settings over agent-directory settings the way Pi does: per key, with an
 * array value replacing the base one.
 *
 * @param agentSettings - Values from the agent directory.
 * @param projectSettings - Values from the project tier, when it is trusted.
 * @returns The effective values this catalog reads.
 */
function mergeSettings(agentSettings: PiSettingsValues, projectSettings: PiSettingsValues): PiSettingsValues {
  const defaultProvider = projectSettings.defaultProvider ?? agentSettings.defaultProvider
  const defaultModel = projectSettings.defaultModel ?? agentSettings.defaultModel
  const defaultThinkingLevel = projectSettings.defaultThinkingLevel ?? agentSettings.defaultThinkingLevel
  const enabledModels = projectSettings.enabledModels ?? agentSettings.enabledModels
  // `defaultProjectTrust` can only be set in the agent directory, so it is deliberately not
  // merged here; `modelThinkingLevels` and `thinkingBudgets` are tracked only to be declared
  // as losses, so their presence is the union.
  return {
    ...(defaultProvider === undefined ? {} : { defaultProvider }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel }),
    ...(enabledModels === undefined ? {} : { enabledModels }),
    ...(agentSettings.defaultProjectTrust === undefined
      ? {}
      : { defaultProjectTrust: agentSettings.defaultProjectTrust }),
    modelThinkingLevels: agentSettings.modelThinkingLevels || projectSettings.modelThinkingLevels,
    thinkingBudgets: agentSettings.thinkingBudgets || projectSettings.thinkingBudgets,
  }
}

/**
 * Resolve whether Pi would load the project tier, exactly as Pi does: the nearest
 * `trust.json` entry for an ancestor of the cwd wins, else the `defaultProjectTrust`
 * setting, whose `ask` cannot be answered by a non-interactive reader.
 *
 * @param trustFile - The read `trust.json`.
 * @param cwd - Absolute project directory.
 * @param agentSettings - Agent-directory settings, the only scope `defaultProjectTrust` may live in.
 * @returns The decision and its reason.
 */
function projectTrustFor(
  trustFile: JsonRead,
  cwd: string,
  agentSettings: Pick<PiSettingsValues, 'defaultProjectTrust'>,
): ProjectTrust {
  const entries = trustFile.value
  if (entries !== undefined) {
    let directory = cwd
    while (true) {
      const decision = entries[directory]
      if (decision === true) return { trusted: true, reason: `trust.json trusts ${directory}` }
      if (decision === false) return { trusted: false, reason: `trust.json records ${directory} as not trusted` }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  if (agentSettings.defaultProjectTrust === 'always') {
    return { trusted: true, reason: 'defaultProjectTrust is "always"' }
  }
  if (agentSettings.defaultProjectTrust === 'never') {
    return { trusted: false, reason: 'defaultProjectTrust is "never"' }
  }
  const detail = trustFile.present ? 'trust.json records no decision for it' : 'trust.json is absent'
  return { trusted: false, reason: `${detail}, and defaultProjectTrust is not "always"` }
}

/**
 * Project a `models.json` document onto providers and models.
 *
 * @param draft - Accumulator to fill.
 * @param config - The decoded `models.json` object.
 * @param env - Environment credential references are resolved against.
 * @param credentials - Credential facts observed from `auth.json`.
 * @returns One LLM route declaration per provider entry, in file order.
 */
function projectModelsJson(
  draft: CatalogDraft,
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  credentials: CredentialFacts,
): readonly PiLlmDeclaration[] {
  if (readRecord(config, 'modelOverrides') !== undefined) {
    draft.notes.push({
      field: 'models',
      reason:
        'models.json declares a top-level `modelOverrides`, which Pi\'s schema does not accept ' +
        '(the key lives inside a provider, where it patches that provider\'s models), so it was ignored',
    })
  }
  const rawProviders = readRecord(config, 'providers')
  if (rawProviders === undefined) {
    draft.notes.push({
      field: 'providers',
      reason: 'models.json declares no `providers` object, which Pi rejects as an invalid models.json',
    })
    return []
  }

  const unprojected = { provider: new Set<string>(), model: new Set<string>() }
  const overrideProviders = new Set<string>()
  const declarations: PiLlmDeclaration[] = []
  let malformedProviders = 0
  let malformedModels = 0
  let overrideOnly = 0

  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (!isRecord(rawProvider)) {
      malformedProviders += 1
      continue
    }
    collectPresent(rawProvider, UNPROJECTED_PROVIDER_KEYS, unprojected.provider)

    const name = configuredText(readString(rawProvider, 'name'))
    const baseUrl = configuredText(readString(rawProvider, 'baseUrl'))
    const wireApi = configuredText(readString(rawProvider, 'api'))
    const credential = projectProviderCredential(
      providerId,
      configuredText(readString(rawProvider, 'apiKey')),
      env,
      credentials,
      draft.notes,
    )
    draft.providers.push({
      id: providerId,
      ...(name === undefined ? {} : { name }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(credential.apiKeyEnv === undefined ? {} : { apiKeyEnv: credential.apiKeyEnv }),
      credentialPresent: credential.present,
      ...(wireApi === undefined ? {} : { wireApi }),
      source: 'config',
    })
    if (declaresNothing(rawProvider)) {
      draft.notes.push({
        field: 'providers',
        reason:
          `${providerId}: models.json declares no baseUrl, headers, compat, apiKey, oauth, ` +
          'authHeader, models or modelOverrides, and Pi rejects such a provider entry',
      })
    }

    const overrides = readRecord(rawProvider, 'modelOverrides') ?? {}
    const declaredHere = new Set<string>()
    const transportOverrides: string[] = []
    for (const definition of readArray(rawProvider, 'models') ?? []) {
      if (!isRecord(definition)) {
        malformedModels += 1
        continue
      }
      const modelId = configuredText(readString(definition, 'id'))
      if (modelId === undefined) {
        malformedModels += 1
        continue
      }
      collectPresent(definition, UNPROJECTED_MODEL_KEYS, unprojected.model)
      const rawOverride = overrides[modelId]
      if (rawOverride !== undefined && !isRecord(rawOverride)) malformedModels += 1
      const patch = isRecord(rawOverride) ? rawOverride : undefined
      if (patch !== undefined) collectPresent(patch, UNPROJECTED_MODEL_KEYS, unprojected.model)
      draft.models.push(projectModel(modelId, providerId, definition, patch, 'config'))
      declaredHere.add(modelId)
      // A per-model `api` or `baseUrl` sends that model somewhere this route cannot
      // follow, so it is refused rather than requested over the provider's endpoint.
      if (configuredText(readString(definition, 'api')) !== undefined
        || configuredText(readString(definition, 'baseUrl')) !== undefined) {
        transportOverrides.push(modelId)
      }
    }
    for (const [modelId, rawOverride] of Object.entries(overrides)) {
      if (declaredHere.has(modelId)) continue
      if (!isRecord(rawOverride)) {
        malformedModels += 1
        continue
      }
      collectPresent(rawOverride, UNPROJECTED_MODEL_KEYS, unprojected.model)
      draft.models.push(projectModel(modelId, providerId, undefined, rawOverride, 'catalog'))
      overrideOnly += 1
      overrideProviders.add(providerId)
    }

    declarations.push({
      providerId,
      ...(wireApi === undefined ? {} : { api: wireApi }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...headersOf(rawProvider),
      credential: declaredCredentialShape(providerId, configuredText(readString(rawProvider, 'apiKey'))),
      modelIds: [...declaredHere],
      transportOverrides,
    })
  }

  if (malformedProviders > 0) {
    draft.notes.push({
      field: 'providers',
      reason:
        `${malformedProviders} providers entries are not objects and were skipped here; Pi validates ` +
        'the file against its schema and would reject it whole',
    })
  }
  if (malformedModels > 0) {
    draft.notes.push({
      field: 'models',
      reason:
        `${malformedModels} models.json model entries were skipped here (an entry that is not an ` +
        'object, a model with no id, or a malformed modelOverrides value); Pi validates the file ' +
        'against its schema and would reject it whole',
    })
  }
  if (overrideOnly > 0) {
    draft.notes.push({
      field: 'models',
      reason:
        `${overrideOnly} modelOverrides ${overrideOnly === 1 ? 'entry' : 'entries'} under ` +
        `${[...overrideProviders].join(', ')} ${overrideOnly === 1 ? 'names a model' : 'name models'} ` +
        "this reader cannot enumerate, because Pi's built-in catalog is deliberately not read; " +
        `${overrideOnly === 1 ? 'it is listed' : 'they are listed'} with only the metadata the ` +
        'override itself declares',
    })
  }
  if (unprojected.provider.size > 0) {
    draft.notes.push({
      field: 'providers',
      reason: `provider keys with no canonical field are configured and not carried: ${[...unprojected.provider].sort().join(', ')}`,
    })
  }
  if (unprojected.model.size > 0) {
    draft.notes.push({
      field: 'models',
      reason: `model keys with no canonical field are configured and not carried: ${[...unprojected.model].sort().join(', ')}`,
    })
  }
  return declarations
}

/**
 * The headers a provider entry declares, as string entries.
 *
 * A declared value may be a credential in itself (a gateway's own key header), so it is
 * carried to the request and never logged or reported.
 *
 * @param rawProvider - The provider entry.
 * @returns The headers, or nothing when the entry declares none.
 */
function headersOf(rawProvider: Record<string, unknown>): Pick<PiLlmDeclaration, 'headers'> {
  const raw = readRecord(rawProvider, 'headers')
  if (raw === undefined) return {}
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers[key] = value
  }
  return Object.keys(headers).length === 0 ? {} : { headers }
}

/**
 * Classify one provider's `apiKey` for the LLM route.
 *
 * A provider that declares none still gets the ambient variable Pi's own discovery reads
 * for well-known ids, so a route authenticates the same way Pi would; everything else is
 * declared as nothing rather than guessed at.
 *
 * @param providerId - Provider id, verbatim.
 * @param apiKey - The declared `apiKey`, when there is one.
 * @returns The shape, with the value present only for a literal.
 */
function declaredCredentialShape(providerId: string, apiKey: string | undefined): PiDeclaredCredential {
  if (apiKey === undefined) {
    const ambient = PI_PROVIDER_ENV_BY_ID[providerId]?.[0]
    return ambient === undefined ? { kind: 'none' } : { kind: 'env', names: [ambient] }
  }
  const shape = classifyConfigValue(apiKey)
  switch (shape.kind) {
    case 'command':
      return { kind: 'command' }
    case 'literal':
      return { kind: 'literal', value: unescapeConfigValue(apiKey) }
    case 'env':
      return { kind: 'env', names: shape.names }
  }
}

/**
 * Undo the literal escapes Pi's config-value resolver honours in a value with no reference.
 *
 * @param value - The configured value.
 * @returns The value with `$$` and `$!` resolved to their literal characters.
 */
function unescapeConfigValue(value: string): string {
  return value.replace(/\$\$/g, '$').replace(/\$!/g, '!')
}

/**
 * Decide one provider's credential facts from its `apiKey` and the observed store.
 *
 * The declared value is inspected only for its shape. A literal or `!command` value is
 * never read into the catalog and the command is never run; only the fact that a
 * credential is declared is reported.
 *
 * @param providerId - Provider id, verbatim.
 * @param apiKey - The declared `apiKey`, when models.json declares one.
 * @param env - Environment credential references are resolved against.
 * @param credentials - Credential facts observed from `auth.json`.
 * @param notes - Accumulator for declared gaps.
 * @returns The environment variable name, when one is referenced, and whether a credential exists.
 */
function projectProviderCredential(
  providerId: string,
  apiKey: string | undefined,
  env: NodeJS.ProcessEnv,
  credentials: CredentialFacts,
  notes: ProjectionNote[],
): ProviderCredential {
  const stored = credentials.stored.has(providerId)
  const result = declaredCredential(providerId, apiKey, env, stored, notes)
  if (stored && credentials.command.has(providerId)) {
    notes.push({
      field: 'providers',
      reason:
        `${providerId}: auth.json stores a \`!command\` key reference, which Pi resolves by running ` +
        'a shell command; that command is neither read nor run here',
    })
  }
  return result
}

/**
 * Classify a provider's declared `apiKey`, or its known environment variable when it
 * declares none.
 *
 * @param providerId - Provider id, verbatim.
 * @param apiKey - The declared `apiKey`, when there is one.
 * @param env - Environment credential references are resolved against.
 * @param stored - Whether `auth.json` holds a credential for this provider.
 * @param notes - Accumulator for declared gaps.
 * @returns The environment variable name, when one is referenced, and whether a credential exists.
 */
function declaredCredential(
  providerId: string,
  apiKey: string | undefined,
  env: NodeJS.ProcessEnv,
  stored: boolean,
  notes: ProjectionNote[],
): ProviderCredential {
  if (apiKey === undefined) {
    const known = PI_PROVIDER_ENV_BY_ID[providerId]?.[0]
    return {
      ...(known === undefined ? {} : { apiKeyEnv: known }),
      present: (known !== undefined && isSet(env, known)) || stored,
    }
  }
  const shape = classifyConfigValue(apiKey)
  if (shape.kind === 'command') {
    notes.push({
      field: 'providers',
      reason:
        `${providerId}: models.json declares a \`!command\` apiKey; the command is never read or ` +
        'run, and only the fact that a credential is declared is reported',
    })
    return { present: true }
  }
  if (shape.kind === 'literal') {
    notes.push({
      field: 'providers',
      reason:
        `${providerId}: models.json declares a literal apiKey; its value is never read into the ` +
        'catalog, only reported as declared',
    })
    return { present: true }
  }
  const missing = shape.names.filter(name => !isSet(env, name))
  if (missing.length > 0) {
    notes.push({
      field: 'providers',
      reason:
        `${providerId}: the apiKey references ${missing.map(name => `$${name}`).join(', ')}, which ` +
        `${missing.length === 1 ? 'is' : 'are'} not set in this environment`,
    })
  }
  return {
    ...(shape.single === undefined ? {} : { apiKeyEnv: shape.single }),
    present: missing.length === 0 || stored,
  }
}

/** How Pi classifies a configured `apiKey` value: an environment template, a command, or a literal. */
type ConfigValueShape =
  | { kind: 'command' }
  | { kind: 'literal' }
  | { kind: 'env'; names: readonly string[]; single: string | undefined }

/**
 * Classify a configured value by the shape Pi gives it (`resolve-config-value.ts`):
 * a leading `!` is a command, `$NAME`/`${NAME}` interpolate the environment, `$$` and `$!`
 * are literal characters, and anything without a reference is a literal.
 *
 * @param value - The configured value.
 * @returns Its shape, with every environment variable name it references.
 */
function classifyConfigValue(value: string): ConfigValueShape {
  if (value.startsWith('!')) return { kind: 'command' }
  const names: string[] = []
  let index = 0
  while (index < value.length) {
    const dollar = value.indexOf('$', index)
    if (dollar === -1) break
    const next = value[dollar + 1]
    if (next === '$' || next === '!') {
      index = dollar + 2
      continue
    }
    if (next === '{') {
      const end = value.indexOf('}', dollar + 2)
      if (end === -1) {
        index = dollar + 1
        continue
      }
      const name = value.slice(dollar + 2, end)
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name)
      index = end + 1
      continue
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(dollar + 1))
    if (match === null || match[0] === undefined || match[0] === '') {
      index = dollar + 1
      continue
    }
    names.push(match[0])
    index = dollar + 1 + match[0].length
  }
  if (names.length === 0) return { kind: 'literal' }
  const only = names[0]
  // `apiKeyEnv` names one variable, so it is reported only when the whole value is exactly
  // one reference; `Bearer $TOKEN` still resolves in Pi, but no single name describes it.
  const single = names.length === 1 && only !== undefined && (value === `$${only}` || value === `\${${only}}`)
  return { kind: 'env', names, single: single ? only : undefined }
}

/**
 * Reduce `auth.json`'s classified credentials to the two questions the catalog asks:
 * does this provider have a stored credential, and is it a `!command` reference?
 *
 * @param credentials - Stored credentials as auth.ts classified them.
 * @returns The providers with a stored credential, and those whose key is a command.
 */
function credentialFactsFrom(credentials: readonly PiStoredCredential[]): CredentialFacts {
  const stored = new Set<string>()
  const command = new Set<string>()
  for (const credential of credentials) {
    stored.add(credential.provider)
    if (credential.kind === 'command') command.add(credential.provider)
  }
  return { stored, command }
}

/**
 * Project one model, patched by its `modelOverrides` entry when it has one.
 *
 * @param id - Model id, verbatim as the configuration spells it.
 * @param providerId - Provider the model belongs to.
 * @param definition - The `models` entry, when the model is declared there.
 * @param patch - The `modelOverrides` entry for this id, when there is one.
 * @param source - Where the declaration was found.
 * @returns The canonical model.
 */
function projectModel(
  id: string,
  providerId: string,
  definition: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
  source: ModelSource,
): AgentModel {
  const from = definition ?? {}
  const over = patch ?? {}
  const displayName = configuredText(readString(over, 'name')) ?? configuredText(readString(from, 'name'))
  const contextWindow = positiveNumber(over, 'contextWindow') ?? positiveNumber(from, 'contextWindow')
  const reasoning = readBoolean(over, 'reasoning') ?? readBoolean(from, 'reasoning')
  const levelMap = mergeLevelMaps(readRecord(from, 'thinkingLevelMap'), readRecord(over, 'thinkingLevelMap'))
  return {
    id,
    ...(displayName === undefined ? {} : { displayName }),
    providerId,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    // `reasoningEfforts` is reported only when the configuration says something about
    // thinking; a model that says nothing is not guessed at.
    ...(reasoning === undefined && levelMap === undefined
      ? {}
      : { reasoningEfforts: piThinkingLevels(reasoning === true, levelMap) }),
    source,
  }
}

/**
 * Merge a `thinkingLevelMap` override the way Pi does: per level, with the override's own
 * value winning.
 *
 * @param base - The model's own map, when it has one.
 * @param patch - The override's map, when it has one.
 * @returns The effective map, or `undefined` when neither declares one.
 */
function mergeLevelMaps(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (base === undefined) return patch
  if (patch === undefined) return base
  return { ...base, ...patch }
}

/**
 * The thinking levels Pi reports for a model: Pi's own `getSupportedThinkingLevels`, where
 * a non-reasoning model accepts only `off`, a `null` mapping removes a level, and
 * `xhigh`/`max` exist only when the model maps them explicitly.
 *
 * @param reasoning - Whether the model declares `reasoning: true`.
 * @param levelMap - The model's `thinkingLevelMap`, when it has one.
 * @returns The accepted levels, in Pi's order.
 */
function piThinkingLevels(reasoning: boolean, levelMap: Record<string, unknown> | undefined): readonly string[] {
  if (!reasoning) return ['off']
  return PI_THINKING_LEVELS.filter(level => {
    const mapped = levelMap?.[level]
    if (mapped === null) return false
    if (PI_EXTENDED_THINKING_LEVELS.includes(level)) return mapped !== undefined
    return true
  })
}

/**
 * Apply the saved default model to the projected list.
 *
 * The model is matched by id and, when `defaultProvider` is set, by provider. A default
 * that no `models.json` entry declares is added from settings alone: it is normally a model
 * Pi ships, which this reader deliberately does not enumerate, so only the id is recorded.
 * Under an `enabledModels` scope, Pi uses the saved default only while that model is inside
 * the scope, so `isDefault` is set only then; otherwise Pi starts from the scope's first
 * model, which this reader cannot always identify.
 *
 * @param draft - Accumulator to fill.
 * @param settings - The effective settings.
 */
function projectDefaultModel(draft: CatalogDraft, settings: PiSettingsValues): void {
  const id = settings.defaultModel
  if (id === undefined) return
  const provider = settings.defaultProvider
  const scope = settings.enabledModels
  const index = draft.models.findIndex(
    model => model.id === id && (provider === undefined || model.providerId === provider),
  )
  if (index !== -1) {
    const found = draft.models[index]
    if (found === undefined) return
    if (scope === undefined || matchesAnyPattern(scope, found)) {
      draft.models[index] = { ...found, isDefault: true }
    } else {
      draft.notes.push({
        field: 'defaultModel',
        reason:
          `settings.defaultModel (${id}) is not enabled by settings.enabledModels, so Pi starts ` +
          "from the first model of that scope instead; that model may come from Pi's built-in " +
          'catalog, which this reader does not read',
      })
    }
    return
  }
  const reference: ModelReference = {
    id,
    ...(provider === undefined ? {} : { providerId: provider }),
  }
  const inScope = scope === undefined || matchesAnyPattern(scope, reference)
  draft.models.push({
    ...reference,
    ...(inScope ? { isDefault: true } : {}),
    source: 'config',
  })
  if (!inScope) {
    draft.notes.push({
      field: 'defaultModel',
      reason:
        `settings.defaultModel (${id}) is neither declared by models.json nor enabled by ` +
        'settings.enabledModels, so Pi starts from the first model of that scope instead',
    })
    return
  }
  const where = provider === undefined ? 'without a defaultProvider' : `under provider ${provider}`
  draft.notes.push({
    field: 'defaultModel',
    reason:
      `settings.defaultModel (${id}) is not declared ${where} in models.json, so only its id is ` +
      "known here; Pi resolves the rest against its built-in catalog",
  })
}

/**
 * Apply `settings.enabledModels`, the scope Pi uses for startup selection and model cycling.
 *
 * The scope is a filter over the models this catalog knows, so an excluded id is not an
 * unavailable model; the notes say so, because Pi still accepts an id passed explicitly.
 *
 * @param draft - Accumulator to fill.
 * @param patterns - The configured patterns, when there are any.
 */
function applyEnabledModels(draft: CatalogDraft, patterns: readonly string[] | undefined): void {
  if (patterns === undefined) return
  const before = draft.models.length
  const kept = draft.models.filter(model => patterns.some(pattern => matchesModelPattern(pattern, model)))
  draft.models = kept
  draft.notes.push({
    field: 'models',
    reason:
      "settings.enabledModels scopes Pi's startup selection and model cycling, so this list is " +
      'that scope as far as it can be read here; a pattern that also names built-in models ' +
      'matches more than this list',
  })
  if (before > 0 && kept.length === 0) {
    draft.notes.push({
      field: 'models',
      reason:
        `none of the ${before} configured models matches settings.enabledModels ` +
        `(${patterns.join(', ')}), which most likely names models from Pi's built-in catalog that ` +
        'this reader deliberately does not enumerate',
    })
    return
  }
  const dropped = before - kept.length
  if (dropped > 0) {
    draft.notes.push({
      field: 'models',
      reason:
        `${dropped} configured ${dropped === 1 ? 'model is' : 'models are'} not enabled by ` +
        'settings.enabledModels; Pi still accepts an excluded id passed explicitly, so this list ' +
        'is the enabled scope, not everything Pi accepts',
    })
  }
}

/**
 * Whether any `enabledModels` pattern matches a model.
 *
 * @param patterns - The configured patterns, in order.
 * @param model - The model reference to test.
 * @returns `true` when at least one pattern matches.
 */
function matchesAnyPattern(patterns: readonly string[], model: ModelReference): boolean {
  return patterns.some(pattern => matchesModelPattern(pattern, model))
}

/**
 * Whether one `enabledModels` pattern matches a model.
 *
 * Pi resolves these patterns with exact ids and case-insensitive globs against
 * `provider/id` and the bare id, after stripping an optional `:<thinking>` suffix
 * (`--models`, `enabledModels`). Pi's fuzzy partial-name matching is not reproduced; a
 * pattern that needs it simply does not match, and the notes say when nothing matched.
 *
 * @param pattern - One configured pattern.
 * @param model - Model reference to test.
 * @returns Whether the pattern matches.
 */
function matchesModelPattern(pattern: string, model: ModelReference): boolean {
  const base = stripThinkingSuffix(pattern.trim())
  if (base === '') return false
  const references = model.providerId === undefined ? [model.id] : [`${model.providerId}/${model.id}`, model.id]
  if (!/[*?[]/.test(base)) {
    return references.some(reference => reference.toLowerCase() === base.toLowerCase())
  }
  const expression = globExpression(base)
  return references.some(reference => expression.test(reference))
}

/**
 * Remove a trailing `:<thinking>` suffix, keeping any other colon (a model id such as
 * `qwen2.5-coder:7b` keeps its tag).
 *
 * @param pattern - The pattern as configured.
 * @returns The pattern without a recognized thinking suffix.
 */
function stripThinkingSuffix(pattern: string): string {
  const colon = pattern.lastIndexOf(':')
  if (colon <= 0) return pattern
  const suffix = pattern.slice(colon + 1)
  if (!PI_THINKING_LEVELS.includes(suffix)) return pattern
  return pattern.slice(0, colon)
}

/**
 * Compile Pi's `minimatch`-style pattern subset (`*`, `?`, `[…]`) for case-insensitive matching.
 *
 * @param pattern - A pattern that contains a glob character.
 * @returns The expression to test references with.
 */
function globExpression(pattern: string): RegExp {
  let expression = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      expression += '.*'
      continue
    }
    if (character === '?') {
      expression += '.'
      continue
    }
    if (character === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end !== -1) {
        expression += `[${pattern.slice(index + 1, end)}]`
        index = end
        continue
      }
    }
    expression += (character ?? '').replace(/[.*+?^${}()|[\]\\]/, '\\$&')
  }
  return new RegExp(`^${expression}$`, 'i')
}

/**
 * Declare the settings keys that shape how Pi runs a model but have no canonical field.
 *
 * @param draft - Accumulator to fill.
 * @param settings - The effective settings.
 */
function declareSettingsLosses(draft: CatalogDraft, settings: PiSettingsValues): void {
  const losses: string[] = []
  if (settings.defaultThinkingLevel !== undefined) losses.push('defaultThinkingLevel')
  if (settings.modelThinkingLevels) losses.push('modelThinkingLevels')
  if (settings.thinkingBudgets) losses.push('thinkingBudgets')
  if (losses.length === 0) return
  draft.notes.push({
    field: 'models',
    reason:
      `settings.json configures ${losses.join(', ')}, which ` +
      `${losses.length === 1 ? 'affects' : 'affect'} how Pi runs a model; \`AgentModel\` has no ` +
      `thinking-level or budget field, so ${losses.length === 1 ? 'it is' : 'they are'} not carried`,
  })
}

/**
 * Whether a provider entry declares anything Pi accepts.
 *
 * Pi rejects a provider that names none of `baseUrl`, `headers`, `compat`, `modelOverrides`,
 * `models`, `apiKey`, `oauth` or `authHeader`, so such an entry is reported as a gap.
 *
 * @param raw - The provider entry.
 * @returns Whether it declares nothing.
 */
function declaresNothing(raw: Record<string, unknown>): boolean {
  const overrides = readRecord(raw, 'modelOverrides')
  return (
    (readArray(raw, 'models') ?? []).length === 0 &&
    readString(raw, 'baseUrl') === undefined &&
    readRecord(raw, 'headers') === undefined &&
    readRecord(raw, 'compat') === undefined &&
    (overrides === undefined || Object.keys(overrides).length === 0) &&
    readString(raw, 'apiKey') === undefined &&
    readString(raw, 'oauth') === undefined &&
    readBoolean(raw, 'authHeader') === undefined
  )
}

/**
 * Record which of the keys a projection cannot carry the configuration actually sets.
 *
 * @param source - The configuration object.
 * @param keys - Keys with no canonical field.
 * @param into - Accumulator for the keys seen.
 */
function collectPresent(source: Record<string, unknown>, keys: readonly string[], into: Set<string>): void {
  for (const key of keys) if (Object.hasOwn(source, key)) into.add(key)
}

/**
 * Whether an environment variable carries a value.
 *
 * @param env - Environment to read, as a name lookup only; the value never leaves this check.
 * @param name - Variable name.
 * @returns `true` when the variable is set to a non-empty value.
 */
function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]
  return value !== undefined && value !== ''
}

/**
 * A configured string with content; an empty string is what Pi's schema rejects.
 *
 * @param value - The value as read.
 * @returns The value, or `undefined` when it is empty or absent.
 */
function configuredText(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * A positive token count, so Pi's `exclusiveMinimum: 0` is respected.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent, non-numeric or not positive.
 */
function positiveNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = readNumber(source, key)
  return value === undefined || value <= 0 ? undefined : value
}
