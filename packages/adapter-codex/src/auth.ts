/**
 * Codex credential inspection and login/logout delegation (ADR-0010).
 *
 * MutiAgent never becomes a credential store: status is derived by reading
 * `$CODEX_HOME/auth.json` and the relevant environment variables **without writing
 * anything**, and every mutation is delegated to `codex login` / `codex logout`. No
 * value from a token, key or header ever leaves this module — only its presence,
 * kind and metadata do, and the CLI's own output is passed through a {@link Redactor}
 * seeded with any secret this module was handed.
 *
 * @module @zorker/muti-agent-adapter-codex/auth
 */

import { join } from 'node:path'

import {
  ErrorCodes,
  MutiAgentError,
  type AgentAuthState,
  type AgentId,
  type AuthOperationResult,
  type AuthStatus,
  type CredentialFlow,
} from '@zorker/muti-agent-contracts'
import { Redactor, type FileProbe, type Logger, type ProcessRunner } from '@zorker/muti-agent-core'

import { CODEX_CREDENTIAL_FILE, type CodexHome } from './sessions.ts'

/** Environment variables that can carry a Codex credential. */
export const CODEX_CREDENTIAL_ENV_KEYS: readonly string[] = [
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
]

/** Credential flows this adapter can drive through the native CLI. */
export const CODEX_LOGIN_FLOWS: readonly CredentialFlow[] = ['oauth-loopback', 'device-code', 'api-key']

/** Wall-clock budget for a delegated login, which waits for a human in the loop. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** Wall-clock budget for a logout. */
export const DEFAULT_LOGOUT_TIMEOUT_MS = 60 * 1000

/** Config file consulted only to learn which credential store Codex uses. */
const CODEX_CONFIG_FILE = 'config.toml'

/** Bytes read from `config.toml` while looking for the credential-store setting. */
const CONFIG_HEAD_BYTES = 256 * 1024

/** Bytes of CLI output kept in an {@link AuthOperationResult}. */
const OUTPUT_TAIL_CHARS = 4 * 1024

