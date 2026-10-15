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
import type { AgentAuthState, AgentId, AuthOperationResult } from '@zorker/muti-agent-contracts';
import type { AdapterContext, LoginParams } from '@zorker/muti-agent-core';
import { type OmpReadContext } from './sessions.ts';
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
export declare const OMP_PROVIDER_ENV_VARS: readonly string[];
/** Guidance shown when a credential operation has no non-interactive path. */
export declare const OMP_LOGIN_INSTRUCTIONS: string;
/** Guidance shown for logout, which has no CLI subcommand. */
export declare const OMP_LOGOUT_INSTRUCTIONS: string;
/** How a stored credential can be used, with no secret material. */
export type OmpCredentialKind = 'oauth' | 'api_key';
/** One provider's stored credential, classified without reading any secret value. */
export interface OmpStoredCredential {
    /** Provider id, verbatim. */
    provider: string;
    /** How OMP would resolve it. */
    kind: OmpCredentialKind;
    /** Whether it can authenticate a request right now. */
    usable: boolean;
    /** Whether the row is a `disabled_cause` tombstone rather than an active credential. */
    disabled: boolean;
    /** Expiry in milliseconds, for an OAuth credential whose row recorded one. */
    expiresMs?: number;
}
/** What one read of the credential store observed. */
export interface OmpCredentialObservation {
    /** One entry per recognizable row. */
    credentials: readonly OmpStoredCredential[];
    /** Rows whose `credential_type` this reader does not model. */
    unknownTypes: number;
    /** Whether the store file existed. */
    present: boolean;
    /** Whether the store was opened and queried. */
    readable: boolean;
    /** Why the store contributed nothing, when it did not; never secret material. */
    error?: string;
    /** Whether the OAuth expiry probe ran (it is a separate, guarded query). */
    expiryProbed: boolean;
}
/**
 * Read and classify the credentials OMP's `agent.db` holds.
 *
 * @param ctx - Ambient services (configuration and read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment and observation time; injected for testability.
 * @returns Auth state with no secret material anywhere inside.
 */
export declare function readOmpAuthStatus(ctx: OmpReadContext, agent: AgentId, options?: {
    env?: NodeJS.ProcessEnv;
    now?: number;
}): Promise<AgentAuthState>;
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
export declare function readOmpCredentials(ctx: OmpReadContext, options?: {
    env?: NodeJS.ProcessEnv;
    now?: number;
}): Promise<readonly OmpStoredCredential[]>;
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
export declare function loginOmp(ctx: AdapterContext, agent: AgentId, params: LoginParams, env?: NodeJS.ProcessEnv, binary?: string): Promise<AuthOperationResult>;
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
export declare function logoutOmp(ctx: AdapterContext, agent: AgentId, env?: NodeJS.ProcessEnv): Promise<AuthOperationResult>;
//# sourceMappingURL=auth.d.ts.map