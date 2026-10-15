/**
 * OMP credential inspection and the delegated credential operations.
 *
 * Status is read-only and store-first: OMP keeps credentials in the SQLite database
 * `<agent-dir>/agent.db` — the table `auth_credentials(provider, credential_type,
 * data, disabled_cause, identity_key, created_at, updated_at)` (verified against
 * oh-my-pi 18.11.0, `packages/ai/src/auth/sqlite-credential-store.ts`) — and a
 * provider key can also come from the host environment. The database is opened
 * through `node:sqlite`'s `DatabaseSync` in **read-only** mode; the query selects
 * `provider`, `credential_type` and `disabled_cause` only, and no secret field of
 * `data` (the `key` of an `api_key` row, the `access`/`refresh` pair of an `oauth`
 * row) is ever selected, logged or projected. The one non-secret value read out of
 * `data` is an OAuth row's `expires` timestamp, extracted by SQLite itself, because
 * expired-versus-usable is the difference between two statuses.
 *
 * `omp login [provider]` is a real subcommand (the terminal counterpart of `/login`):
 * an interactive OAuth flow over stdin with no provider, secret or non-interactive
 * flag. Login therefore delegates to it, bounded, and reports the CLI's own outcome
 * plus the guidance a human needs; an `api-key` flow has no CLI counterpart at all.
 * **There is no `omp logout` subcommand** — logout exists as the TUI `/logout`, the
 * RPC `logout` command, and `omp auth-broker logout` for a broker-backed vault — so
 * this adapter declares `logout: false` and returns guidance instead of running a
 * command that does not exist. `omp token <provider>` and `omp auth export` print
 * secret material and are deliberately never called.
 *
 * @module @zorker/muti-agent-adapter-omp/auth
 */
import { DatabaseSync } from 'node:sqlite';
import { resolveOmpStore } from "./sessions.js";
/**
 * Credential-shaped environment variables OMP resolves a provider key from, taken
 * from the bundled catalog's per-provider `env` declarations
 * (`packages/catalog/src/compat/rules/providers/*.kdl`). Names only; values are never
 * read into a projection.
 *
 * The bundled catalog declares more providers than this list, and a `models.yml`
 * provider may name its own variable in `apiKey`, which is always the authoritative
 * per-machine answer; this list is the common subset used to answer "is any provider
 * key set at all" and to recognize the ambient variable of a well-known provider id.
 *
 * Ambient sources OMP also supports (AWS IAM profiles and bearer tokens, Google
 * Application Default Credentials, the Foundry switch) are deliberately absent: they
 * cannot be classified by the presence of one variable.
 */
export const OMP_PROVIDER_ENV_VARS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_CODEX_OAUTH_TOKEN',
    'AZURE_OPENAI_API_KEY',
    'NVIDIA_API_KEY',
    'DEEPSEEK_API_KEY',
    'DEEPINFRA_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_CLOUD_API_KEY',
    'GROQ_API_KEY',
    'CEREBRAS_API_KEY',
    'XAI_API_KEY',
    'XAI_OAUTH_TOKEN',
    'TYPESAFE_API_KEY',
    'OPENROUTER_API_KEY',
    'AI_GATEWAY_API_KEY',
    'VERCEL_AI_GATEWAY_API_KEY',
    'ZAI_API_KEY',
    'ZHIPU_API_KEY',
    'MISTRAL_API_KEY',
    'MINIMAX_API_KEY',
    'MINIMAX_CN_API_KEY',
    'MINIMAX_CODE_API_KEY',
    'MINIMAX_CODE_CN_API_KEY',
    'MOONSHOT_API_KEY',
    'KIMI_API_KEY',
    'KIMI_CODE_API_KEY',
    'HF_TOKEN',
    'HUGGINGFACE_HUB_TOKEN',
    'FIREWORKS_API_KEY',
    'TOGETHER_API_KEY',
    'BASETEN_API_KEY',
    'OPENCODE_API_KEY',
    'MODEL_API_KEY',
    'META_API_KEY',
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_AI_GATEWAY_API_KEY',
    'XIAOMI_API_KEY',
    'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    'QWEN_OAUTH_TOKEN',
    'QWEN_PORTAL_API_KEY',
    'ALIBABA_CODING_PLAN_API_KEY',
    'COPILOT_GITHUB_TOKEN',
    'OLLAMA_API_KEY',
    'OLLAMA_CLOUD_API_KEY',
    'LM_STUDIO_API_KEY',
    'VLLM_API_KEY',
    'LITELLM_API_KEY',
    'NANO_GPT_API_KEY',
    'NOVITA_API_KEY',
    'SILICONFLOW_API_KEY',
    'SAMBANOVA_API_KEY',
    'STEPFUN_API_KEY',
    'QIANFAN_API_KEY',
    'SNOWFLAKE_PAT',
    'CURSOR_API_KEY',
    'CURSOR_ACCESS_TOKEN',
    'GITLAB_TOKEN',
    'CHARM_HYPER_API_KEY',
    'CLINE_API_KEY',
    'CORAL_API_KEY',
    'FIREPASS_API_KEY',
    'HELMCODE_API_KEY',
    'KILO_API_KEY',
    'SAKANA_API_KEY',
    'SYNTHETIC_API_KEY',
    'UMANS_AI_CODING_PLAN_API_KEY',
    'VENICE_API_KEY',
    'WAFER_SERVERLESS_API_KEY',
    'YOLO_AUTO_API_KEY',
    'ZENMUX_API_KEY',
    // Amazon Bedrock's own credential sources.
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_PROFILE',
    'AWS_BEARER_TOKEN_BEDROCK',
];
/** Guidance shown when a credential operation has no non-interactive path. */
export const OMP_LOGIN_INSTRUCTIONS = 'OMP logs in through the OAuth providers its CLI knows: run `omp login [provider]` in a terminal ' +
    '(or `/login` inside omp), or declare a provider API key in models.yml and export the variable it names.';