/** A URL the user must open, as Codex's flows print it. */
const URL_PATTERN = /https?:\/\/[^\s"'`<>)\]}]+/

/** A device code, in either the dashed or the plain form Codex prints. */
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/

/** Native `auth_mode` values, mapped onto the method label reported to the UI. */
const AUTH_METHODS: Readonly<Record<string, string>> = {
  apikey: 'api-key',
  chatgpt: 'chatgpt-oauth',
  chatgptauthtokens: 'chatgpt-auth-tokens',
  headers: 'headers',
  agentidentity: 'agent-identity',
  personalaccesstoken: 'personal-access-token',
  bedrockapikey: 'bedrock-api-key',
  bedrockaccesskeys: 'bedrock-access-keys',
}

/** A classified credential file, before it is stamped with observation context. */
export interface CodexAuthClassification {
  /** Classified state. */
  readonly status: AuthStatus
  /** Credential mechanism observed. */
  readonly method?: string
  /** Account identifier or email, when the id_token exposed one. */
  readonly account?: string
  /** Subscription plan label, when the id_token exposed one. */
  readonly plan?: string
  /** ISO 8601 expiry, when the id_token's `exp` claim supplied one. */
  readonly expiresAt?: string
  /** Human-readable explanation of the classification. */
  readonly detail?: string
}

/** A JSON object view of an unknown value, or `undefined`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A non-empty string field of a record. */
function str(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A finite number field of a record. */
function num(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Normalize a native token for comparison. */
function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Decode a JWT payload segment without verifying it.
 *
 * The id_token's claims are the only place Codex records the ChatGPT account and plan;
 * they are read for display and never treated as proof of anything, which is why the
 * signature is deliberately not checked.
 *
 * @param token - A JWT as stored in `auth.json`.
 * @returns The claims object, or `undefined` when the token cannot be decoded.
 */
export function decodeIdTokenClaims(token: string): Record<string, unknown> | undefined {
  const segment = token.split('.')[1]
  if (segment === undefined || segment === '') return undefined
  try {
    const decoded = Buffer.from(segment, 'base64url').toString('utf8')
    return asRecord(JSON.parse(decoded))
  } catch {
    return undefined
  }
}

/**
 * Classify a parsed `auth.json`.
 *
 * An unparsable or structurally unusable file yields `misconfigured` with the reason,
 * never a fabricated "logged out" (ADR-0010 rule 1). Absence of material is
 * `unauthenticated`; a credential this adapter cannot interpret is `unknown`.
 *
 * @param value - The parsed file content.
 * @returns The classification, with account and plan when the id_token exposed them.
 */
export function classifyAuthFile(value: unknown): CodexAuthClassification {
  const record = asRecord(value)
  if (record === undefined) {
    return { status: 'misconfigured', detail: 'auth.json is not a JSON object' }
  }
  const mode = str(record, 'auth_mode')
  const method = mode === undefined ? undefined : AUTH_METHODS[normalize(mode)]
  const tokens = asRecord(record.tokens)
  const idToken = str(tokens, 'id_token')
  const accessToken = str(tokens, 'access_token')
  const claims = idToken === undefined ? undefined : decodeIdTokenClaims(idToken)
  const account = claims === undefined ? undefined : str(claims, 'email') ?? str(claims, 'chatgpt_user_id')
  const plan = claims === undefined ? undefined : str(claims, 'chatgpt_plan_type')
  const expirySeconds = claims === undefined ? undefined : num(claims, 'exp')
  const expiresAt = expirySeconds === undefined ? undefined : new Date(expirySeconds * 1000).toISOString()
  const accountFields = {
    ...(account === undefined ? {} : { account }),
    ...(plan === undefined ? {} : { plan }),
  }
  const expiryFields = expiresAt === undefined ? {} : { expiresAt }

  if (idToken !== undefined || accessToken !== undefined) {
    const expires = expirySeconds === undefined ? undefined : new Date(expirySeconds * 1000).getTime()
    const expired = expires !== undefined && expires <= Date.now()
    const decodeFailed = idToken !== undefined && claims === undefined
    const detail = decodeFailed
      ? 'the stored id_token could not be decoded, so the account and plan are unknown'
      : expired
        ? 'the stored ChatGPT token is past its expiry; codex refreshes it on next use'
        : idToken !== undefined && expiresAt === undefined
          ? 'the id_token carries no exp claim, so no expiry can be reported'
          : undefined
    return {
      status: expired ? 'expired' : 'authenticated',
      method: method ?? 'chatgpt-oauth',
      ...accountFields,
      ...expiryFields,
      ...(detail === undefined ? {} : { detail }),
    }
  }
  if (str(record, 'OPENAI_API_KEY') !== undefined) {
    return { status: 'authenticated', method: method ?? 'api-key', detail: 'an API key is stored in auth.json' }
  }
  if (str(record, 'personal_access_token') !== undefined) {
    return { status: 'authenticated', method: method ?? 'personal-access-token' }
  }
  if (record.agent_identity !== undefined) {
    return { status: 'authenticated', method: method ?? 'agent-identity' }
  }
  if (record.bedrock_api_key !== undefined || record.bedrock_access_keys !== undefined) {
    return { status: 'authenticated', method: method ?? 'bedrock-api-key', detail: 'Amazon Bedrock credentials are stored in auth.json' }
  }
  if (mode === undefined) {
    return { status: 'unauthenticated', detail: 'auth.json carries no auth_mode and no credential material' }
  }
  if (method === undefined) {
    return { status: 'unknown', method: mode, detail: `auth.json uses an unrecognized auth_mode "${mode}"` }
  }
  if (normalize(mode) === 'headers') {
    return { status: 'unknown', method, detail: 'auth_mode is "headers": credentials come from request headers MutiAgent does not read' }
  }
  return { status: 'unauthenticated', method, detail: `auth_mode is "${mode}" but no credential material is present` }
}

/** Everything an auth status read needs. */
export interface CodexAuthRead {
  /** Read-only filesystem helpers. */
  readonly files: FileProbe
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Owning agent id. */
  readonly agentId: AgentId
  /** Environment to inspect; defaults to the host process environment. */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Observe Codex's authentication state.
 *
 * The environment wins as a source: a credential variable is what a run would actually
 * use, and ADR-0010 requires env-provided credentials to be reported as first-class and
 * explicitly un-manageable. Absence of the file is only reported as `unauthenticated`
 * after checking whether Codex is configured to keep credentials in the OS keyring, in
 * which case the honest answer is `unknown`.
 *
 * @param read - Filesystem helpers, home layout and the environment to inspect.
 * @returns The observed state; never a secret.
 */
export async function readCodexAuthState(read: CodexAuthRead): Promise<AgentAuthState> {
  const env = read.env ?? process.env
  const observedAt = new Date().toISOString()
  const environmentKeys = CODEX_CREDENTIAL_ENV_KEYS.filter(key => (env[key] ?? '') !== '')
  const base = {
    agentId: read.agentId,
    observedAt,
    credentialPath: read.home.credentialFile,
    environmentKeys,
  }
  if (environmentKeys.length > 0) {
    return {
      ...base,
      status: 'authenticated',
      source: 'env',
      method: environmentKeys.includes('CODEX_ACCESS_TOKEN') ? 'access-token' : 'api-key',
      detail: `a credential is supplied through ${environmentKeys.join(', ')}, which takes precedence over the stored one; MutiAgent cannot log an environment credential out`,
    }
  }
  const parsed = await read.files.readJson<unknown>(read.home.credentialFile)
  if (!parsed.ok && parsed.missing) {
    const store = await readCredentialStoreMode(read.files, read.home)
    if (store === 'keyring') {
      return {
        ...base,
        status: 'unknown',
        source: 'keyring',
        method: 'keyring',
        detail:
          'Codex is configured with cli_auth_credentials_store = "keyring", which MutiAgent cannot read; runs may still be authenticated',
      }
    }
    return {
      ...base,
      status: 'unauthenticated',
      source: 'none',
      detail:
        store === undefined
          ? `${CODEX_CREDENTIAL_FILE} is absent from ${read.home.path}`
          : `${CODEX_CREDENTIAL_FILE} is absent and the configured credential store is "${store}"`,
    }
  }
  if (!parsed.ok) {
    return {
      ...base,
      status: 'misconfigured',
      source: 'file',
      detail: `${CODEX_CREDENTIAL_FILE} could not be parsed: ${parsed.error}`,
    }
  }
  const classified = classifyAuthFile(parsed.value)
  return {
    ...base,
    status: classified.status,
    source: 'file',
    ...(classified.method === undefined ? {} : { method: classified.method }),
    ...(classified.account === undefined ? {} : { account: classified.account }),
    ...(classified.plan === undefined ? {} : { plan: classified.plan }),
    ...(classified.expiresAt === undefined ? {} : { expiresAt: classified.expiresAt }),
    ...(classified.detail === undefined ? {} : { detail: classified.detail }),
  }
}

/**
 * Read the configured credential store from `config.toml`.
 *
 * @param files - Read-only filesystem helpers.
 * @param home - Resolved home layout.
 * @returns The raw setting value (`file`, `keyring`, `auto`, `ephemeral`), or `undefined`.
 */
async function readCredentialStoreMode(files: FileProbe, home: CodexHome): Promise<string | undefined> {
  const head = await files.readHead(join(home.path, CODEX_CONFIG_FILE), CONFIG_HEAD_BYTES)
  if (head.missing) return undefined
  const match = /^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m.exec(head.text)
  return match?.[1]
}

/** Everything a delegated login needs. */
export interface CodexLoginOptions {
  /** Managed process runner. */
  readonly process: ProcessRunner
  /** Structured logger; never given a secret. */
  readonly log: Logger
  /** Resolved Codex binary. */
  readonly binary: string
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Owning agent id. */
  readonly agentId: AgentId
  /** Requested flow and, for `api-key`, the secret to feed on stdin. */
  readonly params: { readonly flow: CredentialFlow; readonly secret?: string }
  /** Fresh status probe, run after the CLI exits. */
  readonly status: () => Promise<AgentAuthState>
  /** Working directory for the CLI process. */
  readonly cwd: string
  /** Environment entries layered over the derived set; always carries `CODEX_HOME`. */
  readonly env: Readonly<Record<string, string>>
  /** Environment derivation mode. */
  readonly envMode: 'minimal' | 'inherit-agent' | 'inherit-all'
  /** Wall-clock budget for the flow. */
  readonly timeoutMs?: number
}

/**
 * Delegate a login to `codex login` and report the state that resulted.
 *
 * The secret for an `api-key` flow is passed on **stdin** and never in argv (ADR-0010
 * rule 2), and every byte of the CLI's output is passed through a redactor seeded with
 * that secret. A non-zero exit is reported as `ok: false` with the output attached
 * rather than thrown, because the settings page must show what Codex said.
 *
 * @param options - Binary, home, requested flow, and the environment to run in.
 * @returns The intent plus the freshly observed state.
 * @throws {MutiAgentError} `auth/login-unsupported` for a flow this adapter does not
 *   implement, and `auth/login-failed` when the `api-key` flow was requested without
 *   a secret.
 */
export async function codexLogin(options: CodexLoginOptions): Promise<AuthOperationResult> {
  const flow = options.params.flow
  if (!CODEX_LOGIN_FLOWS.includes(flow)) {
    throw new MutiAgentError(ErrorCodes.authLoginUnsupported, `codex cannot log in with the "${flow}" flow`, {
      details: { agent: 'codex', flow },
      remediation: `Supported flows: ${CODEX_LOGIN_FLOWS.join(', ')}. Use "open native login" for anything else.`,
    })
  }
  if (flow === 'api-key' && (options.params.secret === undefined || options.params.secret === '')) {
    throw new MutiAgentError(ErrorCodes.authLoginFailed, 'the api-key flow needs a key', {
      details: { agent: 'codex', flow },
      remediation: 'Provide the API key in the form; MutiAgent passes it to codex login --with-api-key on stdin.',
    })
  }
  const args = loginArgs(flow)
  options.log.debug('delegating codex login', { flow, args: args.join(' ') })
  const outcome = await options.process.run({
    command: options.binary,
    args,
    cwd: options.cwd,
    envMode: options.envMode,
    env: options.env,
    ...(flow === 'api-key' ? { stdin: options.params.secret ?? '' } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    captureBytes: 256 * 1024,
  })
  const redactor = new Redactor(options.params.secret === undefined ? [] : [options.params.secret])
  const output = redactor.apply(`${outcome.stdout.head}${outcome.stdout.tail}${outcome.stderr.head}${outcome.stderr.tail}`)
  const interaction = loginInteraction(flow, output)
  const state = await options.status()
  options.log.debug('codex login finished', { flow, ok: outcome.code === 0, status: state.status })
  return {
    ok: outcome.code === 0,
    action: 'login',
    ...(interaction === undefined ? {} : { interaction }),
    state,
    ...(output.trim() === '' ? {} : { output: tailChars(output, OUTPUT_TAIL_CHARS) }),
  }
}

/** Everything a delegated logout needs. */
export interface CodexLogoutOptions {
  /** Managed process runner. */
  readonly process: ProcessRunner
  /** Structured logger. */
  readonly log: Logger
  /** Resolved Codex binary. */
  readonly binary: string
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Owning agent id. */
  readonly agentId: AgentId
  /** Fresh status probe, run after the CLI exits. */
  readonly status: () => Promise<AgentAuthState>
  /** Working directory for the CLI process. */
  readonly cwd: string
  /** Environment entries layered over the derived set; always carries `CODEX_HOME`. */
  readonly env: Readonly<Record<string, string>>
  /** Environment derivation mode. */
  readonly envMode: 'minimal' | 'inherit-agent' | 'inherit-all'
  /** Wall-clock budget for the logout. */
  readonly timeoutMs?: number
}

/**
 * Delegate a logout to `codex logout` and report the state that resulted.
 *
 * @param options - Binary, home and the environment to run in.
 * @returns The intent plus the freshly observed state; a non-zero exit is reported,
 *   not thrown, so the settings page can show what Codex said.
 */
export async function codexLogout(options: CodexLogoutOptions): Promise<AuthOperationResult> {
  options.log.debug('delegating codex logout')
  const outcome = await options.process.run({
    command: options.binary,
    args: ['logout'],
    cwd: options.cwd,
    envMode: options.envMode,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_LOGOUT_TIMEOUT_MS,
    captureBytes: 64 * 1024,
  })
  const output = new Redactor().apply(
    `${outcome.stdout.head}${outcome.stdout.tail}${outcome.stderr.head}${outcome.stderr.tail}`,
  )
  const state = await options.status()
  options.log.debug('codex logout finished', { ok: outcome.code === 0, status: state.status })
  return {
    ok: outcome.code === 0,
    action: 'logout',
    state,
    ...(output.trim() === '' ? {} : { output: tailChars(output, OUTPUT_TAIL_CHARS) }),
  }
}

/** Native argv for a credential flow. */
function loginArgs(flow: CredentialFlow): readonly string[] {
  switch (flow) {
    case 'device-code':
      return ['login', '--device-auth']
    case 'api-key':
      return ['login', '--with-api-key']
    default:
      return ['login']
  }
}

/**
 * Describe the human step a login flow needs, parsed out of the CLI's own output.
 *
 * The subprocess is held open until it exits and the SPI carries one result, so the
 * interaction is reported after the flow completes rather than as it streams; a URL or
 * a device code Codex printed is still what the user needs.
 *
 * @param flow - The flow that ran.
 * @param output - Redacted CLI output.
 * @returns The interaction to surface, or `undefined` when none was requested.
 */
function loginInteraction(flow: CredentialFlow, output: string): AuthOperationResult['interaction'] | undefined {
  if (flow === 'api-key') {
    return {
      kind: 'stdin-secret',
      instructions: 'The API key was passed to codex login --with-api-key on stdin and is now stored by Codex.',
    }
  }
  // Codex prints its local listener before the URL a human must open, so the last URL in
  // the output is the actionable one.
  const url = lastUrl(output)
  if (flow === 'device-code') {
    const code = deviceCode(output)
    return {
      kind: 'device-code',
      ...(url === undefined ? {} : { url }),
      ...(code === undefined ? {} : { code }),
      instructions:
        url === undefined
          ? 'Codex is waiting for a device login; complete it in a browser, then re-check the status here.'
          : `Open ${url}${code === undefined ? '' : ` and enter the code ${code}`} to finish the login.`,
    }
  }
  return {
    kind: 'browser-url',
    ...(url === undefined ? {} : { url }),
    instructions:
      url === undefined
        ? 'Codex opened a browser window (or printed an authorization URL) to finish the login.'
        : `Finish the login at ${url}; codex completes it through its loopback listener.`,
  }
}

/** The last URL in output, which is the one a human must act on. */
function lastUrl(output: string): string | undefined {
  const matches = [...output.matchAll(new RegExp(URL_PATTERN.source, 'g'))]
  return matches.at(-1)?.[0]
}

/** A device code printed by Codex, preferring a line that names it as one. */
function deviceCode(output: string): string | undefined {
  for (const line of output.split('\n')) {
    if (!/code/i.test(line)) continue
    const match = DEVICE_CODE_PATTERN.exec(line)
    if (match !== null) return match[0]
  }
  return DEVICE_CODE_PATTERN.exec(output)?.[0]
}

/** The last `count` characters of a string. */
function tailChars(text: string, count: number): string {
  return text.length <= count ? text : `…${text.slice(text.length - count)}`
}
