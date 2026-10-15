/**
 * Grok Build's configured model and provider catalog, read in place and never written
 * (ADR-0002, ADR-0012).
 *
 * Grok Build keeps no model table on disk: `grok models` prints what the endpoint
 * offers, and configuration only narrows or extends that list. This module therefore
 * reads the files grok itself reads, in grok's own precedence order, and projects the
 * model-relevant subset — the `[models]` defaults and filters, the BYOK `[model.<id>]`
 * and `[model_providers.<id>]` tables, the `[endpoints]` base URLs, and the
 * `GROK_CONFIG` / `GROK_CONFIG_PATH` overlays. Nothing is fetched and nothing is
 * written; a file that is absent or unparseable costs a declared gap, not an error.
 *
 * Precedence, lowest to highest (`xai-grok-config/src/config_layers.rs`): the system
 * managed file, the fleet managed file, the user config, the overlay, the user
 * requirements file, the system requirements file, then macOS MDM. A project
 * `.grok/config.toml` exists (`xai-grok-permission-rules/src/project_config.rs`) but
 * grok reads only `[mcp_servers]`, `[plugins]`, `[permission]` and `[mcp]
 * max_output_bytes` from it, so its model keys are reported and never merged.
 *
 * No credential value is read: `env_key` contributes a variable *name* whose presence
 * is checked, `api_key` contributes only the fact that it is set, and the credential
 * store is reduced to `hasKey` booleans by {@link readGrokAuthStore} before use.
 *
 * @module @zorker/muti-agent-adapter-grok/models
 */

