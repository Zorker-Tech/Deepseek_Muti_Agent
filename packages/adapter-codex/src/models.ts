/**
 * Codex model and provider catalog reading.
 *
 * Codex keeps no `models` table: its `ConfigToml` names a default `model`, a
 * `review_model`, an optional local `model_catalog_json` and a `[model_providers]` table
 * of user-defined endpoints, and everything else about a model comes from the Codex
 * backend. The honest catalog is therefore exactly what this machine's configuration
 * names, read from the same files Codex reads, in Codex's own precedence order and under
 * Codex's own rules: the user layer, the legacy `[profiles]` selection, the
 * working-directory layer and the `.codex/config.toml` tree are folded in ascending
 * precedence, a project-local layer cannot carry `model_provider`, `model_providers`,
 * `profile` or `profiles` (Codex strips them), and a project layer is applied only for a
 * directory the user layer marks as trusted. A layer this reader does not apply is still
 * reported in `sources` with the reason, never dropped silently.
 *
 * Read-only and secret-free by construction: files are opened through {@link FileProbe},
 * nothing is ever written, a provider's `model_catalog_url` is reported but never
 * fetched (this adapter makes no network calls), and a credential is reported only as
 * the *name* of the environment variable that carries it plus whether that name is set —
 * or whether the Codex auth store holds a credential, which {@link readCodexAuthState}
 * answers without exposing one. A literal value in configuration
 * (`experimental_bearer_token`) is never read, not even to test it.
 *
 * @module @zorker/muti-agent-adapter-codex/models
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { parse, type TomlTable, type TomlValue } from 'smol-toml'

import type {
  AgentId,
  AgentModel,
  AgentModelCatalog,
  AgentProvider,
  ModelSourceFile,
  ProjectionNote,
} from '@zorker/muti-agent-contracts'
import type { FileProbe } from '@zorker/muti-agent-core'

import { readCodexAuthState } from './auth.ts'
import type { CodexHome } from './sessions.ts'

/** Configuration file name Codex reads from its home and from every project layer. */
export const CODEX_CONFIG_FILE = 'config.toml'

/** Directory a project layer lives under, e.g. `<project>/.codex/config.toml`. */
export const CODEX_PROJECT_CONFIG_DIR = '.codex'

/** Suffix of a profile-v2 configuration file, e.g. `work.config.toml`. */
export const CODEX_PROFILE_CONFIG_SUFFIX = '.config.toml'

/**
 * Built-in provider ids of the Codex revision this adapter was verified against
 * (`RESERVED_MODEL_PROVIDER_IDS` and `built_in_model_providers` in
 * `codex-rs/model-provider-info/src/lib.rs`). A `[model_providers]` entry cannot replace
 * one; the two Amazon Bedrock entries accept endpoint and credential overrides only.
 */
export const CODEX_BUILTIN_PROVIDER_IDS: readonly string[] = [
  'openai',
  'lmstudio',
  'ollama',
  'amazon-bedrock',
  'amazon-bedrock-runtime',
]

/** Cap on the bytes read from one configuration file. */
const CONFIG_MAX_BYTES = 1024 * 1024

/** Top-level keys this catalog reads; every other key is declared as unread in `notes`. */
const CATALOG_KEYS: readonly string[] = [
  'model',
  'model_auto_compact_token_limit',
  'model_catalog_json',
  'model_context_window',
  'model_provider',
  'model_providers',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'profile',
  'profiles',
  'projects',
  'review_model',
]

/**
 * Keys Codex strips from a project-local layer before merging it
 * (`PROJECT_LOCAL_CONFIG_DENYLIST` in `codex-rs/config/src/loader/mod.rs`), restricted to
 * the ones this catalog would otherwise project.
 */
const PROJECT_DENIED_KEYS: readonly string[] = ['model_provider', 'model_providers', 'profile', 'profiles']

/** Configured values that select behaviour for a model rather than naming one. */
const UNPROJECTED_SELECTION_KEYS: readonly string[] = [
  'model_auto_compact_token_limit',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
]

