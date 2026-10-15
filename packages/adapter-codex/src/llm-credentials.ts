/**
 * Read access to Codex's stored credential, in memory only.
 *
 * ADR-0010 keeps MutiAgent out of the credential business: `auth.ts` reports a
 * credential's *state* and never a value. This module is the one deliberate
 * exception, and it is narrow on purpose: an LLM request must be authenticated,
 * so the bearer that Codex itself would send is read from `$CODEX_HOME/auth.json`
 * (read-only, through {@link FileProbe}) into memory for that one request. The
 * value is never logged, persisted, projected or returned in an error; only the
 * *kind* it came from, an account id and an expiry are observable, and
 * {@link CodexBearer.reason} explains a refusal without quoting anything.
 *
 * Nothing here writes, refreshes or invalidates: Codex's own `codex login` owns
 * the store, and a token this module finds expired is refused rather than
 * refreshed, because refreshing is a mutation this project does not perform.
 *
 * @module @zorker/muti-agent-adapter-codex/llm-credentials
 */

import type { FileProbe } from '@zorker/muti-agent-core'

import { decodeIdTokenClaims } from './auth.ts'
import type { CodexHome } from './sessions.ts'

/** Credential mechanisms this reader can turn into a bearer header. */
export type CodexBearerKind = 'chatgpt' | 'api_key'

/** A usable credential, held in memory for one request. */
export interface CodexBearer {
  /** The exact value of the `Authorization: Bearer` header; never logged or persisted. */
  readonly value: string
  /** Which store field it came from, for diagnostics that name no value. */
  readonly kind: CodexBearerKind
  /** ChatGPT account id, sent as `chatgpt-account-id` on a chatgpt credential. */
  readonly accountId?: string
  /**
   * ISO 8601 expiry decoded from the id_token, when it carried one. A token whose
   * expiry has passed is refused before this type is constructed, so this is
   * always a future instant.
   */
  readonly expiresAt?: string
}

/** The outcome of reading the store: a credential, or the reason there is none. */
export type CodexBearerRead =
  | { readonly bearer: CodexBearer; readonly reason?: never }
  | { readonly bearer?: never; readonly reason: string }

/**
 * Read the credential Codex would send for a route that requires OpenAI auth.
 *
 * The environment is deliberately not consulted: an `env_key` route takes its
 * credential from the named variable, and reading an ambient `OPENAI_API_KEY`
 * for a route that did not ask for it would bill a different tenant.
 *
 * @param files - Read-only filesystem helpers.
 * @param home - Resolved Codex home layout.
 * @returns The credential, or the reason it cannot be used.
 */
export async function readCodexBearer(files: FileProbe, home: CodexHome): Promise<CodexBearerRead> {
  const parsed = await files.readJson<unknown>(home.credentialFile)
  if (!parsed.ok) {
    return parsed.missing
      ? { reason: `no credential is stored in ${home.credentialFile}` }
      : { reason: `${home.credentialFile} could not be read: ${parsed.error}` }
  }
  const record = asRecord(parsed.value)
  if (record === undefined) return { reason: `${home.credentialFile} is not a JSON object` }

  const tokens = asRecord(record['tokens'])
  const accessToken = str(tokens, 'access_token')
  if (accessToken !== undefined) {
    const claims = decodeIdTokenClaims(str(tokens, 'id_token') ?? '')
    const expirySeconds = num(claims, 'exp')
    if (expirySeconds !== undefined && expirySeconds * 1000 <= Date.now()) {
      return {
        reason:
          `${home.credentialFile} holds a ChatGPT token that expired at ${new Date(expirySeconds * 1000).toISOString()};`
          + ' run `codex login` to refresh it, or set the provider\'s env_key',
      }
    }
    const accountId = str(claims, 'chatgpt_account_id')
    return {
      bearer: {
        value: accessToken,
        kind: 'chatgpt',
        ...accountId === undefined ? {} : { accountId },
        ...expirySeconds === undefined ? {} : { expiresAt: new Date(expirySeconds * 1000).toISOString() },
      },
    }
  }
  const apiKey = str(record, 'OPENAI_API_KEY')
  if (apiKey !== undefined) {
    return { bearer: { value: apiKey, kind: 'api_key' } }
  }
  const unsupported = ['personal_access_token', 'agent_identity', 'bedrock_api_key', 'bedrock_access_keys'].filter(
    key => record[key] !== undefined,
  )
  if (unsupported.length > 0) {
    return {
      reason:
        `${home.credentialFile} authenticates with ${unsupported.join(', ')}, which this adapter does not turn into`
        + ' a bearer header; use a provider env_key instead',
    }
  }
  const mode = str(record, 'auth_mode')
  return {
    reason:
      mode === undefined
        ? `${home.credentialFile} holds no access token and no API key`
        : `${home.credentialFile} records auth_mode "${mode}" but no usable bearer material`,
  }
}

/** A re-readable credential source: each request observes the store as it is then. */
export interface CodexBearerSource {
  /**
   * Resolve the credential for one request.
   * @returns The credential as it is now, or the reason it is unusable.
   */
  read(): Promise<CodexBearerRead>
}

/**
 * A {@link CodexBearerSource} over one Codex home.
 *
 * The store is re-read per request rather than cached, so a `codex login` that
 * happens while the harness runs is honoured by the next call, and a rotated
 * token cannot be sent after Codex replaced it.
 *
 * @param files - Read-only filesystem helpers.
 * @param home - Resolved Codex home layout.
 * @returns The source.
 */
export function codexBearerSource(files: FileProbe, home: CodexHome): CodexBearerSource {
  return { read: () => readCodexBearer(files, home) }
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
