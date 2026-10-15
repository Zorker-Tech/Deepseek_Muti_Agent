/**
 * Credential status and delegated login/logout for Grok Build (ADR-0010).
 *
 * Status is read from `$GROK_AUTH_PATH` (default `$GROK_HOME/auth.json`), which is a map
 * keyed by scope string: `xai::api_key` for API-key auth, the legacy
 * `https://accounts.x.ai/sign-in`, or an OIDC issuer URL
 * (`xai-grok-login/src/model.rs`, `AuthMode`). Mutation is never performed here: the
 * native `grok login` / `grok logout` commands are spawned and the observed post-state
 * is re-read. No function in this module returns, logs or persists a secret.
 *
 * grok has no `--api-key` login flag, so an `api-key` flow is refused with the
 * interaction a settings page can render instead of being faked.
 *
 * @module @zorker/muti-agent-adapter-grok/auth
 */

import type {
  AgentAuthState,
  AuthOperationResult,
  AuthStatus,
  CredentialFlow,
} from '@zorker/muti-agent-contracts'
import { agentId } from '@zorker/muti-agent-contracts'
import type { AdapterRuntimeConfig, FileProbe, Logger, LoginParams, ProcessRunner } from '@zorker/muti-agent-core'
import { Redactor } from '@zorker/muti-agent-core'
import type { GrokPaths } from './sessions.ts'
import { asRecord } from './events.ts'

/** Agent id this adapter reports; declared here so this module needs no adapter import. */
const AGENT_ID = agentId('grok')

/** Scope key for plain API-key auth (`grok login --api-key` in older builds). */
const API_KEY_SCOPE = 'xai::api_key'

/** Legacy scope key used by pre-OIDC devbox auth files. */
const LEGACY_SCOPE = 'https://accounts.x.ai/sign-in'

/** Credential variables grok honours, in the precedence its own banner reports. */
export const GROK_CREDENTIAL_ENV_KEYS = [
  'XAI_API_KEY',
  'GROK_CODE_XAI_API_KEY',
  'GROK_AUTH',
  'GROK_DEPLOYMENT_KEY',
] as const

/** Store and policy variables every grok child is given. */
export const GROK_RUNTIME_ENV_KEYS = ['GROK_HOME', 'GROK_AUTH_PATH', 'GROK_SANDBOX'] as const

/** Every variable name this adapter may pass to a grok process. */
export const GROK_MANAGED_ENV_KEYS: readonly string[] = [...GROK_RUNTIME_ENV_KEYS, ...GROK_CREDENTIAL_ENV_KEYS]

/** Bytes of CLI output kept in an auth operation result. */
const AUTH_OUTPUT_CHARS = 8 * 1024

/** One `auth.json` entry, with the secret reduced to its presence. */
export interface GrokAuthEntry {
  /** Scope key the entry is filed under. */
  scope: string
  /** `auth_mode` verbatim: `web_login`, `oidc`, `external` or `api_key`. */
  authMode: string
  /** Whether a bearer was present; the value itself is never retained. */
  hasKey: boolean
  /** Whether a refresh token was present. */
  hasRefreshToken: boolean
  /** Whether `expires_at` is in the past. */
  expired: boolean
  /** Whether the entry carries an expiry at all. */
  hasExpiry: boolean
  email?: string
  teamName?: string
  expiresAt?: string
  /** Whether this entry represents an account login rather than a bare key. */
  accountLogin: boolean
}

/**
 * Parse the scope map read-only.
 *
 * @param value - Parsed JSON of the credential file.
 * @returns One entry per scope; unrecognized values are skipped, never guessed at.
 */
