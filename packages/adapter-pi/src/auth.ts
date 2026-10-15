/**
 * Pi credential inspection and the delegated credential operations.
 *
 * Status is read-only and file-first: `auth.json` is
 * `Record<providerId, {type:'api_key', key?, env?} | {type:'oauth', access, refresh,
 * expires, …}>`, and a provider key can also come from the host environment (ADR-0010).
 * Nothing here writes, locks or rewrites the store, and no credential value ever leaves
 * this module: only provider names, kinds and expiries are projected.
 *
 * Pi has no non-interactive credential command. `/login` and `/logout` exist only inside
 * its TUI, and this adapter never drives a TUI (ADR-0003), so both operations return an
 * explicit unsupported-with-guidance result rather than faking a flow. `pi auth check`,
 * `pi auth print-api-key` and `pi auth print-bearer-token` exist but are deliberately not
 * used: the first costs a process start for information a file read already gives, and the
 * other two would print a secret.
 *
 * @module @zorker/muti-agent-adapter-pi/auth
 */

import type { AgentAuthState, AgentId, AuthOperationResult } from '@zorker/muti-agent-contracts'
import type { AdapterContext, LoginParams } from '@zorker/muti-agent-core'
import { isRecord, readNumber, readString, resolvePiStore } from './sessions.ts'

/**
 * Credential-shaped environment variables pi resolves a provider key from, as declared
 * in `@earendil-works/pi-ai`'s provider registry. Names only; values are never read into
 * a projection.
 *
 * Ambient sources pi also supports (AWS IAM profiles, Google Application Default
 * Credentials) are deliberately absent: pi's own `findEnvKeys` excludes them because
 * they cannot be classified by presence alone.
 */