/** `ModelProviderInfo` keys the canonical provider has no field for. */
const UNPROJECTED_PROVIDER_KEYS: readonly string[] = [
  'capabilities',
  'env_http_headers',
  'env_key_instructions',
  'http_headers',
  'query_params',
  'request_max_retries',
  'requires_openai_auth',
  'stream_idle_timeout_ms',
  'stream_max_retries',
  'supports_websockets',
  'websocket_connect_timeout_ms',
]

/** Provider keys naming a credential mechanism this adapter never reads or runs. */
const OPAQUE_PROVIDER_AUTH_KEYS: readonly string[] = ['auth', 'aws', 'gateway_oauth']

/** `ModelInfo` keys of a local model catalog the canonical model has no field for. */
const UNPROJECTED_MODEL_INFO_KEYS: readonly string[] = [
  'additional_speed_tiers',
  'description',
  'priority',
  'shell_type',
  'supported_in_api',
  'upgrade',
  'visibility',
]

/** Names listed in one aggregated "unread keys" note before the list is truncated. */
const MAX_LISTED_KEYS = 20

/** The role a configuration file played, which decides how it is folded. */
type LayerKind = 'user' | 'profile' | 'project' | 'local'

/** One parsed configuration layer, in ascending precedence order. */
interface ConfigLayer {
  /** Absolute path of the file the layer came from. */
  readonly path: string
  /** Directory the layer's relative paths resolve against. */
  readonly baseDir: string
  /** Role the layer played in Codex's precedence chain. */
  readonly kind: LayerKind
  /** Parsed table. */
  readonly table: TomlTable
}

/** One project-local configuration file this reader considers, before it is read. */
interface ProjectCandidate {
  /** Absolute path of the candidate file. */
  readonly path: string
  /** Directory whose trust decides whether the file is applied. */
  readonly dir: string
  /** How the applied layer is described in `sources`. */
  readonly role: string
  /** Role the layer would play in the precedence chain. */
  readonly kind: LayerKind
}

/** Outcome of reading one candidate configuration file. */
interface LayerFileRead {
  /** The file as it is reported in `sources`. */
  readonly source: ModelSourceFile
  /** Parsed table, present only when the file was read whole and parsed. */
  readonly table: TomlTable | undefined
}

/** One local model catalog file named by configuration, already projected. */
interface CatalogJsonRead {
  /** The file as it is reported in `sources`. */
  readonly source: ModelSourceFile
  /** Models it declares. */
  readonly models: readonly AgentModel[]
}

/** One provider's credential shape, exactly as its `[model_providers.*]` entry declares it. */
export interface CodexProviderAuthFacts {
  /**
   * The entry declares `requires_openai_auth`, so Codex authenticates it from its
   * own credential store rather than from a variable.
   */
  readonly requiresOpenAiAuth: boolean
  /** The entry carries `experimental_bearer_token`: a credential in configuration, whose value MutiAgent never reads. */
  readonly literalBearerToken: boolean
}

/**
 * One fact this read parses that {@link AgentModelCatalog} has no field for.
 *
 * The canonical catalog is deliberately narrower than Codex's configuration, so a
 * consumer that needs a key the catalog has no home for receives it through
 * {@link CodexModelCatalogRead.onFact} from the same pass over the same layers,
 * rather than parsing the files a second time and risking a different answer.
 */
export type CodexConfigFact =
  | ({ readonly kind: 'provider'; readonly providerId: string } & CodexProviderAuthFacts)
  | { readonly kind: 'selection'; readonly reasoningEffort: string }

/** Everything a catalog read needs. */
export interface CodexModelCatalogRead {
  /** Read-only filesystem helpers. */
  readonly files: FileProbe
  /** Resolved Codex home layout. */
  readonly home: CodexHome
  /** Owning agent id, copied into the catalog. */
  readonly agentId: AgentId
  /** Environment inspected for provider credential variables; defaults to the host process. */
  readonly env?: NodeJS.ProcessEnv
  /**
   * Directory whose working-directory and project layers are read, standing in for the
   * `$PWD` a Codex invocation would use; defaults to the host process's own directory.
   */
  readonly projectDir?: string
  /**
   * Optional consumer of the facts this read parses but the canonical catalog has
   * no field for. Supplying one changes nothing about the catalog or about which
   * files are read: the facts come from this pass. The LLM route projection is the
   * consumer that needs it — `requires_openai_auth` decides whether a Codex route's
   * credential is the auth store, and `model_reasoning_effort` is the route default.
   */
  readonly onFact?: (fact: CodexConfigFact) => void
}

