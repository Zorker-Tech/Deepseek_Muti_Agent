/**
 * OMP's model and provider catalog, read from OMP's own configuration files.
 *
 * OMP resolves the models a machine can actually run from the agent directory's
 * `models.yml` / `models.yaml` — `providers` is the only root key its registry
 * consumes — together with the effective `config.yml` settings (`modelRoles.default`
 * names the startup model, `enabledModels` scopes chat-model selection). This module
 * projects those files onto `AgentModelCatalog` (ADR-0002), read-only and
 * credential-blind: an `apiKey` is classified by the shape OMP's own resolver gives it
 * (`!command`, an exact environment-variable name, or a literal) and never read into
 * the catalog, and `credentialPresent` comes from whether that variable is set or
 * `agent.db` holds a credential row for the provider.
 *
 * What is deliberately not read: OMP's bundled catalog (`@oh-my-pi/pi-catalog`, the
 * built-in provider and model rows plus per-provider policy rules). It is versioned
 * with OMP itself, it is not a user's configuration, and a catalog built from it would
 * describe OMP rather than this machine. The result is therefore the **configured
 * subset** — exactly what a user's own files change — and every read says so in
 * `notes`.
 *
 * Three facts about the file model shape the code:
 *
 * - `models.yml` is read from the **agent directory only** (a named profile's agent
 *   directory in profile mode); OMP documents no project-tier equivalent, so a
 *   `<cwd>/.omp/models.yml` is checked, reported and deliberately not projected.
 *   `config.yml`, by contrast, has a project layer at `<cwd>/.omp/config.yml`, and its
 *   `modelRoles` layer is merged project-over-agent exactly as OMP's own settings do.
 * - A provider entry is either a full custom provider (`models` non-empty, which
 *   requires `baseUrl` and an `apiKey` unless `auth: none`/`oauth`) or an override
 *   (`models` empty) that patches a bundled provider; an override may name providers
 *   and models this reader cannot enumerate, which is reported rather than invented.
 * - A parse failure is a declared gap, never an error: the reader returns whatever else
 *   was recoverable and names the file and the reason in `sources` and `notes`.
 *
 * @module @zorker/muti-agent-adapter-omp/models
 */
import { parse as parseYaml } from 'yaml';
import { readOmpCredentials } from "./auth.js";
import { isRecord, readArray, readBoolean, readNumber, readRecord, readString, resolveOmpStore } from "./sessions.js";
/** OMP's thinking-effort vocabulary, in its own schema's order. */
const OMP_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Provider keys with no canonical field, checked so a configured value is declared, not dropped. */
const UNPROJECTED_PROVIDER_KEYS = [
    'headers',
    'compat',
    'auth',
    'authHeader',
    'disableStrictTools',
    'discovery',
    'guardrailIdentifier',
    'guardrailVersion',
    'guardrailTrace',
    'requestMetadata',
    'remoteCompaction',
    'transport',
    'imageInputDecoder',
    'tokenizer',
    'preferWebsockets',
];
/** Model keys with no canonical field, checked so a configured value is declared, not dropped. */
const UNPROJECTED_MODEL_KEYS = [
    'api',
    'kind',
    'baseUrl',
    'thinking',
    'input',
    'imageInputDecoder',
    'tokenizer',
    'supportsTools',
    'cost',
    'promptCache',
    'premiumMultiplier',
    'contextWindow',
    'maxContextWindow',
    'maxTokens',
    'omitMaxOutputTokens',
    'preferWebsockets',
    'headers',
    'compat',
    'contextPromotionTarget',
    'compactionModel',
    'remoteCompaction',
];
/**
 * Environment credential names OMP's bundled catalog resolves for well-known provider
 * ids (`packages/catalog/src/compat/rules/providers/*.kdl`). Names only; the catalog
 * declares more providers than this curated map, and a `models.yml` `apiKey` always
 * wins over it.
 */