export function parseGrokAuthStore(value: unknown): readonly GrokAuthEntry[] {
  const record = asRecord(value)
  if (record === undefined) return []
  const now = Date.now()
  const entries: GrokAuthEntry[] = []
  for (const [scope, raw] of Object.entries(record)) {
    const entry = asRecord(raw)
    if (entry === undefined) continue
    const authMode = typeof entry.auth_mode === 'string' ? entry.auth_mode : ''
    const expiresAt = isoValue(entry.expires_at)
    const expired = expiresAt === undefined ? false : Date.parse(expiresAt) <= now
    entries.push({
      scope,
      authMode,
      hasKey: typeof entry.key === 'string' && entry.key !== '',
      hasRefreshToken: typeof entry.refresh_token === 'string' && entry.refresh_token !== '',
      expired,
      hasExpiry: expiresAt !== undefined,
      ...(typeof entry.email === 'string' && entry.email !== '' ? { email: entry.email } : {}),
      ...(typeof entry.team_name === 'string' && entry.team_name !== '' ? { teamName: entry.team_name } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      accountLogin: isAccountLogin(scope, authMode),
    })
  }
  return entries
}

/**
 * Choose the entry that best describes the live credential.
 *
 * Precedence: a usable account login, then an account login that can still refresh, then
 * an API-key entry (canonical scope first), then anything else.
 *
 * @param entries - Parsed entries.
 * @returns The selected entry, or `undefined` when the store is empty.
 */
export function selectGrokAuthEntry(entries: readonly GrokAuthEntry[]): GrokAuthEntry | undefined {
  let best: GrokAuthEntry | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    const score = entryScore(entry)
    if (score < bestScore) {
      best = entry
      bestScore = score
    }
  }
  return best
}

/**
 * Rank one entry for selection; lower wins.
 *
 * @param entry - Parsed entry.
 * @returns The rank, where an unusable entry never outranks a usable one.
 */
function entryScore(entry: GrokAuthEntry): number {
  if (entry.accountLogin) {
    if (!entry.expired) return 0
    if (entry.hasRefreshToken) return 1
    return 5
  }
  if (entry.scope === API_KEY_SCOPE) return 2
  if (entry.hasKey) return 3
  return 6
}

/**
 * Canonical credential method label for a native `auth_mode`.
 *
 * @param authMode - The `auth_mode` string from the store.
 * @returns The canonical method label, or the raw token when it is not one we know.
 */
export function grokMethodLabel(authMode: string): string {
  switch (authMode) {
    case 'web_login':
      return 'web-login'
    case 'oidc':
      return 'oidc'
    case 'external':
      return 'external'
    case 'api_key':
      return 'api-key'
    default:
      return authMode === '' ? 'unknown' : authMode
  }
}

/** The credential store as read: presence plus the entries, never secret material. */
export interface GrokAuthStoreRead {
  /** Whether the store file exists. */
  present: boolean
  /** One entry per scope, with secret values reduced to `hasKey`. */
  entries: readonly GrokAuthEntry[]
  /** Why the store could not be read, when it exists but could not be. */
  error?: string
}

/**
 * Read the scope-keyed credential store without writing, locking or rewriting it.
 *
 * An absent or empty file is the signed-out state a crashed writer leaves behind, not
 * corruption; a file that cannot be parsed is reported through {@link GrokAuthStoreRead.error}.
 * No entry value is retained: `key` and `refresh_token` are reduced to booleans in-process.
 *
 * @param options - Read-only probe and the resolved credential path.
 * @returns The store's presence, its parsed entries, and the read error when there is one.
 */