/** Guidance shown for logout, which has no CLI subcommand. */
export const OMP_LOGOUT_INSTRUCTIONS = 'OMP has no `omp logout` subcommand; run `/logout` inside omp, or for a broker-backed vault ' +
    '`omp auth-broker logout <provider>`. The stored credential rows live in <agent-dir>/agent.db.';
/**
 * Read and classify the credentials OMP's `agent.db` holds.
 *
 * @param ctx - Ambient services (configuration and read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment and observation time; injected for testability.
 * @returns Auth state with no secret material anywhere inside.
 */
export async function readOmpAuthStatus(ctx, agent, options = {}) {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now();
    const layout = await resolveOmpStore(ctx, env);
    const observation = await observeCredentials(ctx, layout, now);
    const environmentKeys = OMP_PROVIDER_ENV_VARS.filter(name => {
        const value = env[name];
        return value !== undefined && value !== '';
    });
    const observedAt = new Date(now).toISOString();
    const base = {
        agentId: agent,
        credentialPath: layout.credentialPath,
        environmentKeys,
        observedAt,
    };
    const usable = observation.credentials.filter(credential => credential.usable);
    if (usable.length > 0) {
        const expiries = usable
            .map(credential => credential.expiresMs)
            .filter((value) => value !== undefined);
        return {
            ...base,
            status: 'authenticated',
            source: 'file',
            method: methodLabel(usable),
            ...(expiries.length === 0 ? {} : { expiresAt: new Date(Math.max(...expiries)).toISOString() }),
            detail: 'the credential is a row in agent.db, which MutiAgent reads read-only; ' +
                'OMP refreshes an OAuth row on the next request',
        };
    }
    const expired = observation.credentials.filter(credential => credential.kind === 'oauth' && credential.usable === false);
    if (expired.length > 0) {
        const expiries = expired
            .map(credential => credential.expiresMs)
            .filter((value) => value !== undefined);
        return {
            ...base,
            status: 'expired',
            source: 'file',
            method: methodLabel(expired),
            ...(expiries.length === 0 ? {} : { expiresAt: new Date(Math.max(...expiries)).toISOString() }),
            detail: 'a stored OAuth credential is past its expiry; OMP refreshes it on the next request',
        };
    }
    if (environmentKeys.length > 0) {
        return {
            ...base,
            status: 'authenticated',
            source: 'env',
            method: `api-key(${environmentKeys[0] ?? 'env'})`,
            detail: 'the key comes from the host environment, which MutiAgent cannot log out; a run ' +
                'receives it only when the adapter forwards the variable (envMode is not `minimal`, ' +
                'or the `inheritCredentialEnv` setting is on)',
        };
    }
    if (!observation.present || !observation.readable) {
        const detail = observation.error === undefined
            ? `${layout.credentialPath} is absent, so OMP's credential store could not be read`
            : `${layout.credentialPath} could not be read: ${observation.error}`;
        return {
            ...base,
            status: 'unknown',
            source: observation.present ? 'file' : 'none',
            detail: `${detail}; whether OMP can authenticate is not determinable from the store`,
        };
    }
    const disabled = observation.credentials.filter(credential => credential.disabled);
    if (disabled.length > 0) {
        return {
            ...base,
            status: 'expired',
            source: 'file',
            method: methodLabel(disabled),
            detail: 'every stored credential row is disabled (a `disabled_cause` tombstone, which OMP writes when ' +
                'a grant is torn down); OMP will not use it until the provider is logged in again',
        };
    }
    return {
        ...base,
        status: 'unauthenticated',
        source: 'file',
        detail: observation.unknownTypes === 0
            ? 'agent.db holds no credential row and no provider key is set in the environment'
            : `agent.db holds no recognizable credential, and ${observation.unknownTypes} rows had a ` +
                'credential type this adapter does not model',
    };
}
/**
 * Read and classify the credentials OMP's `agent.db` holds.
 *
 * This is the model catalog's entry point: it needs to know which providers have a
 * stored credential, never a value. It reuses the same classification as
 * {@link readOmpAuthStatus}, so both agree on what counts as a credential.
 *
 * @param ctx - Ambient services (configuration and read-only file helpers).
 * @param options - Environment and observation time; injected for testability.
 * @returns One entry per recognizable credential; empty when the store is absent or unreadable.
 */