/**
 * Read Codex's model and provider catalog from its own configuration.
 *
 * Never throws: a missing home, an absent file, an unreadable file and a TOML parse
 * failure each degrade to a `sources` note or a declared gap. A `model_catalog_url` is
 * deliberately not fetched — this adapter performs no network I/O — so it is declared in
 * `notes` and the models it would list are absent.
 *
 * @param read - Filesystem helpers, home layout, owning agent id, the environment to
 *   inspect and the directory that stands in for `$PWD`.
 * @returns The catalog; `sources` lists every file consulted in ascending precedence
 *   order and `notes` declares every gap that remains.
 */
export async function readCodexModelCatalog(read: CodexModelCatalogRead): Promise<AgentModelCatalog> {
  const env = read.env ?? process.env
  const projectDir = resolve(read.projectDir ?? process.cwd())
  const observedAt = new Date().toISOString()
  const notes: ProjectionNote[] = []
  const sources: ModelSourceFile[] = []
  const layers: ConfigLayer[] = []
  const unreadKeys = new Set<string>()
  const declared: string[] = []
  let authStoreCredential: Promise<boolean> | undefined

  notes.push({
    field: 'models',
    reason:
      "Codex carries no built-in model list: the ids here are only the ones this machine's configuration names (the `model` and `review_model` keys and any local `model_catalog_json`), so a model Codex would accept but this configuration never mentions cannot appear",
  })
  notes.push({
    field: 'providers',
    reason: `the built-in provider ids (${CODEX_BUILTIN_PROVIDER_IDS.join(', ')}) are reported from Codex's own built-in list rather than from configuration`,
  })

  // The user layer is read first, and only its `[projects]` table decides project trust.
  const userFile = join(read.home.path, CODEX_CONFIG_FILE)
  const user = await readTomlLayer(read.files, userFile)
  let projects: TomlTable | undefined
  let userNote = user.source.note
  if (user.table !== undefined) {
    layers.push({ path: userFile, baseDir: read.home.path, kind: 'user', table: user.table })
    collectUnread(user.table, unreadKeys)
    projects = asTable(user.table['projects'])
    userNote = 'the user layer, the base configuration every Codex run reads'
    const profileName = str(user.table, 'profile')
    if (profileName !== undefined) {
      const profile = asTable(asTable(user.table['profiles'])?.[profileName])
      if (profile !== undefined) {
        layers.push({ path: userFile, baseDir: read.home.path, kind: 'profile', table: profile })
        userNote = `the user layer, with the legacy profile "${profileName}" ([profiles.${profileName}]) applied on top of it`
      } else {
        notes.push({
          field: 'profile',
          reason: `the user layer selects the profile "${profileName}" but carries no [profiles.${profileName}] table; a profile is only read for a run started with --profile ${profileName}`,
        })
      }
    }
  } else if (userNote === undefined) {
    userNote = 'absent, so Codex falls back to its built-in defaults and to any other layer'
  }
  sources.push(userNote === undefined ? { path: userFile, present: user.source.present } : { path: userFile, present: user.source.present, note: userNote })

  for (const profileFile of await profileConfigFiles(read.files, read.home, user.table)) {
    sources.push({
      path: profileFile,
      present: true,
      note: `a profile configuration, read only by a run started with --profile ${profileNameOf(profileFile)}, which listModels cannot know, so its values are not applied here`,
    })
  }

  // The working-directory layer and the ancestor tree, in Codex's order and behind its
  // project trust gate: a project-local layer is applied only for a trusted directory.
  const projectCandidates: ProjectCandidate[] = ancestorDirs(projectDir).map(dir => ({
    path: join(dir, CODEX_PROJECT_CONFIG_DIR, CODEX_CONFIG_FILE),
    dir,
    role: 'the project layer',
    kind: 'project',
  }))
  const candidates: readonly ProjectCandidate[] = [
    { path: join(projectDir, CODEX_CONFIG_FILE), dir: projectDir, role: 'the working-directory layer', kind: 'local' },
    ...projectCandidates,
  ]
  for (const candidate of candidates) {
    // The home is read as the user layer, and Codex skips a `.codex` that is the home.
    if (candidate.path === userFile) continue
    if (candidate.kind === 'project' && dirname(candidate.path) === read.home.path) continue
    const file = await readTomlLayer(read.files, candidate.path)
    if (!file.source.present) continue
    const trust = projectTrustLevel(projects, candidate.dir)
    if (trust !== 'trusted') {
      sources.push({ path: candidate.path, present: true, note: untrustedNote(candidate.dir, trust) })
      if (str(file.table, 'model') !== undefined) {
        notes.push({
          field: 'model',
          reason: `${candidate.path} sets model but the layer is not applied, so the default model below is not necessarily the one Codex would use in that directory`,
        })
      }
      continue
    }
    sources.push({ path: candidate.path, present: true, note: `${candidate.role} for ${candidate.dir}, a trusted project` })
    if (file.table === undefined) continue
    collectUnread(file.table, unreadKeys)
    const denied = PROJECT_DENIED_KEYS.filter(key => file.table?.[key] !== undefined)
    if (denied.length > 0) {
      declared.push(
        `${candidate.path} carries ${denied.join(', ')}, which Codex removes from project-local configuration before merging it, so those keys are ignored here`,
      )
    }
    layers.push({ path: candidate.path, baseDir: candidate.dir, kind: candidate.kind, table: file.table })
  }

  const providerLayers = layers.filter(layer => layer.kind === 'user' || layer.kind === 'profile')
  const defaultModel = effectiveString(layers, 'model')
  const reviewModel = effectiveString(layers, 'review_model')
  const modelProvider = effectiveString(providerLayers, 'model_provider')
  const contextWindow = effectiveNumber(layers, 'model_context_window')
  const credentialPresent = (): Promise<boolean> => {
    authStoreCredential ??= hasAuthStoreCredential(read)
    return authStoreCredential
  }
  const providers = await projectProviders(providerLayers, env, notes, credentialPresent, read.onFact)

  const catalogJson = await readCatalogJson(read.files, layers, notes)
  if (catalogJson !== undefined) sources.push(catalogJson.source)

  const models: AgentModel[] = []
  const indexById = new Map<string, number>()
  const addModel = (model: AgentModel): void => {
    const index = indexById.get(model.id)
    if (index === undefined) {
      indexById.set(model.id, models.length)
      models.push(model)
      return
    }
    const existing = models[index]
    if (existing === undefined) return
    // A duplicate id keeps the first row's identity and gains only what it lacked, so the
    // configured default stays the default when a catalog file names the same model.
    models[index] = {
      ...existing,
      ...(existing.displayName === undefined && model.displayName !== undefined ? { displayName: model.displayName } : {}),
      ...(existing.contextWindow === undefined && model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(existing.reasoningEfforts === undefined && model.reasoningEfforts !== undefined ? { reasoningEfforts: model.reasoningEfforts } : {}),
      ...(existing.providerId === undefined && model.providerId !== undefined ? { providerId: model.providerId } : {}),
    }
  }

  if (defaultModel === undefined) {
    notes.push({
      field: 'defaultModel',
      reason: 'no layer sets `model`, and a built-in default model is recorded in code rather than in configuration, so the model a run without an override would use cannot be named here',
    })
  } else {
    addModel({
      id: defaultModel,
      isDefault: true,
      source: 'config',
      ...(modelProvider === undefined ? {} : { providerId: modelProvider }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    })
    if (modelProvider === undefined) {
      notes.push({
        field: 'providerId',
        reason: 'no layer sets `model_provider`, so the provider serving this model is whichever built-in Codex selects',
      })
    }
  }
  if (reviewModel !== undefined) {
    addModel({ id: reviewModel, source: 'config' })
    notes.push({
      field: 'models',
      reason: `review_model ("${reviewModel}") is the model the review feature runs on; the canonical model has no field for a purpose, so it is listed as one more id the agent accepts`,
    })
  }
  for (const model of catalogJson?.models ?? []) addModel(model)
  if (models.length === 0) {
    notes.push({
      field: 'models',
      reason: 'no layer names a model and no local model catalog is configured, so this machine declares no model id at all',
    })
  }
  const selectionKeys = UNPROJECTED_SELECTION_KEYS.filter(
    key => effectiveString(layers, key) !== undefined || effectiveNumber(layers, key) !== undefined,
  )
  const reasoningEffort = effectiveString(layers, 'model_reasoning_effort')
  if (reasoningEffort !== undefined) read.onFact?.({ kind: 'selection', reasoningEffort })
  if (selectionKeys.length > 0) {
    notes.push({
      field: '*',
      reason: `the configuration also sets ${selectionKeys.join(', ')}, which shape how a model runs rather than naming one, and the canonical catalog has no field for them`,
    })
  }
  if (unreadKeys.size > 0) {
    const names = [...unreadKeys].sort()
    const listed = names.slice(0, MAX_LISTED_KEYS).join(', ')
    const more = names.length > MAX_LISTED_KEYS ? `, and ${String(names.length - MAX_LISTED_KEYS)} more` : ''
    notes.push({ field: '*', reason: `config.toml keys this catalog does not read: ${listed}${more}` })
  }
  for (const reason of declared) notes.push({ field: '*', reason })

  return {
    agentId: read.agentId,
    providers,
    models,
    sources,
    notes,
    observedAt,
    ...(defaultModel === undefined ? {} : { defaultModel }),
  }
}

/**
 * Read and parse one candidate configuration file.
 *
 * A file larger than the cap is deliberately not projected: TOML is line oriented, so a
 * truncated prefix usually parses and would silently misreport whichever values fell
 * past the cap. A missing file and a parse failure are equally calm outcomes.
 *
 * @param files - Read-only filesystem helpers.
 * @param path - Absolute path of the candidate file.
 * @returns The `sources` row for the file, and its table when it was read whole and parsed.
 */
async function readTomlLayer(files: FileProbe, path: string): Promise<LayerFileRead> {
  const head = await files.readHead(path, CONFIG_MAX_BYTES)
  if (head.missing) return { source: { path, present: false, note: 'absent, or present and unreadable' }, table: undefined }
  if (head.truncated) {
    return {
      source: { path, present: true, note: `larger than the ${String(CONFIG_MAX_BYTES)}-byte read cap, so none of it is projected` },
      table: undefined,
    }
  }
  try {
    return { source: { path, present: true }, table: parse(head.text) }
  } catch (cause) {
    return { source: { path, present: true, note: `not valid TOML: ${message(cause)}` }, table: undefined }
  }
}

/**
 * Profile-v2 files under the home.
 *
 * `<name>.config.toml` is read only by a run started with `--profile <name>`, and the SPI
 * carries no profile selection, so these files are reported but never applied.
 *
 * @param files - Read-only filesystem helpers.
 * @param home - Resolved home layout.
 * @param userTable - Parsed user layer, whose `profile` key may name a further file.
 * @returns The paths of the profile files that exist.
 */
async function profileConfigFiles(files: FileProbe, home: CodexHome, userTable: TomlTable | undefined): Promise<readonly string[]> {
  const found = new Set<string>()
  for (const entry of await files.listDir(home.path)) {
    if (entry.isFile && entry.name.endsWith(CODEX_PROFILE_CONFIG_SUFFIX)) found.add(entry.path)
  }
  const selected = userTable === undefined ? undefined : str(userTable, 'profile')
  if (selected !== undefined && !selected.includes('/') && !selected.includes('\\')) {
    const path = join(home.path, `${selected}${CODEX_PROFILE_CONFIG_SUFFIX}`)
    if (!(await files.readHead(path, 1)).missing) found.add(path)
  }
  return [...found].sort()
}

/** The profile name a profile-v2 file path encodes. */
function profileNameOf(path: string): string {
  const name = basename(path)
  return name.slice(0, name.length - CODEX_PROFILE_CONFIG_SUFFIX.length)
}

/** One directory and all of its ancestors, the root first. */
function ancestorDirs(from: string): readonly string[] {
  const dirs: string[] = []
  let current = resolve(from)
  for (;;) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs.reverse()
}

/**
 * The trust level the user layer records for a directory.
 *
 * Codex looks a directory up under the key as written and under its canonical path; this
 * walks upward until an entry matches, which stands in for Codex's project-root and
 * repo-root fallbacks (both of which are ancestors of the directory). Trust recorded in
 * managed configuration is not read here.
 *
 * @param projects - The user layer's `[projects]` table.
 * @param dir - Absolute directory to resolve trust for.
 * @returns The recorded `trust_level`, or `undefined` when no entry covers the directory.
 */
function projectTrustLevel(projects: TomlTable | undefined, dir: string): string | undefined {
  if (projects === undefined) return undefined
  let current = resolve(dir)
  for (;;) {
    const direct = str(asTable(projects[current]), 'trust_level')
    if (direct !== undefined) return direct
    const canonical = canonicalPath(current)
    if (canonical !== undefined && canonical !== current) {
      const resolved = str(asTable(projects[canonical]), 'trust_level')
      if (resolved !== undefined) return resolved
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** The symlink-resolved spelling of a path, or `undefined` when it cannot be resolved. */
function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

/** Why a project-local layer is present but not applied. */
function untrustedNote(dir: string, trust: string | undefined): string {
  return trust === undefined
    ? `present but not applied: Codex loads project-local configuration only for a trusted directory, and the user layer records no trust for ${dir} (add [projects."${dir}"] trust_level = "trusted" to load it); trust from managed configuration is not read here`
    : `present but not applied: ${dir} is marked "${trust}" in the user layer's [projects] table`
}

/**
 * Project a configured provider entry and the built-in ids.
 *
 * @param layers - Layers that may carry `[model_providers]`, in ascending precedence.
 * @param env - Environment inspected by variable name for each provider's `env_key`.
 * @param notes - Notes this projection appends to.
 * @param credentialPresent - Whether the Codex auth store holds a credential.
 * @param onFact - Optional consumer of the auth facts this same pass reads.
 * @returns Configured providers first (sorted by id), then the built-in ids Codex ships.
 */
async function projectProviders(
  layers: readonly ConfigLayer[],
  env: NodeJS.ProcessEnv,
  notes: ProjectionNote[],
  credentialPresent: () => Promise<boolean>,
  onFact: ((fact: CodexConfigFact) => void) | undefined,
): Promise<readonly AgentProvider[]> {
  const configured = new Map<string, TomlTable>()
  for (const layer of layers) {
    const table = asTable(layer.table['model_providers'])
    if (table === undefined) continue
    for (const [id, value] of Object.entries(table)) {
      const entry = asTable(value)
      if (entry === undefined) {
        notes.push({ field: `model_providers.${id}`, reason: 'the entry is not a table' })
        continue
      }
      // Codex merges TOML tables key by key, so a higher layer's entry augments the lower.
      configured.set(id, { ...(configured.get(id) ?? {}), ...entry })
    }
  }
  const providers: AgentProvider[] = []
  for (const id of [...configured.keys()].sort()) {
    const table = configured.get(id)
    if (table === undefined) continue
    if (CODEX_BUILTIN_PROVIDER_IDS.includes(id)) {
      notes.push({
        field: `model_providers.${id}`,
        reason: `${id} is a reserved built-in provider id, and this Codex revision refuses a configuration that declares it (the Amazon Bedrock entries accept endpoint and credential overrides only)`,
      })
    }
    providers.push(await projectProvider(id, table, env, notes, credentialPresent, onFact))
  }
  for (const id of CODEX_BUILTIN_PROVIDER_IDS) {
    if (configured.has(id)) continue
    if (id !== 'openai') {
      providers.push({ id, source: 'builtin' })
      continue
    }
    // Codex's built-in OpenAI provider is `requires_openai_auth: true` with no
    // `env_key` (`create_openai_provider` in model-provider-info), which is the
    // fact a route projection needs to know where its credential comes from.
    providers.push({ id, source: 'builtin', credentialPresent: await credentialPresent() })
    onFact?.({ kind: 'provider', providerId: id, requiresOpenAiAuth: true, literalBearerToken: false })
  }
  return providers
}

/**
 * Project one configured `[model_providers]` entry.
 *
 * The credential is never read: `env_key` contributes its *name* and whether that name is
 * set, a provider that requires OpenAI auth is answered from the auth store, and a
 * literal token in the file is reported as present without its value ever being touched.
 *
 * @param id - The key the entry was declared under.
 * @param table - The entry.
 * @param env - Environment inspected by variable name.
 * @param notes - Notes this projection appends to.
 * @param credentialPresent - Whether the Codex auth store holds a credential.
 * @param onFact - Optional consumer of the auth facts this projection read.
 * @returns The provider row.
 */
async function projectProvider(
  id: string,
  table: TomlTable,
  env: NodeJS.ProcessEnv,
  notes: ProjectionNote[],
  credentialPresent: () => Promise<boolean>,
  onFact: ((fact: CodexConfigFact) => void) | undefined,
): Promise<AgentProvider> {
  const name = str(table, 'name')
  const baseUrl = str(table, 'base_url')
  const envKey = str(table, 'env_key')
  const wireApi = str(table, 'wire_api')
  const catalogUrl = str(table, 'model_catalog_url')
  const requiresOpenAiAuth = table['requires_openai_auth'] === true
  const literalToken = table['experimental_bearer_token'] !== undefined
  const opaqueAuth = OPAQUE_PROVIDER_AUTH_KEYS.filter(key => table[key] !== undefined)
  const unprojected = UNPROJECTED_PROVIDER_KEYS.filter(key => table[key] !== undefined)

  onFact?.({ kind: 'provider', providerId: id, requiresOpenAiAuth, literalBearerToken: literalToken })

  if (catalogUrl !== undefined) {
    notes.push({
      field: `model_providers.${id}.model_catalog_url`,
      reason: `the provider names a model catalog at ${catalogUrl}; this adapter makes no network calls, so it was not fetched and the models it lists are absent`,
    })
  }
  if (literalToken) {
    notes.push({
      field: `model_providers.${id}.experimental_bearer_token`,
      reason: 'the provider carries a literal bearer token in configuration; MutiAgent never reads the value, and Codex itself discourages a token in a file in favour of env_key',
    })
  }
  if (opaqueAuth.length > 0) {
    notes.push({
      field: `model_providers.${id}`,
      reason: `credentials for this provider come from ${opaqueAuth.join(', ')}, a mechanism MutiAgent does not read or run, so credentialPresent says nothing about it`,
    })
  }
  if (wireApi !== undefined && wireApi !== 'responses') {
    notes.push({
      field: `model_providers.${id}.wire_api`,
      reason: `"${wireApi}" is not the "responses" value this Codex revision accepts, so this provider would not load`,
    })
  }
  if (unprojected.length > 0) {
    notes.push({ field: `model_providers.${id}`, reason: `also declares ${unprojected.join(', ')}, which the canonical provider has no field for` })
  }

  let credential: boolean | undefined
  if (envKey !== undefined) credential = (env[envKey] ?? '') !== ''
  else if (requiresOpenAiAuth) credential = await credentialPresent()
  else if (literalToken) credential = true

  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(envKey === undefined ? {} : { apiKeyEnv: envKey }),
    ...(credential === undefined ? {} : { credentialPresent: credential }),
    ...(wireApi === undefined ? {} : { wireApi }),
    source: 'config',
  }
}

/**
 * Project the local model catalog a layer points at, when one is configured.
 *
 * The path is read, not fetched: `model_catalog_json` names a JSON file on this machine,
 * and a relative path resolves against the directory of the file that named it, as it
 * does for Codex. `model_catalog_url` is the network form and is never read.
 *
 * @param files - Read-only filesystem helpers.
 * @param layers - Layers in ascending precedence, the highest one winning the path.
 * @param notes - Notes this projection appends to.
 * @returns The file as a `sources` row and the models it declares, or `undefined` when no
 *   layer configures one.
 */
async function readCatalogJson(files: FileProbe, layers: readonly ConfigLayer[], notes: ProjectionNote[]): Promise<CatalogJsonRead | undefined> {
  const configured = effectiveString(layers, 'model_catalog_json')
  if (configured === undefined) return undefined
  const layer = [...layers].reverse().find(entry => str(entry.table, 'model_catalog_json') !== undefined)
  const path = isAbsolute(configured) ? configured : resolve(layer?.baseDir ?? process.cwd(), configured)
  const parsed = await files.readJson<TomlTable>(path)
  if (!parsed.ok) {
    notes.push({ field: 'model_catalog_json', reason: `${path} could not be read: ${parsed.error}` })
    return { source: { path, present: !parsed.missing, note: 'not projected' }, models: [] }
  }
  const entries = parsed.value['models']
  if (!Array.isArray(entries)) {
    notes.push({ field: 'model_catalog_json', reason: `${path} carries no \`models\` array, so no model id could be projected` })
    return { source: { path, present: true, note: 'not projected' }, models: [] }
  }
  const models: AgentModel[] = []
  const unprojected = new Set<string>()
  let skipped = 0
  for (const entry of entries) {
    const table = asTable(entry)
    const id = str(table, 'slug')
    if (table === undefined || id === undefined) {
      skipped += 1
      continue
    }
    const displayName = str(table, 'display_name')
    const contextWindow = num(table, 'context_window')
    const reasoningEfforts = effortLevels(table['supported_reasoning_levels'])
    for (const key of UNPROJECTED_MODEL_INFO_KEYS) if (table[key] !== undefined) unprojected.add(key)
    models.push({
      id,
      source: 'catalog',
      ...(displayName === undefined ? {} : { displayName }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    })
  }
  if (skipped > 0) {
    notes.push({ field: 'models', reason: `${String(skipped)} of the entries in ${path} carry no \`slug\` and were skipped` })
  }
  if (unprojected.size > 0) {
    notes.push({
      field: 'models',
      reason: `${path} also records ${[...unprojected].sort().join(', ')} for its models, which the canonical model has no field for`,
    })
  }
  return { source: { path, present: true }, models }
}

/** The `effort` values of a local catalog's `supported_reasoning_levels` array. */
function effortLevels(value: TomlValue | undefined): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const levels: string[] = []
  for (const item of value) {
    const effort = str(asTable(item), 'effort')
    if (effort !== undefined) levels.push(effort)
  }
  return levels.length === 0 ? undefined : levels
}

/** The highest-precedence string value of one key across the layers, or `undefined`. */
function effectiveString(layers: readonly ConfigLayer[], key: string): string | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]
    if (layer === undefined) continue
    const value = str(layer.table, key)
    if (value !== undefined) return value
  }
  return undefined
}

/** The highest-precedence finite-number value of one key across the layers, or `undefined`. */
function effectiveNumber(layers: readonly ConfigLayer[], key: string): number | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]
    if (layer === undefined) continue
    const value = num(layer.table, key)
    if (value !== undefined) return value
  }
  return undefined
}

/** Record the top-level keys of one layer that this catalog does not read. */
function collectUnread(table: TomlTable, unread: Set<string>): void {
  for (const key of Object.keys(table)) if (!CATALOG_KEYS.includes(key)) unread.add(key)
}

/** Whether the Codex auth store holds a credential, without exposing one. */
async function hasAuthStoreCredential(read: CodexModelCatalogRead): Promise<boolean> {
  const state = await readCodexAuthState({
    files: read.files,
    home: read.home,
    agentId: read.agentId,
    ...(read.env === undefined ? {} : { env: read.env }),
  })
  return state.status === 'authenticated' || state.status === 'expired'
}

/** A table view of a TOML value, or `undefined` when it is not a table. */
function asTable(value: TomlValue | undefined): TomlTable | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return undefined
  }
  return value
}

/** A non-empty string field of a table. */
function str(table: TomlTable | undefined, key: string): string | undefined {
  const value = table?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A finite number field of a table. */
function num(table: TomlTable | undefined, key: string): number | undefined {
  const value = table?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** An error's message, for a declared gap. */
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