const OMP_PROVIDER_ENV_BY_ID = {
    anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'],
    openai: ['OPENAI_API_KEY'],
    'openai-codex': ['OPENAI_CODEX_OAUTH_TOKEN'],
    azure: ['AZURE_OPENAI_API_KEY'],
    nvidia: ['NVIDIA_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
    deepinfra: ['DEEPINFRA_API_KEY'],
    google: ['GEMINI_API_KEY'],
    'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
    groq: ['GROQ_API_KEY'],
    cerebras: ['CEREBRAS_API_KEY'],
    xai: ['XAI_API_KEY'],
    'xai-oauth': ['XAI_OAUTH_TOKEN'],
    typesafe: ['TYPESAFE_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    'vercel-ai-gateway': ['AI_GATEWAY_API_KEY', 'VERCEL_AI_GATEWAY_API_KEY'],
    zai: ['ZAI_API_KEY'],
    zhipu: ['ZHIPU_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
    minimax: ['MINIMAX_API_KEY'],
    'minimax-cn': ['MINIMAX_CN_API_KEY'],
    'minimax-code': ['MINIMAX_CODE_API_KEY'],
    'minimax-code-cn': ['MINIMAX_CODE_CN_API_KEY'],
    moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    'kimi-code': ['KIMI_CODE_API_KEY'],
    huggingface: ['HF_TOKEN', 'HUGGINGFACE_HUB_TOKEN'],
    fireworks: ['FIREWORKS_API_KEY'],
    together: ['TOGETHER_API_KEY'],
    baseten: ['BASETEN_API_KEY'],
    opencode: ['OPENCODE_API_KEY'],
    'opencode-go': ['OPENCODE_API_KEY'],
    'opencode-zen': ['OPENCODE_API_KEY'],
    meta: ['META_API_KEY', 'MODEL_API_KEY'],
    'cloudflare-workers-ai': ['CLOUDFLARE_API_TOKEN'],
    'cloudflare-ai-gateway': ['CLOUDFLARE_AI_GATEWAY_API_KEY'],
    xiaomi: ['XIAOMI_API_KEY'],
    'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
    'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
    'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
    'qwen-portal': ['QWEN_OAUTH_TOKEN'],
    'alibaba-coding-plan': ['ALIBABA_CODING_PLAN_API_KEY'],
    'github-copilot': ['COPILOT_GITHUB_TOKEN'],
    ollama: ['OLLAMA_API_KEY'],
    'ollama-cloud': ['OLLAMA_CLOUD_API_KEY'],
    'lm-studio': ['LM_STUDIO_API_KEY'],
    vllm: ['VLLM_API_KEY'],
    litellm: ['LITELLM_API_KEY'],
    'bedrock-mantle': ['AWS_BEARER_TOKEN_BEDROCK'],
    // Ambient sources OMP also supports (AWS profiles and IAM keys, Google application
    // default credentials, the Foundry switch) are deliberately absent: they cannot be
    // classified by the presence of one variable.
};
/** The bundled-catalog caveat, present on every catalog this module returns. */
const OMP_BUILTIN_CATALOG_NOTE = {
    field: 'models',
    reason: "OMP's bundled catalog (its built-in providers, model rows and policy rules) is deliberately " +
        'not read: this catalog is the configured subset that models.yml and config.yml declare, which ' +
        "is what a user's own configuration changes",
};
/** Settings with nothing configured. */
const EMPTY_SETTINGS = { scopedEnabledModels: 0, otherRoles: [] };
/** Cap on the bytes read from one YAML configuration file. */
const MAX_YAML_BYTES = 4 * 1024 * 1024;
/**
 * Read OMP's configured model and provider catalog. Read-only, and never throwing for an
 * absent file, a missing agent directory or a malformed `models.yml`: each degrades into a
 * `sources` entry and a {@link ProjectionNote}.
 *
 * @param ctx - Ambient services (logger, runtime config, read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment, project directory and observation time; injected for testability.
 * @returns The catalog of what OMP's own configuration declares on this machine.
 */
export async function readOmpModelCatalog(ctx, agent, options = {}) {
    return (await readOmpModelCatalogWithRoutes(ctx, agent, options)).catalog;
}
/**
 * Read OMP's configuration once, as both the canonical catalog and the provider
 * declarations an LLM route needs.
 *
 * One parse feeds both projections, so a route can never describe an endpoint or a model
 * set that the catalog does not: the same `models.yml` text decides what this machine can
 * run and what the harness may select.
 *
 * @param ctx - Ambient services (logger, runtime config, read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment, project directory and observation time; injected for testability.
 * @returns The catalog plus one declaration per `models.yml` provider.
 */
export async function readOmpModelCatalogWithRoutes(ctx, agent, options = {}) {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now();
    const cwd = ctx.files.resolvePath(options.cwd ?? process.cwd());
    const layout = await resolveOmpStore(ctx, env);
    const draft = {
        providers: [],
        models: [],
        sources: [],
        notes: [OMP_BUILTIN_CATALOG_NOTE],
    };
    let declarations = [];
    const credentials = credentialFactsFrom(await readOmpCredentials(ctx, { env, now }));
    const credentialFile = await ctx.files.fingerprint(layout.credentialPath);
    draft.sources.push({ path: layout.credentialPath, present: credentialFile.size >= 0 });
    const modelsFile = await readYamlFile(ctx, layout.modelsPath);
    draft.sources.push(sourceOf(layout.modelsPath, modelsFile));
    let usedModelsPath = layout.modelsPath;
    let modelsDocument = modelsFile.value;
    if (modelsDocument === undefined) {
        const fallbackPath = `${layout.agentDir}/models.yaml`;
        const fallback = await readYamlFile(ctx, fallbackPath);
        draft.sources.push(sourceOf(fallbackPath, fallback));
        if (fallback.value !== undefined) {
            usedModelsPath = fallbackPath;
            modelsDocument = fallback.value;
        }
    }
    if (modelsDocument !== undefined) {
        declarations = projectModelsFile(draft, modelsDocument, env, credentials);
    }
    else if (modelsFile.error !== undefined) {
        draft.notes.push({
            field: 'providers',
            reason: `${layout.modelsPath} ${modelsFile.error}, so no configured providers or models were read from it`,
        });
    }
    const projectModelsPath = `${cwd}/.omp/models.yml`;
    const projectModels = await readYamlFile(ctx, projectModelsPath);
    draft.sources.push({
        path: projectModelsPath,
        present: projectModels.present,
        note: projectModels.error === undefined
            ? 'present but not projected: OMP reads models.yml from the agent directory only'
            : `present but not projected: OMP reads models.yml from the agent directory only; it also ${projectModels.error}`,
    });
    const agentSettings = await readSettingsFile(ctx, layout.settingsPath, draft);
    const projectSettingsPath = `${cwd}/.omp/config.yml`;
    const projectSettings = await readSettingsFile(ctx, projectSettingsPath, draft);
    const settings = mergeSettings(agentSettings, projectSettings);
    declareSettingsLosses(draft, settings, projectSettingsPath);
    projectDefaultModel(draft, settings, usedModelsPath);
    applyEnabledModels(draft, settings.enabledModels);
    return {
        catalog: {
            agentId: agent,
            ...concreteDefault(settings.defaultRole),
            providers: draft.providers,
            models: draft.models,
            sources: draft.sources,
            notes: draft.notes,
            observedAt: new Date(now).toISOString(),
        },
        declarations,
    };
}
/**
 * Read one YAML file as an object, tolerating absence, truncation and corruption.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param path - Absolute path.
 * @returns Presence, the object when there is one, and why there is not.
 */
async function readYamlFile(ctx, path) {
    const read = await ctx.files.readHead(path, MAX_YAML_BYTES);
    if (read.missing)
        return { present: false };
    if (read.truncated) {
        return { present: true, error: `exceeds the ${MAX_YAML_BYTES}-byte read cap, so it was not parsed` };
    }
    let decoded;
    try {
        decoded = parseYaml(read.text);
    }
    catch (cause) {
        return { present: true, error: `could not be parsed as YAML (${cause instanceof Error ? cause.message : String(cause)})` };
    }
    if (decoded === null || decoded === undefined)
        return { present: true, error: 'holds no document' };
    if (!isRecord(decoded))
        return { present: true, error: 'does not hold a mapping' };
    return { present: true, value: decoded };
}
/**
 * One `sources` row for a file read, carrying its parse failure as the note when there is one.
 *
 * @param path - Absolute path.
 * @param read - The read result.
 * @returns The source file row.
 */
function sourceOf(path, read) {
    return read.error === undefined
        ? { path, present: read.present }
        : { path, present: read.present, note: read.error };
}
/**
 * Read one settings file, project the keys this catalog uses, and register its source row.
 *
 * @param ctx - Ambient services (read-only file helpers).
 * @param path - Absolute settings path.
 * @param draft - Accumulator to fill with the source row.
 * @returns The projected values.
 */
async function readSettingsFile(ctx, path, draft) {
    const read = await readYamlFile(ctx, path);
    draft.sources.push(sourceOf(path, read));
    if (read.value !== undefined)
        return projectSettingsValues(read.value);
    if (read.error === undefined) {
        // `config.yaml` is the documented legacy fallback for the same file.
        const fallbackPath = path.endsWith('.yml') ? `${path.slice(0, -'.yml'.length)}.yaml` : undefined;
        if (fallbackPath !== undefined) {
            const fallback = await readYamlFile(ctx, fallbackPath);
            draft.sources.push(sourceOf(fallbackPath, fallback));
            if (fallback.value !== undefined)
                return projectSettingsValues(fallback.value);
            if (fallback.error !== undefined) {
                draft.notes.push({ field: 'models', reason: `${fallbackPath} ${fallback.error}` });
            }
        }
        return EMPTY_SETTINGS;
    }
    draft.notes.push({ field: 'models', reason: `${path} ${read.error}` });
    return EMPTY_SETTINGS;
}
/**
 * Project the settings keys this catalog reads.
 *
 * @param raw - The decoded settings document.
 * @returns The projected settings.
 */
function projectSettingsValues(raw) {
    const roles = readRecord(raw, 'modelRoles');
    const defaultRole = roles === undefined ? undefined : configuredText(readString(roles, 'default'));
    const others = [];
    if (roles !== undefined) {
        for (const [role, value] of Object.entries(roles)) {
            if (role === 'default')
                continue;
            if (typeof value === 'string' && value !== '')
                others.push(role);
        }
    }
    const patterns = [];
    let scoped = 0;
    for (const entry of readArray(raw, 'enabledModels') ?? []) {
        if (typeof entry === 'string' && entry !== '')
            patterns.push(entry);
        else if (isRecord(entry))
            scoped += 1;
    }
    return {
        ...(defaultRole === undefined ? {} : { defaultRole }),
        ...(patterns.length === 0 ? {} : { enabledModels: patterns }),
        scopedEnabledModels: scoped,
        otherRoles: others,
    };
}
/**
 * Merge project settings over agent-directory settings the way OMP does for `modelRoles`:
 * per key, with the project value winning.
 *
 * @param agentSettings - Values from the agent directory.
 * @param projectSettings - Values from the project tier.
 * @returns The effective values this catalog reads.
 */
function mergeSettings(agentSettings, projectSettings) {
    const defaultRole = projectSettings.defaultRole ?? agentSettings.defaultRole;
    const enabledModels = projectSettings.enabledModels ?? agentSettings.enabledModels;
    const others = new Set([...agentSettings.otherRoles, ...projectSettings.otherRoles]);
    return {
        ...(defaultRole === undefined ? {} : { defaultRole }),
        ...(enabledModels === undefined ? {} : { enabledModels }),
        scopedEnabledModels: agentSettings.scopedEnabledModels + projectSettings.scopedEnabledModels,
        otherRoles: [...others],
    };
}
/**
 * Declare the settings keys that shape how OMP runs a model but have no canonical field.
 *
 * @param draft - Accumulator to fill.
 * @param settings - The effective settings.
 * @param projectSettingsPath - Project settings path, named when the layer contributes.
 */
function declareSettingsLosses(draft, settings, projectSettingsPath) {
    if (settings.defaultRole !== undefined && settings.defaultRole.includes(':')) {
        draft.notes.push({
            field: 'defaultModel',
            reason: 'modelRoles.default carries a `:<thinking>` suffix; AgentModel has no thinking-level field, so ' +
                'the suffix is stripped from the id and only the model is reported',
        });
    }
    const losses = [];
    if (settings.otherRoles.length > 0)
        losses.push(`modelRoles for ${[...settings.otherRoles].sort().join(', ')}`);
    if (losses.length > 0) {
        draft.notes.push({
            field: 'models',
            reason: `config.yml assigns ${losses.join('; ')}, which decides which model runs each workload; ` +
                'AgentModelCatalog describes one default model, so those assignments are not carried',
        });
    }
    if (settings.scopedEnabledModels > 0) {
        draft.notes.push({
            field: '*',
            reason: `${projectSettingsPath} or the agent config declares ${settings.scopedEnabledModels} path-scoped ` +
                'enabledModels entries; a scoped entry applies only under its path prefix, which a catalog ' +
                'read cannot apply, so this catalog was not filtered by them',
        });
    }
}
/**
 * Project a `models.yml` document onto providers and models.
 *
 * @param draft - Accumulator to fill.
 * @param config - The decoded `models.yml` document.
 * @param env - Environment credential references are resolved against.
 * @param credentials - Credential facts observed from `agent.db`.
 * @returns One LLM route declaration per provider entry, in file order.
 */
function projectModelsFile(draft, config, env, credentials) {
    const rawProviders = readRecord(config, 'providers');
    if (rawProviders === undefined) {
        draft.notes.push({
            field: 'providers',
            reason: 'models.yml declares no `providers` mapping, which is the only root key OMP consumes',
        });
        return [];
    }
    if (Object.keys(rawProviders).length === 0) {
        draft.notes.push({ field: 'providers', reason: 'models.yml declares an empty `providers` mapping' });
    }
    const unprojected = { provider: new Set(), model: new Set() };
    const overrideProviders = new Set();
    const declarations = [];
    let malformedProviders = 0;
    let malformedModels = 0;
    let overrideOnly = 0;
    for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
        if (!isRecord(rawProvider)) {
            malformedProviders += 1;
            continue;
        }
        collectPresent(rawProvider, UNPROJECTED_PROVIDER_KEYS, unprojected.provider);
        const name = configuredText(readString(rawProvider, 'name'));
        const baseUrl = configuredText(readString(rawProvider, 'baseUrl'));
        const wireApi = configuredText(readString(rawProvider, 'api'));
        const declaredKey = configuredText(readString(rawProvider, 'apiKey'));
        const credential = projectProviderCredential(providerId, declaredKey, env, credentials, draft.notes);
        draft.providers.push({
            id: providerId,
            ...(name === undefined ? {} : { name }),
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...(credential.apiKeyEnv === undefined ? {} : { apiKeyEnv: credential.apiKeyEnv }),
            credentialPresent: credential.present,
            ...(wireApi === undefined ? {} : { wireApi }),
            source: 'config',
        });
        if (declaredKey !== undefined && readAuthMode(rawProvider) === 'none') {
            draft.notes.push({
                field: 'providers',
                reason: `${providerId}: auth is "none", so the declared apiKey is not used by OMP`,
            });
        }
        const overrides = readRecord(rawProvider, 'modelOverrides') ?? {};
        const declaredHere = new Set();
        const transportOverrides = [];
        for (const definition of readArray(rawProvider, 'models') ?? []) {
            if (!isRecord(definition)) {
                malformedModels += 1;
                continue;
            }
            const modelId = configuredText(readString(definition, 'id'));
            if (modelId === undefined) {
                malformedModels += 1;
                continue;
            }
            collectPresent(definition, UNPROJECTED_MODEL_KEYS, unprojected.model);
            const rawOverride = overrides[modelId];
            if (rawOverride !== undefined && !isRecord(rawOverride))
                malformedModels += 1;
            const patch = isRecord(rawOverride) ? rawOverride : undefined;
            if (patch !== undefined)
                collectPresent(patch, UNPROJECTED_MODEL_KEYS, unprojected.model);
            const projected = projectModel(modelId, providerId, definition, patch, 'config');
            draft.models.push(projected);
            declaredHere.add(modelId);
            // A per-model `api` or `baseUrl` sends that model somewhere this route cannot
            // follow, so it is refused rather than requested over the provider's endpoint.
            if (configuredText(readString(definition, 'api')) !== undefined ||
                configuredText(readString(definition, 'baseUrl')) !== undefined) {
                transportOverrides.push(modelId);
            }
        }
        for (const [modelId, rawOverride] of Object.entries(overrides)) {
            if (declaredHere.has(modelId))
                continue;
            if (!isRecord(rawOverride)) {
                malformedModels += 1;
                continue;
            }
            collectPresent(rawOverride, UNPROJECTED_MODEL_KEYS, unprojected.model);
            draft.models.push(projectModel(modelId, providerId, undefined, rawOverride, 'catalog'));
            overrideOnly += 1;
            overrideProviders.add(providerId);
        }
        declarations.push({
            providerId,
            ...(wireApi === undefined ? {} : { api: wireApi }),
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...headersOf(rawProvider),
            credential: declaredCredentialShape(providerId, declaredKey, env, draft.notes),
            modelIds: [...declaredHere],
            transportOverrides,
        });
    }
    if (malformedProviders > 0) {
        draft.notes.push({
            field: 'providers',
            reason: `${malformedProviders} providers entries are not mappings and were skipped here; OMP validates the file and rejects an invalid one`,
        });
    }
    if (malformedModels > 0) {
        draft.notes.push({
            field: 'models',
            reason: `${malformedModels} models entries were skipped here (a non-mapping entry, a model with no id, or a malformed modelOverrides value)`,
        });
    }
    if (overrideOnly > 0) {
        draft.notes.push({
            field: 'models',
            reason: `${overrideOnly} modelOverrides ${overrideOnly === 1 ? 'entry' : 'entries'} under ` +
                `${[...overrideProviders].join(', ')} ${overrideOnly === 1 ? 'names a model' : 'name models'} this ` +
                "reader cannot enumerate, because OMP's bundled catalog is deliberately not read; " +
                `${overrideOnly === 1 ? 'it is listed' : 'they are listed'} with only the metadata the override ` +
                'itself declares',
        });
    }
    if (unprojected.provider.size > 0) {
        draft.notes.push({
            field: 'providers',
            reason: `provider keys with no canonical field are configured and not carried: ${[...unprojected.provider].sort().join(', ')}`,
        });
    }
    if (unprojected.model.size > 0) {
        draft.notes.push({
            field: 'models',
            reason: `model keys with no canonical field are configured and not carried: ${[...unprojected.model].sort().join(', ')}`,
        });
    }
    return declarations;
}
/** The `auth` mode a provider entry declares, when it declares one. */
function readAuthMode(rawProvider) {
    return configuredText(readString(rawProvider, 'auth'));
}
/**
 * The headers a provider entry declares, as string entries.
 *
 * A declared value may be a credential in itself (a gateway's own key header), and OMP
 * resolves a `!command` value at request time; a command value is carried verbatim to
 * the request decision and never executed here.
 *
 * @param rawProvider - The provider entry.
 * @returns The headers, or nothing when the entry declares none.
 */
function headersOf(rawProvider) {
    const raw = readRecord(rawProvider, 'headers');
    if (raw === undefined)
        return {};
    const headers = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string')
            headers[key] = value;
    }
    return Object.keys(headers).length === 0 ? {} : { headers };
}
/**
 * Classify one provider's `apiKey` for the LLM route and declare its gaps.
 *
 * OMP's resolver treats a value that does not start with `!` as an **exact
 * environment-variable name** and falls back to the value itself when no variable of
 * that name is set — so an unset name is a literal that will be sent as a bearer key,
 * which the note says. A provider that declares no key still gets the ambient variable
 * OMP's bundled catalog reads for well-known ids.
 *
 * @param providerId - Provider id, verbatim.
 * @param apiKey - The declared `apiKey`, when there is one.
 * @param env - Environment the exact-name lookup resolves against.
 * @param notes - Accumulator for declared gaps.
 * @returns The credential shape, with the value present only for a literal.
 */
function declaredCredentialShape(providerId, apiKey, env, notes) {
    if (apiKey === undefined) {
        const ambient = OMP_PROVIDER_ENV_BY_ID[providerId]?.[0];
        return ambient === undefined ? { kind: 'none' } : { kind: 'env', names: [ambient] };
    }
    if (apiKey.startsWith('!')) {
        return { kind: 'command' };
    }
    if (ENV_NAME.test(apiKey)) {
        if (isSet(env, apiKey))
            return { kind: 'env', names: [apiKey] };
        notes.push({
            field: 'providers',
            reason: `${providerId}: models.yml declares apiKey ${apiKey}, which is not set in this environment; OMP ` +
                'falls back to the literal string, so that is what the declaration is treated as',
        });
        return { kind: 'literal', value: apiKey };
    }
    return { kind: 'literal', value: apiKey };
}
/**
 * Decide one provider's credential facts from its `apiKey` and the observed store.
 *
 * The declared value is inspected only for its shape. A literal or `!command` value is
 * never read into the catalog and the command is never run; only the fact that a
 * credential is declared is reported.
 *
 * @param providerId - Provider id, verbatim.
 * @param apiKey - The declared `apiKey`, when models.yml declares one.
 * @param env - Environment credential references are resolved against.
 * @param credentials - Credential facts observed from `agent.db`.
 * @param notes - Accumulator for declared gaps.
 * @returns The environment variable name, when one is referenced, and whether a credential exists.
 */
function projectProviderCredential(providerId, apiKey, env, credentials, notes) {
    const stored = credentials.stored.has(providerId);
    if (apiKey === undefined) {
        const known = OMP_PROVIDER_ENV_BY_ID[providerId]?.[0];
        return {
            ...(known === undefined ? {} : { apiKeyEnv: known }),
            present: (known !== undefined && isSet(env, known)) || stored,
        };
    }
    if (apiKey.startsWith('!')) {
        notes.push({
            field: 'providers',
            reason: `${providerId}: models.yml declares a \`!command\` apiKey; the command is never read or run, and ` +
                'only the fact that a credential is declared is reported',
        });
        return { present: true };
    }
    if (ENV_NAME.test(apiKey)) {
        const set = isSet(env, apiKey);
        if (!set) {
            notes.push({
                field: 'providers',
                reason: `${providerId}: the apiKey names ${apiKey}, which is not set in this environment; OMP sends the ` +
                    'name itself as the key in that case',
            });
        }
        return { apiKeyEnv: apiKey, present: set || stored };
    }
    notes.push({
        field: 'providers',
        reason: `${providerId}: models.yml declares a literal apiKey; its value is never read into the catalog, ` +
            'only reported as declared',
    });
    return { present: true };
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
function projectModel(id, providerId, definition, patch, source) {
    const from = definition ?? {};
    const over = patch ?? {};
    const displayName = configuredText(readString(over, 'name')) ?? configuredText(readString(from, 'name'));
    const contextWindow = positiveNumber(over, 'contextWindow') ?? positiveNumber(from, 'contextWindow');
    const reasoning = readBoolean(over, 'reasoning') ?? readBoolean(from, 'reasoning');
    const efforts = declaredEfforts(from) ?? declaredEfforts(over);
    // `reasoningEfforts` is reported only when the configuration says something about
    // thinking: a model that says nothing is not guessed at, and `reasoning: true` without
    // an effort list leaves the level set to bundled catalog metadata this reader skips.
    const levels = efforts ?? (reasoning === false ? ['off'] : undefined);
    return {
        id,
        ...(displayName === undefined ? {} : { displayName }),
        providerId,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(levels === undefined ? {} : { reasoningEfforts: levels }),
        source,
    };
}
/** The `thinking.efforts` a model entry declares, when it declares any. */
function declaredEfforts(entry) {
    const thinking = readRecord(entry, 'thinking');
    if (thinking === undefined)
        return undefined;
    const efforts = (readArray(thinking, 'efforts') ?? []).filter((effort) => typeof effort === 'string' && effort !== '');
    return efforts.length === 0 ? undefined : efforts;
}
/**
 * Apply the saved default model to the projected list.
 *
 * `modelRoles.default` is a selector: a concrete `provider/model`, a bare model id, a
 * role alias (`@smol`), a comma-separated list, or `*` for the automatic choice. Only a
 * concrete selector can name a catalog entry; the others are declared as gaps.
 *
 * @param draft - Accumulator to fill.
 * @param settings - The effective settings.
 * @param modelsSourcePath - The file the model entries came from, for the note.
 */
function projectDefaultModel(draft, settings, modelsSourcePath) {
    const selector = settings.defaultRole;
    if (selector === undefined)
        return;
    if (selector.startsWith('@') || selector === '*' || selector.includes(',')) {
        draft.notes.push({
            field: 'defaultModel',
            reason: `modelRoles.default is "${selector}", a role alias, the automatic choice, or a selector list; ` +
                'the model it resolves to is chosen at runtime and is not declared here',
        });
        return;
    }
    const reference = parseSelector(selector);
    if (reference === undefined) {
        draft.notes.push({
            field: 'defaultModel',
            reason: `modelRoles.default is "${selector}", which this reader could not read as a model selector`,
        });
        return;
    }
    const index = draft.models.findIndex(model => model.id === reference.id && (reference.providerId === undefined || model.providerId === reference.providerId));
    if (index !== -1) {
        const found = draft.models[index];
        if (found === undefined)
            return;
        draft.models[index] = { ...found, isDefault: true };
        return;
    }
    draft.models.push({
        id: reference.id,
        ...(reference.providerId === undefined ? {} : { providerId: reference.providerId }),
        isDefault: true,
        source: 'config',
    });
    const where = reference.providerId === undefined ? 'without a provider prefix' : `under provider ${reference.providerId}`;
    draft.notes.push({
        field: 'defaultModel',
        reason: `modelRoles.default names ${reference.id} ${where}, which ${modelsSourcePath} does not declare, so only ` +
            "its id is known here; OMP resolves the rest against its bundled catalog",
    });
}
/**
 * Parse one concrete model selector: `provider/model`, or a bare model id after an
 * optional `:<thinking>` suffix is stripped.
 *
 * OMP resolves selectors with exact ids, globs and fuzzy matching; this reader accepts
 * the concrete `provider/model` and bare-id forms only, because a fuzzy pattern names no
 * single model to project.
 *
 * @param selector - The configured selector.
 * @returns The reference, or `undefined` when it is not a concrete selector.
 */
function parseSelector(selector) {
    const base = stripThinkingSuffix(selector.trim());
    if (base === '' || /[*?[]/.test(base))
        return undefined;
    const slash = base.indexOf('/');
    if (slash <= 0 || slash === base.length - 1)
        return { id: base };
    const providerId = base.slice(0, slash);
    if (!/^[A-Za-z0-9._-]+$/.test(providerId))
        return { id: base };
    return { id: base.slice(slash + 1), providerId };
}
/**
 * The catalog's `defaultModel` field for a configured selector: a concrete one is
 * reported by id, and an alias or pattern is left to the note instead of being shown as a
 * model id.
 *
 * @param selector - `modelRoles.default`, when it is configured.
 * @returns The field, or nothing.
 */
function concreteDefault(selector) {
    if (selector === undefined)
        return {};
    const reference = parseSelector(selector);
    return reference === undefined ? {} : { defaultModel: reference.id };
}
/**
 * Remove a trailing `:<thinking>` suffix, keeping any other colon (a model id such as
 * `qwen2.5-coder:7b` keeps its tag).
 *
 * @param selector - The selector as configured.
 * @returns The selector without a recognized thinking suffix.
 */
function stripThinkingSuffix(selector) {
    const colon = selector.lastIndexOf(':');
    if (colon <= 0)
        return selector;
    const suffix = selector.slice(colon + 1);
    const known = OMP_EFFORT_LEVELS.includes(suffix) || suffix === 'off' || suffix === 'auto' || suffix === 'inherit';
    return known ? selector.slice(0, colon) : selector;
}
/**
 * Apply `enabledModels`, the scope OMP puts on chat-model selection and cycling.
 *
 * The scope is a filter over the models this catalog knows, so an excluded id is not an
 * unavailable model; the notes say so, because OMP still accepts an id passed explicitly.
 *
 * @param draft - Accumulator to fill.
 * @param patterns - The configured string patterns, when there are any.
 */
function applyEnabledModels(draft, patterns) {
    if (patterns === undefined)
        return;
    const before = draft.models.length;
    const kept = draft.models.filter(model => patterns.some(pattern => matchesModelPattern(pattern, model)));
    draft.models = kept;
    draft.notes.push({
        field: 'models',
        reason: 'config.yml `enabledModels` scopes chat-model selection and cycling, so this list is that scope as ' +
            'far as it can be read here; a pattern that also names bundled models matches more than this list',
    });
    if (before > 0 && kept.length === 0) {
        draft.notes.push({
            field: 'models',
            reason: `none of the ${before} configured models matches enabledModels (${patterns.join(', ')}), which most ` +
                "likely names models from OMP's bundled catalog that this reader deliberately does not enumerate",
        });
        return;
    }
    const dropped = before - kept.length;
    if (dropped > 0) {
        draft.notes.push({
            field: 'models',
            reason: `${dropped} configured ${dropped === 1 ? 'model is' : 'models are'} not enabled by enabledModels; ` +
                'OMP still accepts an excluded id passed explicitly, so this list is the enabled scope, not ' +
                'everything OMP accepts',
        });
    }
}
/**
 * Whether one `enabledModels` pattern matches a model.
 *
 * OMP resolves these with exact selectors, globs and fuzzy matches against the
 * `provider/model` selector and the bare id, after stripping an optional `:<thinking>`
 * suffix. Exact ids and globs (`*`, `?`, `[…]`) are reproduced; a fuzzy partial name is
 * not, and the caller's notes say when nothing matched.
 *
 * @param pattern - One configured pattern.
 * @param model - Model reference to test.
 * @returns Whether the pattern matches.
 */
function matchesModelPattern(pattern, model) {
    const base = stripThinkingSuffix(pattern.trim());
    if (base === '')
        return false;
    const references = model.providerId === undefined ? [model.id] : [`${model.providerId}/${model.id}`, model.id];
    if (!/[*?[]/.test(base)) {
        return references.some(reference => reference.toLowerCase() === base.toLowerCase());
    }
    const expression = globExpression(base);
    return references.some(reference => expression.test(reference));
}
/**
 * Compile the `*`, `?` and `[…]` subset of OMP's pattern syntax for case-insensitive matching.
 *
 * @param pattern - A pattern that contains a glob character.
 * @returns The expression to test references with.
 */
function globExpression(pattern) {
    let expression = '';
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === '*') {
            expression += '.*';
            continue;
        }
        if (character === '?') {
            expression += '.';
            continue;
        }
        if (character === '[') {
            const end = pattern.indexOf(']', index + 1);
            if (end !== -1) {
                expression += `[${pattern.slice(index + 1, end)}]`;
                index = end;
                continue;
            }
        }
        expression += (character ?? '').replace(/[.*+?^${}()|[\]\\]/, '\\$&');
    }
    return new RegExp(`^${expression}$`, 'i');
}
/**
 * Reduce the classified credential rows to the one question the catalog asks.
 *
 * @param credentials - Stored credentials as auth.ts classified them.
 * @returns The providers with a stored credential, disabled rows included.
 */
function credentialFactsFrom(credentials) {
    const stored = new Set();
    for (const credential of credentials)
        stored.add(credential.provider);
    return { stored };
}
/**
 * Record which of the keys a projection cannot carry the configuration actually sets.
 *
 * @param source - The configuration object.
 * @param keys - Keys with no canonical field.
 * @param into - Accumulator for the keys seen.
 */
function collectPresent(source, keys, into) {
    for (const key of keys)
        if (Object.hasOwn(source, key))
            into.add(key);
}
/** A configuration string that is an environment-variable name by OMP's own rule. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Whether an environment variable carries a value.
 *
 * @param env - Environment to read, as a name lookup only; the value never leaves this check.
 * @param name - Variable name.
 * @returns `true` when the variable is set to a non-empty value.
 */
function isSet(env, name) {
    const value = env[name];
    return value !== undefined && value !== '';
}
/**
 * A configured string with content.
 *
 * @param value - The value as read.
 * @returns The value, or `undefined` when it is empty or absent.
 */
function configuredText(value) {
    return value === undefined || value === '' ? undefined : value;
}
/**
 * A positive token count, so OMP's `contextWindow` positivity rule is respected.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The value, or `undefined` when absent, non-numeric or not positive.
 */
function positiveNumber(source, key) {
    const value = readNumber(source, key);
    return value === undefined || value <= 0 ? undefined : value;
}
//# sourceMappingURL=models.js.map