export async function readOmpCredentials(ctx, options = {}) {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now();
    const layout = await resolveOmpStore(ctx, env);
    return (await observeCredentials(ctx, layout, now)).credentials;
}
/**
 * Begin a login flow by delegating to `omp login`.
 *
 * The delegated process is `omp login` with no provider: OMP's own picker resolves
 * one, and `LoginParams` carries no provider to pass. The flow is interactive over
 * stdin, so a managed run cannot answer it — the terminal outcome is reported
 * verbatim, and the guidance names the command a human should run instead. An
 * `api-key` flow is refused with guidance because OMP's CLI has no API-key login.
 *
 * @param ctx - Adapter context.
 * @param agent - This adapter's canonical agent id.
 * @param params - Requested flow and optional secret; the secret is never used.
 * @param env - Environment to classify the post-state from; defaults to the host's.
 * @returns The CLI outcome (or the refusal) plus the freshly observed state.
 */
export async function loginOmp(ctx, agent, params, env = process.env, binary = 'omp') {
    const state = await readOmpAuthStatus(ctx, agent, { env });
    if (params.flow !== 'interactive') {
        return {
            ok: false,
            action: 'login',
            interaction: {
                kind: 'none',
                instructions: `OMP has no \`${params.flow}\` login; ${OMP_LOGIN_INSTRUCTIONS}`,
            },
            state,
        };
    }
    const layout = await resolveOmpStore(ctx, env);
    const outcome = await ctx.process.run({
        command: binary,
        args: ['login'],
        cwd: layout.agentDir,
        envMode: ctx.config.envMode,
        env: { ...ctx.config.env },
        stdin: '',
        timeoutMs: 30_000,
        captureBytes: 64 * 1024,
    });
    const output = `${outcome.stderr.head}${outcome.stderr.tail}`.trim();
    const ok = outcome.code === 0;
    return {
        ok,
        action: 'login',
        interaction: {
            kind: 'none',
            instructions: ok
                ? OMP_LOGIN_INSTRUCTIONS
                : `\`omp login\` needs a terminal to complete its OAuth flow (it reads prompts from stdin). ${OMP_LOGIN_INSTRUCTIONS}`,
        },
        state: await readOmpAuthStatus(ctx, agent, { env }),
        ...(output === '' ? {} : { output: boundOutput(output) }),
    };
}
/**
 * Report that OMP has no logout subcommand.
 *
 * Verified against oh-my-pi 18.11.0: the CLI registers `login`, `auth export/import`
 * and `auth-broker`, but no `logout`; revocation is the TUI `/logout`, the RPC
 * `logout` command, or `omp auth-broker logout` for a broker-backed vault. This
 * adapter never drives a TUI (ADR-0003), so it reports the supported paths instead
 * of running a command that does not exist.
 *
 * @param ctx - Adapter context.
 * @param agent - This adapter's canonical agent id.
 * @param env - Environment to classify the post-state from; defaults to the host's.
 * @returns An unsuccessful result carrying the guidance and the freshly observed state.
 */