export const PI_PROVIDER_ENV_VARS: readonly string[] = [
  // Anthropic: the auth token is a bearer credential, the other two are API keys.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANT_LING_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'NVIDIA_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'TYPESAFE_API_KEY',
  'RADIUS_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MOONSHOT_API_KEY',
  'HF_TOKEN',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'BASETEN_API_KEY',
  'OPENCODE_API_KEY',
  'KIMI_API_KEY',
  'META_API_KEY',
  'CLOUDFLARE_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  // Amazon Bedrock's own credential sources.
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const

/** Guidance shown when a credential operation has no non-interactive path. */
export const PI_LOGIN_INSTRUCTIONS =
  'Pi has no non-interactive login; run `pi` and use /login, or set a provider API key.'

/** Guidance shown for the equally TUI-only logout. */
export const PI_LOGOUT_INSTRUCTIONS =
  'Pi has no non-interactive logout; run `pi` and use /logout, or remove the provider entry from its auth.json.'

/** How a stored credential can be used, with no secret material. */
type CredentialKind = 'oauth' | 'api_key' | 'command'

interface ObservedCredential {
  /** Provider id, verbatim. */
  provider: string
  /** How pi would resolve it. */
  kind: CredentialKind
  /** Whether it can authenticate a request right now. */
  usable: boolean
  /** Expiry in milliseconds, for an OAuth credential. */
  expiresMs?: number
}

interface CredentialObservation {
  credentials: readonly ObservedCredential[]
  /** Entries that were present but not recognizable as a credential. */
  malformed: number
  /** Whether the file existed and parsed as a JSON object. */
  parsed: boolean
  /** Parse/read failure, for a `misconfigured` detail; never secret material. */
  error?: string
}

/**
 * Read and classify pi's stored credentials.
 *
 * @param ctx - Adapter context.
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment to inspect; injected for testability.
 * @returns Auth state with no secret material anywhere inside.
 */
export async function readPiAuthStatus(
  ctx: AdapterContext,
  agent: AgentId,
  options: { env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<AgentAuthState> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const layout = await resolvePiStore(ctx, env)
  const observation = await observeCredentials(ctx, layout.credentialPath, now)
  const environmentKeys = PI_PROVIDER_ENV_VARS.filter(name => {
    const value = env[name]
    return value !== undefined && value !== ''
  })

  const observedAt = new Date(now).toISOString()
  const base = {
    agentId: agent,
    credentialPath: layout.credentialPath,
    environmentKeys,
    observedAt,
  }

  const usable = observation.credentials.filter(credential => credential.usable)
  if (usable.length > 0) {
    const expiries = usable
      .map(credential => credential.expiresMs)
      .filter((value): value is number => value !== undefined)
    const commandOnly = usable.every(credential => credential.kind === 'command')
    return {
      ...base,
      status: 'authenticated',
      source: 'file',
      method: methodLabel(usable),
      ...(expiries.length === 0 ? {} : { expiresAt: new Date(Math.max(...expiries)).toISOString() }),
      ...(commandOnly
        ? { detail: 'the stored key is a `!command` reference that pi resolves by running a shell command' }
        : {}),
    }
  }

  const expired = observation.credentials.filter(
    credential => credential.kind === 'oauth' && credential.usable === false,
  )
  if (expired.length > 0) {
    const expiries = expired
      .map(credential => credential.expiresMs)
      .filter((value): value is number => value !== undefined)
    return {
      ...base,
      status: 'expired',
      source: 'file',
      method: methodLabel(expired),
      ...(expiries.length === 0 ? {} : { expiresAt: new Date(Math.max(...expiries)).toISOString() }),
      detail: 'a stored OAuth credential expired; pi refreshes it on the next request',
    }
  }

  if (environmentKeys.length > 0) {
    return {
      ...base,
      status: 'authenticated',
      source: 'env',
      method: `api-key(${environmentKeys[0] ?? 'env'})`,
      detail:
        'the key comes from the host environment, which MutiAgent cannot log out; a run ' +
        'receives it only when the adapter forwards the variable (envMode is not `minimal`, ' +
        'or the `inheritCredentialEnv` setting is on)',
    }
  }

  if (!observation.parsed) {
    if (observation.error === undefined) {
      return {
        ...base,
        status: 'unauthenticated',
        source: 'none',
        detail: 'auth.json is absent and no provider key is set in the environment',
      }
    }
    return {
      ...base,
      status: 'misconfigured',
      source: 'file',
      detail: `auth.json could not be read: ${observation.error}`,
    }
  }

  return {
    ...base,
    status: 'unauthenticated',
    source: 'file',
    detail:
      observation.malformed === 0
        ? 'auth.json holds no usable credential'
        : `auth.json holds no usable credential, and ${observation.malformed} entries were not recognizable`,
  }
}

/**
 * Begin a login flow. Pi exposes `/login` only inside its TUI, and this adapter
 * declares the `interactive` flow without driving a TUI (ADR-0003), so this reports
 * what a human must do instead of pretending to start a flow.
 *
 * @param ctx - Adapter context.
 * @param agent - This adapter's canonical agent id.
 * @param params - Requested flow and optional secret; the secret is never used.
 * @param env - Environment to classify the post-state from; defaults to the host's.
 * @returns An unsuccessful result carrying the guidance and the freshly observed state.
 */
export async function loginPi(
  ctx: AdapterContext,
  agent: AgentId,
  params: LoginParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthOperationResult> {
  const state = await readPiAuthStatus(ctx, agent, { env })
  const instructions =
    params.flow === 'interactive'
      ? PI_LOGIN_INSTRUCTIONS
      : `Pi has no \`${params.flow}\` login flow; ${PI_LOGIN_INSTRUCTIONS}`
  return { ok: false, action: 'login', interaction: { kind: 'none', instructions }, state }
}

/**
 * Revoke a credential. Pi's `/logout` is a TUI command with no CLI equivalent, so this
 * reports the supported manual paths rather than mutating pi's store (ADR-0010).
 *
 * @param ctx - Adapter context.
 * @param agent - This adapter's canonical agent id.
 * @param env - Environment to classify the post-state from; defaults to the host's.
 * @returns An unsuccessful result carrying the guidance and the freshly observed state.
 */
export async function logoutPi(
  ctx: AdapterContext,
  agent: AgentId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthOperationResult> {
  const state = await readPiAuthStatus(ctx, agent, { env })
  return {
    ok: false,
    action: 'logout',
    interaction: {
      kind: 'none',
      instructions: `${PI_LOGOUT_INSTRUCTIONS} (${state.credentialPath ?? 'auth.json'})`,
    },
    state,
  }
}

/** Classify every entry of an auth.json file. */
async function observeCredentials(
  ctx: AdapterContext,
  credentialPath: string,
  now: number,
): Promise<CredentialObservation> {
  const parsed = await ctx.files.readJson<unknown>(credentialPath)
  if (!parsed.ok) {
    // Absence is not an error: an agent with no stored credential is unauthenticated.
    return { credentials: [], malformed: 0, parsed: false, ...(parsed.missing ? {} : { error: parsed.error }) }
  }
  if (!isRecord(parsed.value)) {
    return { credentials: [], malformed: 0, parsed: false, error: 'auth.json does not hold a JSON object' }
  }

  const credentials: ObservedCredential[] = []
  let malformed = 0
  for (const [provider, value] of Object.entries(parsed.value)) {
    const credential = classifyCredential(provider, value, now)
    if (credential === undefined) malformed += 1
    else credentials.push(credential)
  }
  return { credentials, malformed, parsed: true }
}

/** Classify one provider's stored credential, without reading it into a projection. */
function classifyCredential(provider: string, value: unknown, now: number): ObservedCredential | undefined {
  if (!isRecord(value)) return undefined
  const type = readString(value, 'type')
  if (type === 'oauth') {
    const expires = readNumber(value, 'expires')
    const hasTokens = (readString(value, 'access') ?? '') !== '' || (readString(value, 'refresh') ?? '') !== ''
    if (!hasTokens && expires === undefined) return undefined
    return {
      provider,
      kind: 'oauth',
      usable: expires !== undefined && expires > now,
      ...(expires === undefined ? {} : { expiresMs: expires }),
    }
  }
  if (type === 'api_key') {
    const key = readString(value, 'key')
    // A `!command` key is resolved by pi at request time; the command text is never
    // read into a projection, and it is never executed by this adapter.
    if (key === undefined || key === '') return undefined
    return { provider, kind: key.startsWith('!') ? 'command' : 'api_key', usable: true }
  }
  return undefined
}

/** Name the providers and kinds observed, e.g. `anthropic(oauth), openai(api_key)`. */
function methodLabel(credentials: readonly ObservedCredential[]): string {
  const labels: string[] = []
  for (const credential of credentials) {
    const label = `${credential.provider}(${credential.kind})`
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.join(', ')
}