import { dirname, extname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type {
  AgentModel,
  AgentModelCatalog,
  AgentProvider,
  ModelSourceFile,
  ProjectionNote,
} from '@zorker/muti-agent-contracts'
import { agentId } from '@zorker/muti-agent-contracts'
import type { FileProbe, Logger } from '@zorker/muti-agent-core'
import { GROK_CREDENTIAL_ENV_KEYS, readGrokAuthStore, selectGrokAuthEntry } from './auth.ts'
import { asRecord } from './events.ts'
import type { GrokPaths } from './sessions.ts'

/** Agent id this catalog describes; declared here so this module needs no adapter import. */
const AGENT_ID = agentId('grok')

/** Production cli-chat-proxy base URL (`xai-grok-env/src/lib.rs`, `PRODUCTION_ENDPOINTS`). */
export const GROK_DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'

/** Root-owned system configuration directory (`/etc/grok`). */
const SYSTEM_GROK_DIR = '/etc/grok'

/** Longest upward walk to a repository root; no checkout nests deeper in practice. */
const MAX_REPO_WALK = 64

/** Top-level tables a project file could set but grok never reads from it. */
const PROJECT_UNREAD_KEYS = ['models', 'model', 'model_providers', 'endpoints'] as const

/** `[models]` scalar pins that name a model for one purpose rather than the picker. */
const SPECIAL_MODEL_PINS = ['web_search', 'session_summary', 'image_description', 'prompt_suggestion'] as const

/**
 * The model-relevant facts a harness LLM route needs beyond the canonical catalog: which
 * model list the configuration actually declared, and which endpoint infers it.
 *
 * Produced by the same read that builds the catalog, so a route can never describe a model
 * set or an endpoint the catalog does not.
 */
export interface GrokLlmFacts {
  /**
   * CLI chat proxy base URL in force: `[endpoints].cli_chat_proxy_base_url`,
   * `$GROK_CLI_CHAT_PROXY_BASE_URL`, `[endpoints].xai_api_base_url`,
   * `$GROK_XAI_API_BASE_URL`, else the production default.
   */
  chatProxyBaseUrl: string
  /** Literal `[models].allowed_models` ids, in configured order. */
  allowedModelIds: readonly string[]
  /** `[models].allowed_models` entries that are picker globs rather than literal ids. */
  allowedGlobs: readonly string[]
  /** Effective default model id, after `GROK_DEFAULT_MODEL`. */
  defaultModel?: string
  /** Whether a custom models endpoint (`[endpoints].models_base_url`/`GROK_MODELS_BASE_URL`) is configured. */
  customModelsEndpoint: boolean
}

/** Everything the catalog reader needs from its adapter. */
export interface GrokModelReaderOptions {
  /** Read-only filesystem helpers; every read is bounded and tolerates a writer. */
  files: FileProbe
  /** Resolved Grok Build locations. */
  paths: GrokPaths
  /** Host environment, inspected for credential and endpoint variable names only. */
  hostEnv: NodeJS.ProcessEnv
  /** Directory whose project `.grok/config.toml` tier is discovered (the process cwd). */
  cwd: string
  /** Logger for diagnostics; never receives credential material. */
  log: Logger
  /** Receives the LLM-relevant facts from this same read, when a caller needs them. */
  collect?: (facts: GrokLlmFacts) => void
}

/** The `[model.<id>]` fields this catalog projects, already narrowed to their types. */
interface GrokModelOverride {
  displayName?: string
  /** Model id sent to the API, when the section sets `model`; the section key is what `-m` accepts. */
  wireModel?: string
  baseUrl?: string
  apiBaseUrl?: string
  envKeys?: readonly string[]
  /** Whether `api_key` is set; the value itself is never retained. */
  hasInlineApiKey?: true
  apiBackend?: string
  modelProvider?: string
  contextWindow?: number
  reasoningEfforts?: readonly string[]
  reasoningEffort?: string
  hidden?: true
}

/** The `[model_providers.<id>]` fields this catalog projects. */
interface GrokModelProvider {
  baseUrl?: string
  apiBaseUrl?: string
  apiBackend?: string
  envKeys?: readonly string[]
  /** Whether `api_key` is set; the value itself is never retained. */
  hasInlineApiKey?: true
}

/** The model-relevant subset of one configuration layer, as merged so far. */
interface GrokCatalogLayer {
  defaultModel?: string
  allowedModels?: readonly string[]
  disabledModels?: readonly string[]
  hiddenModels?: readonly string[]
  modelsBaseUrl?: string
  modelsListUrl?: string
  cliChatProxyBaseUrl?: string
  xaiApiBaseUrl?: string
  /** `[model.<id>]` tables by catalog key. */
  modelOverrides: Map<string, GrokModelOverride>
  /** `[model_providers.<id>]` tables by provider id. */
  modelProviders: Map<string, GrokModelProvider>
  /** Special-purpose `[models]` pins by key, which the canonical catalog has no field for. */
  specialPins: Map<string, string>
}

/** One config file as read: its parsed layer, or why it contributed nothing. */
interface SourceRead {
  present: boolean
  layer?: GrokCatalogLayer
  /** The parsed top-level table, kept for section-presence checks. */
  raw?: Record<string, unknown>
  /** Why it contributed nothing, for the source entry. */
  note?: string
  /** Whether that reason is a parse or read failure worth a declared gap. */
  gap?: true
}

/**
 * Read Grok Build's configured model and provider catalog.
 *
 * @param options - Probe, resolved paths, host environment, project cwd and logger.
 * @returns The catalog; absence and corruption degrade to notes, so this never throws.
 */
export async function readGrokModelCatalog(options: GrokModelReaderOptions): Promise<AgentModelCatalog> {
  const { files, paths, hostEnv, log } = options
  const sources: ModelSourceFile[] = []
  const notes: ProjectionNote[] = []
  const merged: GrokCatalogLayer = {
    modelOverrides: new Map(),
    modelProviders: new Map(),
    specialPins: new Map(),
  }
  notes.push({
    field: 'models',
    reason:
      "grok's authoritative model list is served by the endpoint (`grok models`); MutiAgent reads configuration only and makes no network call, so this catalog is the configured subset",
  })

  const baseTiers = [
    { path: join(SYSTEM_GROK_DIR, 'managed_config.toml'), label: 'system managed config' },
    { path: join(paths.home, 'managed_config.toml'), label: 'fleet managed config' },
    { path: join(paths.home, 'config.toml'), label: 'user config' },
  ]
  for (const tier of baseTiers) {
    await mergeTomlTier({ files, log, merged, notes, sources, path: tier.path, label: tier.label })
  }

  const projectFiles = await projectConfigFiles({
    files,
    cwd: options.cwd,
    home: hostEnv.HOME,
    userConfigPath: join(paths.home, 'config.toml'),
  })
  for (const path of projectFiles) {
    const read = await readTomlSource(files, path, 'full')
    if (read.gap === true) {
      recordSource(sources, notes, log, path, read, 'project config')
      continue
    }
    const carried = read.raw === undefined ? [] : PROJECT_UNREAD_KEYS.filter(key => asRecord(read.raw?.[key]) !== undefined)
    const projectNote =
      read.note ??
      (carried.length === 0
        ? 'a project file contributes only [mcp_servers], [plugins], [permission] and [mcp] max_output_bytes'
        : `grok reads only [mcp_servers], [plugins], [permission] and [mcp] max_output_bytes from a project file; ${carried
            .map(key => `[${key}]`)
            .join(', ')} here is ignored`)
    sources.push({ path, present: read.present, note: projectNote })
    if (carried.length > 0) {
      notes.push({
        field: 'models',
        reason: `${path} sets ${carried.map(key => `[${key}]`).join(', ')}, which grok does not read from a project file`,
      })
    }
  }

  const overlayNotes = await readOverlays({ files, hostEnv, cwd: options.cwd, log, merged, notes, sources })

  const requirementTiers = [
    { path: join(paths.home, 'requirements.toml'), label: 'user requirements' },
    { path: join(SYSTEM_GROK_DIR, 'requirements.toml'), label: 'system requirements' },
  ]
  for (const tier of requirementTiers) {
    await mergeTomlTier({ files, log, merged, notes, sources, path: tier.path, label: tier.label })
  }
  if (process.platform === 'darwin') {
    notes.push({
      field: 'models',
      reason:
        'macOS MDM requirements (ai.x.grok) are device-management preferences rather than a readable config file, so a pinned [models] value there is not in this catalog',
    })
  }

  const store = await readGrokAuthStore({ files, credentialPath: paths.credentialPath })
  sources.push({
    path: paths.credentialPath,
    present: store.present,
    note: 'read only to report credential presence; no credential value is retained',
  })
  if (store.error !== undefined) {
    notes.push({
      field: 'providers',
      reason: `the credential store could not be read (${store.error}); credential presence is reported from the environment only`,
    })
  }
  const authEntry = selectGrokAuthEntry(store.entries)
  const envCredentialNames = GROK_CREDENTIAL_ENV_KEYS.filter(name => nonBlank(hostEnv[name]) !== undefined)
  const storedCredential = authEntry !== undefined && authEntry.hasKey

  const envDefaultModel = nonBlank(hostEnv.GROK_DEFAULT_MODEL)
  const defaultModel = envDefaultModel ?? merged.defaultModel
  if (envDefaultModel !== undefined && merged.defaultModel !== undefined && envDefaultModel !== merged.defaultModel) {
    notes.push({
      field: 'defaultModel',
      reason: `GROK_DEFAULT_MODEL (${envDefaultModel}) overrides the configured default ${merged.defaultModel}`,
    })
  }

  const modelsBaseUrl = merged.modelsBaseUrl ?? nonBlank(hostEnv.GROK_MODELS_BASE_URL)
  const proxyBaseUrl = merged.cliChatProxyBaseUrl ?? nonBlank(hostEnv.GROK_CLI_CHAT_PROXY_BASE_URL)
  const xaiBaseUrl = merged.xaiApiBaseUrl ?? nonBlank(hostEnv.GROK_XAI_API_BASE_URL)
  const baseUrl = modelsBaseUrl ?? proxyBaseUrl ?? xaiBaseUrl ?? GROK_DEFAULT_BASE_URL
  const modelsListUrl =
    merged.modelsListUrl ?? nonBlank(hostEnv.GROK_MODELS_LIST_URL) ?? `${baseUrl.replace(/\/+$/, '')}/models`
  if (modelsBaseUrl !== undefined || merged.modelsListUrl !== undefined) {
    notes.push({
      field: 'providers',
      reason: `a custom model endpoint is configured, so grok lists its models from ${modelsListUrl}; this reader does not fetch it`,
    })
  }

  const providers: AgentProvider[] = [
    {
      id: 'grok',
      baseUrl,
      apiKeyEnv: 'XAI_API_KEY',
      credentialPresent: envCredentialNames.length > 0 || storedCredential,
      source: 'builtin',
    },
  ]
  for (const [id, provider] of sortedEntries(merged.modelProviders)) {
    const providerBaseUrl = provider.baseUrl ?? provider.apiBaseUrl
    const firstEnvKey = provider.envKeys?.[0]
    const envPresent = provider.envKeys !== undefined && provider.envKeys.some(name => nonBlank(hostEnv[name]) !== undefined)
    const credentialKnown = provider.envKeys !== undefined || provider.hasInlineApiKey === true
    providers.push({
      id,
      source: 'config',
      ...(providerBaseUrl === undefined ? {} : { baseUrl: providerBaseUrl }),
      ...(firstEnvKey === undefined ? {} : { apiKeyEnv: firstEnvKey }),
      ...(credentialKnown ? { credentialPresent: envPresent || provider.hasInlineApiKey === true } : {}),
      ...(provider.apiBackend === undefined ? {} : { wireApi: provider.apiBackend }),
    })
  }

  const { models, removedIds, hiddenIds, wireMismatches, outsideAllowlist, globPatterns } = projectModels(
    merged,
    defaultModel,
  )
  if (removedIds.length > 0) {
    notes.push({
      field: 'models',
      reason: `[models].disabled_models removed from the catalog: ${removedIds.join(', ')}`,
    })
  }
  if (hiddenIds.length > 0) {
    notes.push({
      field: 'models',
      reason: `hidden from grok's picker but still selectable with -m: ${hiddenIds.join(', ')}`,
    })
  }
  if (wireMismatches.length > 0) {
    notes.push({
      field: 'models',
      reason: `the wire model id differs from the catalog key for ${wireMismatches.join('; ')}; the catalog key is what \`-m\` accepts`,
    })
  }
  if (outsideAllowlist.length > 0) {
    notes.push({
      field: 'models',
      reason: `kept in the catalog but outside [models].allowed_models, so grok's picker and \`-m\` will not offer them: ${outsideAllowlist.join(', ')}`,
    })
  }
  if (globPatterns.length > 0) {
    notes.push({
      field: 'models',
      reason: `[models].allowed_models contains picker globs rather than literal model ids, so no model row was derived from: ${globPatterns.join(', ')}`,
    })
  }
  if (merged.specialPins.size > 0) {
    notes.push({
      field: 'models',
      reason: `[models] also pins special-purpose models the canonical catalog has no field for: ${[...merged.specialPins]
        .map(([key, value]) => `${key} = ${value}`)
        .join(', ')}`,
    })
  }
  if (overlayNotes.length > 0) {
    notes.push({
      field: 'models',
      reason: `an overlay contributed [models]; ${overlayNotes.join('; ')}`,
    })
  }
  if (!anyConfigured(merged)) {
    notes.push({ field: '*', reason: 'no readable [models] configuration was found; only grok built-in defaults apply' })
  }

  options.collect?.({
    chatProxyBaseUrl:
      merged.cliChatProxyBaseUrl ?? nonBlank(hostEnv.GROK_CLI_CHAT_PROXY_BASE_URL)
      ?? merged.xaiApiBaseUrl ?? nonBlank(hostEnv.GROK_XAI_API_BASE_URL) ?? GROK_DEFAULT_BASE_URL,
    allowedModelIds: (merged.allowedModels ?? []).filter(entry => !isGlobPattern(entry)),
    allowedGlobs: (merged.allowedModels ?? []).filter(entry => isGlobPattern(entry)),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    customModelsEndpoint: merged.modelsBaseUrl !== undefined || nonBlank(hostEnv.GROK_MODELS_BASE_URL) !== undefined,
  })

  return {
    agentId: AGENT_ID,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    providers,
    models,
    sources,
    notes,
    observedAt: new Date().toISOString(),
  }
}

/**
 * Discover `.grok/config.toml` files from the repository root down to the cwd.
 *
 * Mirrors `find_project_configs` in `xai-grok-permission-rules/src/project_config.rs`:
 * the walk stops at a `.git` directory or file; with no repository, only the cwd is
 * probed; the user config is excluded so `cwd == $HOME` is not a project overlay. A
 * home-directory repository is treated as no repository, as grok does.
 *
 * @param options - Probe, starting directory, host home and the user config path to exclude.
 * @returns Existing candidate paths, repository root first.
 */
async function projectConfigFiles(options: {
  files: FileProbe
  cwd: string
  home: string | undefined
  userConfigPath: string
}): Promise<readonly string[]> {
  const start = options.files.resolvePath(options.cwd)
  const dirs: string[] = []
  let current = start
  let gitRoot: string | undefined
  for (let depth = 0; depth < MAX_REPO_WALK; depth += 1) {
    dirs.push(current)
    if ((await options.files.isDirectory(join(current, '.git'))) || (await options.files.isFile(join(current, '.git')))) {
      gitRoot = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const home = options.home === undefined ? undefined : options.files.resolvePath(options.home)
  const chain = gitRoot === undefined || (home !== undefined && gitRoot === home) ? [start] : [...dirs].reverse()
  const found: string[] = []
  for (const dir of chain) {
    const candidate = join(dir, '.grok', 'config.toml')
    if (candidate === options.userConfigPath) continue
    if (await options.files.isFile(candidate)) found.push(candidate)
  }
  return found
}

/** Read one TOML tier, merge it, and record it as a source. */
async function mergeTomlTier(options: {
  files: FileProbe
  log: Logger
  merged: GrokCatalogLayer
  notes: ProjectionNote[]
  sources: ModelSourceFile[]
  path: string
  label: string
}): Promise<void> {
  const read = await readTomlSource(options.files, options.path, 'full')
  recordSource(options.sources, options.notes, options.log, options.path, read, options.label)
  if (read.layer !== undefined) mergeLayer(options.merged, read.layer)
}

/**
 * Read the `GROK_CONFIG` inline JSON overlay and the `GROK_CONFIG_PATH` file overlay.
 *
 * Grok uses the inline value when it parses, falling back to the path candidate
 * otherwise; both are confined by grok to an allowlist whose only model-relevant table
 * is `[models]`. Grok's overlay pipeline additionally expands `$VAR` references and
 * applies `version_overrides` and campaigns, which this reader does not reproduce.
 *
 * @param options - Probe, environment, base directory, logger, merge target and recorders.
 * @returns The overlay-specific caveats to declare, empty when no overlay was used.
 */
async function readOverlays(options: {
  files: FileProbe
  hostEnv: NodeJS.ProcessEnv
  cwd: string
  log: Logger
  merged: GrokCatalogLayer
  notes: ProjectionNote[]
  sources: ModelSourceFile[]
}): Promise<readonly string[]> {
  const { files, hostEnv } = options
  const caveats: string[] = []
  const inline = hostEnv.GROK_CONFIG
  const pathValue = nonBlank(hostEnv.GROK_CONFIG_PATH)
  let used = false

  if (inline !== undefined) {
    const read = readInlineOverlay(inline)
    const recorded = read.note !== undefined ? read : {
      ...read,
      note: 'inline JSON overlay from the environment; not a filesystem path',
    }
    recordSource(options.sources, options.notes, options.log, 'GROK_CONFIG', recorded, 'inline JSON overlay from the environment')
    if (read.layer !== undefined) {
      mergeLayer(options.merged, read.layer)
      used = true
    }
  }
  if (!used && pathValue !== undefined) {
    const path = files.resolvePath(pathValue, options.cwd)
    const read = await readOverlayFile(files, path)
    recordSource(options.sources, options.notes, options.log, path, read, 'overlay file named by GROK_CONFIG_PATH')
    if (read.layer !== undefined) {
      mergeLayer(options.merged, read.layer)
      used = true
    }
  }
  if (used) {
    caveats.push('`$VAR` references are kept verbatim rather than expanded, and version_overrides/campaign patches are not applied')
  }
  return caveats
}

/**
 * Read one TOML config file through the bounded probe and parse its model subset.
 *
 * @param files - Read-only probe.
 * @param path - Absolute file path.
 * @param scope - `full` projects `[models]`, `[model.*]`, `[model_providers.*]` and
 *   `[endpoints]`; `overlay` projects only `[models]`, matching grok's allowlist.
 * @returns What the file contributed; absence and corruption are values, never throws.
 */
async function readTomlSource(files: FileProbe, path: string, scope: 'full' | 'overlay'): Promise<SourceRead> {
  return await readStructuredSource(files, path, scope, text => parseToml(text), 'TOML')
}

/**
 * Read one JSON or TOML file overlay, by extension as grok does.
 *
 * @param files - Read-only probe.
 * @param path - Absolute file path; `.json` selects JSON, anything else TOML.
 * @returns What the file contributed.
 */
async function readOverlayFile(files: FileProbe, path: string): Promise<SourceRead> {
  const isJson = extname(path).toLowerCase() === '.json'
  const read = await readStructuredSource(
    files,
    path,
    'overlay',
    text => (isJson ? JSON.parse(text) : parseToml(text)),
    isJson ? 'JSON' : 'TOML',
  )
  if (read.layer === undefined || read.raw === undefined || overlayUsable(read.raw)) return read
  return { present: true, note: 'no allowlisted table is present, so grok ignores the overlay' }
}

/** Shared bounded read + tolerant parse used by the TOML and overlay file readers. */
async function readStructuredSource(
  files: FileProbe,
  path: string,
  scope: 'full' | 'overlay',
  parse: (text: string) => unknown,
  format: string,
): Promise<SourceRead> {
  const read = await files.readHead(path)
  if (read.missing) return { present: false }
  if (read.truncated) {
    return { present: true, note: 'larger than the adapter read cap; not parsed', gap: true }
  }
  const trimmed = read.text.trim()
  if (trimmed === '') return { present: true, note: 'the file is empty' }
  let parsed: unknown
  try {
    parsed = parse(trimmed)
  } catch (cause) {
    return { present: true, note: `${format} could not be parsed: ${message(cause)}`, gap: true }
  }
  const table = asRecord(parsed)
  if (table === undefined) return { present: true, note: 'the file parses to something other than a table', gap: true }
  return { present: true, raw: table, layer: layerFromTable(table, scope) }
}

/**
 * Whether an overlay survives grok's allowlist at all.
 *
 * Grok reduces an overlay to `models`, `features`, a narrowed `toolset` and a
 * `shell_environment_policy` limited to its filter fields, then discards an overlay
 * that reduced to nothing; this reader checks the four tables' presence and projects
 * only `[models]`.
 *
 * @param table - Parsed overlay object.
 * @returns Whether any allowlisted table is present.
 */
function overlayUsable(table: Record<string, unknown>): boolean {
  return (
    asRecord(table.models) !== undefined ||
    asRecord(table.features) !== undefined ||
    asRecord(table.toolset) !== undefined ||
    asRecord(table.shell_environment_policy) !== undefined
  )
}

/**
 * Parse the `GROK_CONFIG` inline JSON overlay.
 *
 * @param raw - The environment value, verbatim.
 * @returns What the value contributed; an empty value is grok's "unset" state.
 */
function readInlineOverlay(raw: string): SourceRead {
  const trimmed = raw.trim()
  if (trimmed === '') return { present: true, note: 'empty; grok treats an empty GROK_CONFIG as unset' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (cause) {
    return { present: true, note: `JSON could not be parsed: ${message(cause)}`, gap: true }
  }
  const table = asRecord(parsed)
  if (table === undefined) return { present: true, note: 'the value is not a JSON object', gap: true }
  if (!overlayUsable(table)) {
    return { present: true, note: 'no allowlisted table is present, so grok falls through to GROK_CONFIG_PATH' }
  }
  return { present: true, raw: table, layer: layerFromTable(table, 'overlay') }
}

/** Record a read as a source entry, and as a declared gap when it failed to parse. */
function recordSource(
  sources: ModelSourceFile[],
  notes: ProjectionNote[],
  log: Logger,
  path: string,
  read: SourceRead,
  label: string,
): void {
  sources.push({ path, present: read.present, ...(read.note === undefined ? {} : { note: read.note }) })
  if (read.gap === true && read.note !== undefined) {
    log.warn('a grok configuration file could not be read', { path, label, reason: read.note })
    notes.push({ field: 'sources', reason: `${path} (${label}): ${read.note}` })
  }
}

/**
 * Extract the model-relevant subset of one parsed layer.
 *
 * @param table - The parsed top-level table.
 * @param scope - Whether the overlay allowlist applies (see {@link readTomlSource}).
 * @returns The layer as the merge sees it.
 */
function layerFromTable(table: Record<string, unknown>, scope: 'full' | 'overlay'): GrokCatalogLayer {
  const models = asRecord(table.models) ?? {}
  const layer: GrokCatalogLayer = {
    modelOverrides: new Map(),
    modelProviders: new Map(),
    specialPins: new Map(),
  }
  applyModelScalars(layer, models)
  if (scope === 'overlay') return layer

  const overrides = asRecord(table.model) ?? {}
  for (const [id, value] of Object.entries(overrides)) {
    const entry = asRecord(value)
    if (entry !== undefined) layer.modelOverrides.set(id, modelOverrideFromTable(entry))
  }
  const providers = asRecord(table.model_providers) ?? {}
  for (const [id, value] of Object.entries(providers)) {
    const entry = asRecord(value)
    if (entry !== undefined) layer.modelProviders.set(id, modelProviderFromTable(entry))
  }
  const endpoints = asRecord(table.endpoints) ?? {}
  const modelsBaseUrl = nonBlank(endpoints.models_base_url)
  if (modelsBaseUrl !== undefined) layer.modelsBaseUrl = modelsBaseUrl
  const modelsListUrl = nonBlank(endpoints.models_list_url) ?? nonBlank(endpoints.models_endpoint)
  if (modelsListUrl !== undefined) layer.modelsListUrl = modelsListUrl
  const cliChatProxyBaseUrl = nonBlank(endpoints.cli_chat_proxy_base_url)
  if (cliChatProxyBaseUrl !== undefined) layer.cliChatProxyBaseUrl = cliChatProxyBaseUrl
  const xaiApiBaseUrl = nonBlank(endpoints.xai_api_base_url)
  if (xaiApiBaseUrl !== undefined) layer.xaiApiBaseUrl = xaiApiBaseUrl
  return layer
}

/** Copy the `[models]` scalars this catalog reads onto a layer. */
function applyModelScalars(layer: GrokCatalogLayer, models: Record<string, unknown>): void {
  const defaultModel = nonBlank(models.default)
  if (defaultModel !== undefined) layer.defaultModel = defaultModel
  const allowedModels = stringList(models.allowed_models)
  if (allowedModels !== undefined) layer.allowedModels = allowedModels
  const disabledModels = stringList(models.disabled_models)
  if (disabledModels !== undefined) layer.disabledModels = disabledModels
  const hiddenModels = stringList(models.hidden_models)
  if (hiddenModels !== undefined) layer.hiddenModels = hiddenModels
  for (const key of SPECIAL_MODEL_PINS) {
    const pin = nonBlank(models[key])
    if (pin !== undefined) layer.specialPins.set(key, pin)
  }
}

/** Project the `[model.<id>]` fields this catalog reads; every other key is dropped. */
function modelOverrideFromTable(table: Record<string, unknown>): GrokModelOverride {
  const override: GrokModelOverride = {}
  const displayName = nonBlank(table.name)
  if (displayName !== undefined) override.displayName = displayName
  const wireModel = nonBlank(table.model)
  if (wireModel !== undefined) override.wireModel = wireModel
  const baseUrl = nonBlank(table.base_url)
  if (baseUrl !== undefined) override.baseUrl = baseUrl
  const apiBaseUrl = nonBlank(table.api_base_url)
  if (apiBaseUrl !== undefined) override.apiBaseUrl = apiBaseUrl
  const envKeys = envKeyNames(table.env_key)
  if (envKeys !== undefined) override.envKeys = envKeys
  if (nonBlank(table.api_key) !== undefined) override.hasInlineApiKey = true
  const apiBackend = nonBlank(table.api_backend)
  if (apiBackend !== undefined) override.apiBackend = apiBackend
  const modelProvider = nonBlank(table.model_provider)
  if (modelProvider !== undefined) override.modelProvider = modelProvider
  const contextWindow = positiveWhole(table.context_window)
  if (contextWindow !== undefined) override.contextWindow = contextWindow
  const efforts = reasoningEffortValues(table.reasoning_efforts)
  if (efforts !== undefined) override.reasoningEfforts = efforts
  const effort = nonBlank(table.reasoning_effort)
  if (effort !== undefined) override.reasoningEffort = effort
  if (table.hidden === true) override.hidden = true
  return override
}

/** Project the `[model_providers.<id>]` fields this catalog reads. */
function modelProviderFromTable(table: Record<string, unknown>): GrokModelProvider {
  const provider: GrokModelProvider = {}
  const baseUrl = nonBlank(table.base_url)
  if (baseUrl !== undefined) provider.baseUrl = baseUrl
  const apiBaseUrl = nonBlank(table.api_base_url)
  if (apiBaseUrl !== undefined) provider.apiBaseUrl = apiBaseUrl
  const apiBackend = nonBlank(table.api_backend)
  if (apiBackend !== undefined) provider.apiBackend = apiBackend
  const envKeys = envKeyNames(table.env_key)
  if (envKeys !== undefined) provider.envKeys = envKeys
  if (nonBlank(table.api_key) !== undefined) provider.hasInlineApiKey = true
  return provider
}

/** Merge a higher-precedence layer over the accumulated one; leaves win, tables merge. */
function mergeLayer(target: GrokCatalogLayer, layer: GrokCatalogLayer): void {
  if (layer.defaultModel !== undefined) target.defaultModel = layer.defaultModel
  if (layer.allowedModels !== undefined) target.allowedModels = layer.allowedModels
  if (layer.disabledModels !== undefined) target.disabledModels = layer.disabledModels
  if (layer.hiddenModels !== undefined) target.hiddenModels = layer.hiddenModels
  if (layer.modelsBaseUrl !== undefined) target.modelsBaseUrl = layer.modelsBaseUrl
  if (layer.modelsListUrl !== undefined) target.modelsListUrl = layer.modelsListUrl
  if (layer.cliChatProxyBaseUrl !== undefined) target.cliChatProxyBaseUrl = layer.cliChatProxyBaseUrl
  if (layer.xaiApiBaseUrl !== undefined) target.xaiApiBaseUrl = layer.xaiApiBaseUrl
  for (const [id, override] of layer.modelOverrides) {
    target.modelOverrides.set(id, { ...(target.modelOverrides.get(id) ?? {}), ...override })
  }
  for (const [id, provider] of layer.modelProviders) {
    target.modelProviders.set(id, { ...(target.modelProviders.get(id) ?? {}), ...provider })
  }
  for (const [key, value] of layer.specialPins) target.specialPins.set(key, value)
}

/** Whether any configuration layer contributed a model-relevant value. */
function anyConfigured(layer: GrokCatalogLayer): boolean {
  return (
    layer.defaultModel !== undefined ||
    layer.allowedModels !== undefined ||
    layer.disabledModels !== undefined ||
    layer.hiddenModels !== undefined ||
    layer.modelOverrides.size > 0 ||
    layer.modelProviders.size > 0
  )
}

/**
 * Project the merged layer onto canonical models.
 *
 * @param merged - The merged model-relevant configuration.
 * @param defaultModel - The effective default, after `GROK_DEFAULT_MODEL`.
 * @returns The models plus the ids each declared loss is about.
 */
function projectModels(
  merged: GrokCatalogLayer,
  defaultModel: string | undefined,
): {
  models: readonly AgentModel[]
  removedIds: readonly string[]
  hiddenIds: readonly string[]
  wireMismatches: readonly string[]
  outsideAllowlist: readonly string[]
  globPatterns: readonly string[]
} {
  const disabled = new Set(merged.disabledModels ?? [])
  const byId = new Map<string, AgentModel>()
  const removed = new Set<string>()
  const hiddenIds: string[] = []
  const wireMismatches: string[] = []
  const outsideAllowlist: string[] = []
  const globPatterns: string[] = []

  for (const [id, override] of sortedEntries(merged.modelOverrides)) {
    if (disabled.has(id) || (override.wireModel !== undefined && disabled.has(override.wireModel))) {
      removed.add(id)
      continue
    }
    const efforts =
      override.reasoningEfforts ?? (override.reasoningEffort === undefined ? undefined : [override.reasoningEffort])
    byId.set(id, {
      id,
      source: 'config',
      ...(override.displayName === undefined ? {} : { displayName: override.displayName }),
      ...(override.modelProvider === undefined ? {} : { providerId: override.modelProvider }),
      ...(id === defaultModel ? { isDefault: true } : {}),
      ...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
    })
    if (override.hidden === true || (merged.hiddenModels ?? []).includes(id)) hiddenIds.push(id)
    if (override.wireModel !== undefined && override.wireModel !== id) {
      wireMismatches.push(`${id} -> ${override.wireModel}`)
    }
    if (merged.allowedModels !== undefined && !isAllowed(override.wireModel ?? id, id, merged.allowedModels)) {
      outsideAllowlist.push(id)
    }
  }

  const allowlist = merged.allowedModels
  if (allowlist !== undefined) {
    for (const entry of allowlist) {
      // A glob is a picker pattern, not a model id, so it is reported rather than projected.
      if (isGlobPattern(entry)) {
        globPatterns.push(entry)
        continue
      }
      if (disabled.has(entry)) {
        removed.add(entry)
        continue
      }
      if (byId.has(entry)) continue
      byId.set(entry, { id: entry, source: 'config', ...(entry === defaultModel ? { isDefault: true } : {}) })
    }
  }
  if (defaultModel !== undefined && !byId.has(defaultModel) && !disabled.has(defaultModel)) {
    byId.set(defaultModel, { id: defaultModel, source: 'config', isDefault: true })
  }

  const models = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    models,
    removedIds: [...removed].sort(),
    hiddenIds: [...hiddenIds].sort(),
    wireMismatches: [...wireMismatches].sort(),
    outsideAllowlist: [...outsideAllowlist].sort(),
    globPatterns: [...globPatterns].sort(),
  }
}

/** Whether an `allowed_models` entry is a picker glob rather than a literal model id. */
function isGlobPattern(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[')
}

/**
 * Whether a model matches grok's user `allowed_models` patterns.
 *
 * Grok matches globs on the catalog key or the model id, case-sensitively; `*`, `?` and
 * a leading `[...]` class are honoured and every other character is literal.
 *
 * @param wireModel - Model id sent to the API.
 * @param key - Catalog key.
 * @param patterns - Configured `allowed_models` entries.
 * @returns Whether either identifier matches at least one pattern.
 */
function isAllowed(wireModel: string, key: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => globMatches(pattern, wireModel) || globMatches(pattern, key))
}

/** Match one grok `allowed_models` glob against one identifier. */
function globMatches(pattern: string, value: string): boolean {
  let regex = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '*') {
      regex += '.*'
    } else if (char === '?') {
      regex += '.'
    } else if (char === '[') {
      const close = pattern.indexOf(']', index + 1)
      const body = close === -1 ? undefined : pattern.slice(index + 1, close)
      // A negated or malformed class is not a grok pattern this reader understands.
      if (body === undefined || body === '' || body.startsWith('!') || body.startsWith('^')) return pattern === value
      regex += `[${body.replace(/[\\^\]]/g, '\\$&')}]`
      index = close
    } else {
      regex += char === undefined ? '' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    index += 1
  }
  try {
    return new RegExp(`^${regex}$`, 'su').test(value)
  } catch {
    return pattern === value
  }
}

/** Non-empty strings of an array value, or `undefined` when the value is not a non-empty array. */
function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item !== '') items.push(item)
  }
  return items.length === 0 ? undefined : items
}

/** Env variable names from `env_key`: the string or string-array spellings grok accepts. */
function envKeyNames(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string') return value === '' ? undefined : [value]
  return stringList(value)
}

/** Reasoning-effort values from `reasoning_efforts`: bare strings or `{ value = "..." }` tables. */
function reasoningEffortValues(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values: string[] = []
  for (const item of value) {
    const direct = nonBlank(item)
    if (direct !== undefined) {
      values.push(direct)
      continue
    }
    const entry = asRecord(item)
    const nested = entry === undefined ? undefined : nonBlank(entry.value)
    if (nested !== undefined) values.push(nested)
  }
  return values.length === 0 ? undefined : values
}

/** A non-blank string, or `undefined`; every projected string goes through here. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** A positive whole number, or `undefined`. */
function positiveWhole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Map entries ordered by key, so a catalog read is deterministic. */
function sortedEntries<T>(map: ReadonlyMap<string, T>): readonly (readonly [string, T])[] {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/** Message of an arbitrary thrown value. */
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