export async function readGrokAuthStore(options: {
  files: FileProbe
  credentialPath: string
}): Promise<GrokAuthStoreRead> {
  const read = await options.files.readHead(options.credentialPath)
  if (read.missing) return { present: false, entries: [] }
  // An empty file is the signed-out state a crashed writer leaves behind, not corruption.
  const trimmed = read.text.trim()
  if (trimmed === '') return { present: true, entries: [] }
  if (read.truncated) {
    return { present: true, entries: [], error: 'the credential store is larger than a single bounded read' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (cause) {
    return { present: true, entries: [], error: cause instanceof Error ? cause.message : String(cause) }
  }
  return { present: true, entries: parseGrokAuthStore(parsed) }
}

/** Everything the credential service needs from its adapter. */
export interface GrokAuthDeps {
  /** Read-only filesystem helpers. */
  files: FileProbe
  /** Managed process runner for the native CLI. */
  runner: ProcessRunner
  /** Resolved store locations. */
  paths: GrokPaths
  /** Host environment, inspected for credential variables. */
  hostEnv: NodeJS.ProcessEnv
  /** Environment handed to a `grok login`/`grok logout` child. */
  childEnv: Readonly<Record<string, string>>
  /** Environment derivation mode for CLI children. */
  envMode: AdapterRuntimeConfig['envMode']
  /** Whether `grok models` may be spawned to confirm an otherwise empty store. */
  probeCli: boolean
  /** Logger for diagnostics; never receives credential material. */
  log: Logger
  /** Resolves the binary lazily, so status does not pay for detection it will not use. */
  resolveBinary: () => Promise<string>
}

/** Read-only status inspection plus delegated login/logout. */
export class GrokAuthService {
  /**
   * @param deps - Adapter-supplied ports and resolved paths.
   */
  constructor(private readonly deps: GrokAuthDeps) {}

  /**
   * Observe the credential state without writing anything.
   *
   * @returns The classified state; `misconfigured` for an unreadable store and
   *   `unauthenticated` only when nothing at all supplies a credential.
   */
  async status(): Promise<AgentAuthState> {
    const observedAt = new Date().toISOString()
    const environmentKeys = this.credentialEnvKeys()
    const store = await this.readStore()
    const entry = selectGrokAuthEntry(store.entries)
    const base: AgentAuthState = {
      agentId: AGENT_ID,
      status: 'unknown',
      source: 'none',
      credentialPath: this.deps.paths.credentialPath,
      environmentKeys,
      observedAt,
    }

    // grok's own banner reports the environment key ahead of the file, so an env
    // credential is the state a run will actually use.
    if (environmentKeys.length > 0) {
      const method = methodForEnvKey(environmentKeys[0] ?? '')
      return {
        ...base,
        status: 'authenticated',
        source: 'env',
        method,
        ...(entry?.email === undefined ? {} : { account: entry.email }),
        ...(entry?.teamName === undefined ? {} : { plan: entry.teamName }),
        ...(entry?.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
        detail: `${method} credential comes from the environment; MutiAgent cannot log it out or rotate it`,
      }
    }

    if (store.error !== undefined) {
      return {
        ...base,
        status: 'misconfigured',
        source: 'file',
        detail: `the credential store could not be read: ${store.error}`,
      }
    }

    if (entry !== undefined) {
      const method = grokMethodLabel(entry.authMode)
      if (!entry.hasKey) {
        return {
          ...base,
          status: 'misconfigured',
          source: 'file',
          method,
          detail: `the ${entry.scope} entry carries no credential material`,
        }
      }
      const everyEntryDead = store.entries.every(candidate => candidate.expired && !candidate.hasRefreshToken)
      if (everyEntryDead) {
        return {
          ...base,
          status: 'expired',
          source: 'file',
          method,
          ...(entry.email === undefined ? {} : { account: entry.email }),
          ...(entry.teamName === undefined ? {} : { plan: entry.teamName }),
          ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
          detail: 'every stored credential is past its expiry and none can be refreshed; run `grok login` again',
        }
      }
      const details: string[] = []
      if (!entry.hasExpiry) details.push('grok stores no expiry for this credential')
      if (entry.scope === LEGACY_SCOPE) {
        details.push('this is the legacy web-login scope, which grok re-validates per request')
      }
      return {
        ...base,
        status: 'authenticated',
        source: 'file',
        method,
        ...(entry.email === undefined ? {} : { account: entry.email }),
        ...(entry.teamName === undefined ? {} : { plan: entry.teamName }),
        ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
        ...(details.length === 0 ? {} : { detail: details.join('; ') }),
      }
    }

    const probe = this.deps.probeCli ? await this.probeBanner() : undefined
    if (probe !== undefined) {
      return {
        ...base,
        status: probe.status,
        source: 'cli-probe',
        method: probe.method,
        detail: probe.detail,
      }
    }
    return {
      ...base,
      status: 'unauthenticated',
      source: 'file',
      detail: 'no credential file, no credential environment variable, and no CLI confirmation is available',
    }
  }

  /**
   * Start a credential flow through the native CLI.
   *
   * @param params - The declared flow to run; a flow grok cannot complete
   *   non-interactively is reported with the interaction a human must perform.
   * @returns The observed post-state, never the requested intent.
   */
  async login(params: LoginParams): Promise<AuthOperationResult> {
    const state = async (): Promise<AgentAuthState> => this.status()
    if (params.flow === 'api-key') {
      this.deps.log.warn('grok has no non-interactive api-key login; the flow must be completed by a human')
      return {
        ok: false,
        action: 'login',
        interaction: {
          kind: 'stdin-secret',
          instructions:
            'Grok Build has no `--api-key` login flag, so a pasted key cannot be delegated. Set XAI_API_KEY in the adapter environment, or run `grok login` in a terminal.',
        },
        state: await state(),
      }
    }
    if (params.flow === 'interactive') {
      return {
        ok: false,
        action: 'login',
        interaction: {
          kind: 'none',
          instructions: 'Run `grok login` in a terminal; the loopback flow needs a browser and a TTY-less child cannot host it.',
        },
        state: await state(),
      }
    }

    const binary = await this.deps.resolveBinary()
    const args = params.flow === 'device-code' ? ['login', '--device-auth'] : ['login', '--oauth']
    const outcome = await this.deps.runner.run({
      command: binary,
      args,
      cwd: this.deps.paths.home,
      envMode: this.deps.envMode,
      env: this.deps.childEnv,
      inheritKeys: GROK_MANAGED_ENV_KEYS,
      timeoutMs: 300_000,
      captureBytes: 64 * 1024,
    })
    const captured = `${streamText(outcome.stdout)}\n${streamText(outcome.stderr)}`
    const output = redact(captured)
    const interaction = interactionOf(captured, params.flow)
    return {
      ok: outcome.code === 0,
      action: 'login',
      ...(interaction === undefined ? {} : { interaction }),
      state: await state(),
      ...(output === '' ? {} : { output }),
    }
  }

  /**
   * Revoke credentials through the native CLI.
   *
   * @returns Whether `grok logout` succeeded, plus the observed post-state.
   */
  async logout(): Promise<AuthOperationResult> {
    const binary = await this.deps.resolveBinary()
    const outcome = await this.deps.runner.run({
      command: binary,
      args: ['logout'],
      cwd: this.deps.paths.home,
      envMode: this.deps.envMode,
      env: this.deps.childEnv,
      inheritKeys: GROK_MANAGED_ENV_KEYS,
      timeoutMs: 30_000,
      captureBytes: 64 * 1024,
    })
    const output = redact(`${streamText(outcome.stdout)}\n${streamText(outcome.stderr)}`)
    return {
      ok: outcome.code === 0,
      action: 'logout',
      state: await this.status(),
      ...(output === '' ? {} : { output }),
    }
  }

  /**
   * Names of credential variables actually present in the host environment.
   *
   * @returns Variable names in grok's own precedence order.
   */
  credentialEnvKeys(): readonly string[] {
    return GROK_CREDENTIAL_ENV_KEYS.filter(name => {
      const value = this.deps.hostEnv[name]
      return value !== undefined && value !== ''
    })
  }

  /** Read the credential store without writing, locking or rewriting it. */
  private async readStore(): Promise<GrokAuthStoreRead> {
    return await readGrokAuthStore({ files: this.deps.files, credentialPath: this.deps.paths.credentialPath })
  }

  /** Confirm an otherwise empty store with the first line of `grok models`. */
  private async probeBanner(): Promise<{ status: AuthStatus; method: string; detail: string } | undefined> {
    const binary = await this.deps.resolveBinary()
    const outcome = await this.deps.runner.run({
      command: binary,
      args: ['models'],
      cwd: this.deps.paths.home,
      envMode: this.deps.envMode,
      env: this.deps.childEnv,
      inheritKeys: GROK_MANAGED_ENV_KEYS,
      timeoutMs: 30_000,
      captureBytes: 64 * 1024,
    })
    const banner = firstLine(`${outcome.stdout.head}${outcome.stdout.tail}`)
    if (banner === undefined) return undefined
    if (banner.startsWith('You are using XAI_API_KEY')) {
      return { status: 'authenticated', method: 'api-key', detail: 'grok reports it is using XAI_API_KEY' }
    }
    if (banner.startsWith('You are authenticated via deployment key')) {
      return {
        status: 'authenticated',
        method: 'deployment-key',
        detail: 'grok reports a deployment key; MutiAgent cannot log it out',
      }
    }
    const host = /^You are logged in with (.+?)\.?$/.exec(banner)
    if (host !== null) {
      return {
        status: 'authenticated',
        method: 'web-login',
        detail: `grok reports a login for ${host[1] ?? 'an unknown host'}`,
      }
    }
    if (banner.startsWith('You are not authenticated')) {
      return { status: 'unauthenticated', method: 'none', detail: 'grok reports no credentials' }
    }
    const model = /^Model '.+' is using its own API key\.$/.exec(banner)
    if (model !== null) {
      return { status: 'authenticated', method: 'model-api-key', detail: banner }
    }
    return undefined
  }
}

/**
 * Project the interaction a login flow requires.
 *
 * @param output - Combined CLI output.
 * @param flow - The flow that produced it.
 * @returns The interaction, or `undefined` when the output carried neither a URL nor a code.
 */
export function interactionOf(
  output: string,
  flow: CredentialFlow,
): AuthOperationResult['interaction'] | undefined {
  const url = /https?:\/\/[^\s"'<>]+/.exec(output)?.[0]
  const code = /(?:^|\s)([A-Z0-9]{4}(?:-[A-Z0-9]{4,})+)(?:\s|$)/.exec(output)?.[1]
  if (url === undefined && code === undefined) return undefined
  if (flow === 'device-code') {
    return {
      kind: 'device-code',
      ...(url === undefined ? {} : { url }),
      ...(code === undefined ? {} : { code }),
      instructions: 'Open the URL in a browser and confirm the code shown there matches the code below.',
    }
  }
  return {
    kind: 'browser-url',
    ...(url === undefined ? {} : { url }),
    instructions: 'Complete the sign-in in the browser that was opened; the run finishes when grok receives the callback.',
  }
}

/** Credential method implied by an environment variable name. */
function methodForEnvKey(name: string): string {
  switch (name) {
    case 'XAI_API_KEY':
      return 'api-key'
    case 'GROK_CODE_XAI_API_KEY':
      return 'api-key-legacy'
    case 'GROK_AUTH':
      return 'legacy-token'
    case 'GROK_DEPLOYMENT_KEY':
      return 'deployment-key'
    default:
      return 'unknown'
  }
}

/** Whether an entry represents an account login rather than a bare key. */
function isAccountLogin(scope: string, authMode: string): boolean {
  if (authMode === 'api_key') return false
  return authMode === 'web_login' || authMode === 'oidc' || authMode === 'external' || scope !== API_KEY_SCOPE
}

/** First non-empty line of a block of text. */
function firstLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

/** One captured stream as text, joining head and tail only when bytes were dropped. */
function streamText(stream: { head: string; tail: string; droppedBytes: number }): string {
  return stream.droppedBytes === 0 ? stream.head : `${stream.head}\n[output omitted]\n${stream.tail}`
}

/** Redact and cap CLI output before it leaves the adapter. */
function redact(text: string): string {
  const redacted = new Redactor().apply(text).trim()
  return redacted.length > AUTH_OUTPUT_CHARS ? redacted.slice(redacted.length - AUTH_OUTPUT_CHARS) : redacted
}

/** An RFC3339 timestamp kept verbatim, when it parses. */
function isoValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
}