export async function logoutOmp(ctx, agent, env = process.env) {
    const state = await readOmpAuthStatus(ctx, agent, { env });
    return {
        ok: false,
        action: 'logout',
        interaction: {
            kind: 'none',
            instructions: `${OMP_LOGOUT_INSTRUCTIONS} (${state.credentialPath ?? 'agent.db'})`,
        },
        state,
    };
}
/** The statements this reader runs, in order. */
const ROW_QUERY = 'SELECT provider, credential_type, disabled_cause FROM auth_credentials ORDER BY id ASC';
const EXPIRY_QUERY = "SELECT provider, json_extract(data, '$.expires') AS expires FROM auth_credentials " +
    "WHERE credential_type = 'oauth' AND disabled_cause IS NULL ORDER BY id ASC";
/** Open OMP's credential store and classify its rows, tolerating every failure. */
async function observeCredentials(ctx, layout, now) {
    const fingerprint = await ctx.files.fingerprint(layout.credentialPath);
    if (fingerprint.size < 0) {
        return { credentials: [], unknownTypes: 0, present: false, readable: false, expiryProbed: false };
    }
    let db;
    try {
        db = new DatabaseSync(layout.credentialPath, { readOnly: true });
        const rows = db.prepare(ROW_QUERY).all();
        const expiries = readExpiries(db);
        const credentials = [];
        let unknownTypes = 0;
        for (const row of rows) {
            const credential = classifyRow(row, expiries, now);
            if (credential === undefined)
                unknownTypes += 1;
            else
                credentials.push(credential);
        }
        return {
            credentials,
            unknownTypes,
            present: true,
            readable: true,
            expiryProbed: expiries !== undefined,
            ...(expiries === undefined ? { error: 'the OAuth expiry query failed' } : {}),
        };
    }
    catch (cause) {
        return {
            credentials: [],
            unknownTypes: 0,
            present: true,
            readable: false,
            error: `${cause instanceof Error ? cause.message : String(cause)}`,
            expiryProbed: false,
        };
    }
    finally {
        closeQuietly(db);
    }
}
/**
 * Read each enabled OAuth row's expiry, or `undefined` when the probe failed.
 *
 * The expiry is the one value of `data` this adapter reads, and SQLite extracts it so
 * the JSON blob — which also holds the tokens — never enters this process.
 */
function readExpiries(db) {
    try {
        const map = new Map();
        for (const row of db.prepare(EXPIRY_QUERY).all()) {
            const provider = row.provider;
            const expires = row.expires;
            if (typeof provider !== 'string' || typeof expires !== 'number' || !Number.isFinite(expires))
                continue;
            // A provider may hold several accounts; keep the latest expiry per provider.
            const existing = map.get(provider);
            if (existing === undefined || expires > existing)
                map.set(provider, expires);
        }
        return map;
    }
    catch {
        return undefined;
    }
}
/** Classify one `auth_credentials` row, from its non-secret columns only. */
function classifyRow(row, expiries, now) {
    const provider = row.provider;
    const credentialType = row.credential_type;
    if (typeof provider !== 'string' || provider === '')
        return undefined;
    if (credentialType !== 'api_key' && credentialType !== 'oauth')
        return undefined;
    const disabledCause = row.disabled_cause;
    const disabled = typeof disabledCause === 'string';
    if (credentialType === 'api_key') {
        // An API-key row's own `key` field is never read: its presence is the whole fact.
        return { provider, kind: 'api_key', usable: !disabled, disabled };
    }
    const expiresMs = expiries?.get(provider);
    return {
        provider,
        kind: 'oauth',
        usable: !disabled && (expiresMs === undefined || expiresMs > now),
        disabled,
        ...(expiresMs === undefined ? {} : { expiresMs }),
    };
}
/** Close a store handle, ignoring a close failure on an already-failed read. */
function closeQuietly(db) {
    if (db === undefined)
        return;
    try {
        db.close();
    }
    catch {
        // A close failure after a successful read changes nothing this reader reports.
    }
}
/** Name the providers and kinds observed, e.g. `anthropic(oauth), openai(api_key)`. */
function methodLabel(credentials) {
    const labels = [];
    for (const credential of credentials) {
        const label = `${credential.provider}(${credential.kind})`;
        if (!labels.includes(label))
            labels.push(label);
    }
    return labels.join(', ');
}
/** Bound a diagnostic string for an operation result, keeping its tail. */
function boundOutput(text) {
    const limit = 2_000;
    return text.length > limit ? text.slice(text.length - limit) : text;
}
//# sourceMappingURL=auth.js.map