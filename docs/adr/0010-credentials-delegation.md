# ADR-0010 — Credential management by delegation plus read-only inspection

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

The requirement: plugin settings must manage each agent's authentication — show status,
and log in / log out from the settings page, without the user having to go to each agent's
CLI or another surface.

Facts per agent (verified in source):

| | Codex | Grok Build | Pi |
|---|---|---|---|
| File | `$CODEX_HOME/auth.json` | `$GROK_HOME/auth.json` | `<agent-dir>/auth.json` |
| Shape | `auth_mode`, `OPENAI_API_KEY`, `tokens{id_token,access_token,refresh_token,account_id}`, `last_refresh` | map keyed by scope (`xai::api_key`, OIDC issuer) → `{key, auth_mode, expires_at, email, team_*}` | map `providerId → {type:'api_key'\|'oauth', …}` |
| Alt stores | OS keyring / ephemeral (`cli_auth_credentials_store`) | `GROK_AUTH_PATH`, deployment key | `key: "!command"` indirection, provider env vars |
| Env keys | `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` | `XAI_API_KEY`, `GROK_AUTH`, `GROK_DEPLOYMENT_KEY` | ~40 provider vars |
| Login | `codex login [--device-auth\|--with-api-key]` | `grok login [--device-auth\|--oidc]` | `/login` (TUI) or `pi auth check` for status |
| Logout | `codex logout` | `grok logout` | `/logout` (TUI) |
| Status probe | `codex login status` (stderr, exit 0/1) | `grok models` banner / ACP `x.ai/auth/info` | `pi auth check --json` (exit 0/1/2) |
| Plan/account info | parseable from the id_token in `auth.json` | `email`, `team_*` in `auth.json` | provider-dependent; `pi auth check --json` |

Three considerations dominate the design:

1. **We must never become a credential store.** Duplicating tokens into MutiAgent state
   would create a second thing to leak, rotate and invalidate.
2. **Refresh flows are the agent's business.** Codex's `AuthManager` refreshes lazily and
   writes back; Grok invalidates 5 minutes early; Pi refreshes through its OAuth provider
   layer. Reimplementing any of that would race the owner.
3. **Some state is only knowable by asking the binary** (whether an env-injected key is
   usable, which provider is "ready"), and some is only knowable by reading files (email,
   plan, expiry) — each agent exposes a different subset in each direction.

## Decision

1. **Read-only inspection for status.** `auth.status(agentId)` reads the credential file
   **without writing, locking or rewriting it**, plus the relevant environment variables,
   and classifies:
   `authenticated | unauthenticated | expired | misconfigured | unknown`.
   The result carries `method`, `account`, `plan`, `expiresAt`, `credentialPath`,
   `source: 'file' | 'env' | 'keyring' | 'cli-probe'` and `diagnostics`.
   File reads are tolerant: an unparsable file yields `misconfigured` with the parse
   error, never a crash and never a fabricated "logged out".
2. **Login and logout are delegated to the native CLI.** MutiAgent spawns the agent's own
   `login`/`logout` command as a managed subprocess and streams its output to the settings
   page. The plugin never writes a token.
   - Interactive flows (Codex loopback OAuth, device codes) are surfaced, not swallowed:
     the streamed output — including a device URL/user code or an authorization URL — is
     shown in the settings panel, and the subprocess is held open until it exits.
   - API-key entry is a form field whose value is passed on **stdin** to
     `codex login --with-api-key` / equivalent, never as an argv element (argv is visible
     in the process table) and never logged. The value is redacted in every stream, tool
     result and diagnostic, using a redactor seeded with the submitted value.
   - If an agent has no non-interactive login path, the settings page says so and offers
     **"Open native login"** (launch the agent's TUI in a terminal) instead of pretending.
3. **Verification after mutation.** Every login/logout ends with a fresh `status()`; the
   UI reports the observed post-state, not the intent. A login that exits 0 but leaves no
   usable credential is reported as `unauthenticated` with the CLI output attached.
4. **Secrets never leave the host process.** The `AgentAuthState` projection has no secret
   field by construction; redaction is applied to the outbound envelope at the gateway
   boundary, so a future adapter cannot accidentally leak by adding a field. Only the
   presence, kind, and metadata of a credential are ever transmitted.
5. **Per-agent capability declaration.** `AgentCapabilities.credentials` declares
   `{ status: boolean, login: ('oauth' | 'device-code' | 'api-key' | 'interactive')[],
   logout: boolean }`. The settings page renders exactly what an adapter supports, so a
   future agent with no programmatic login degrades to an explanation, not a dead button.
6. **Environment-provided credentials are first-class.** A key found in the environment is
   reported as `source: 'env'` and marked "not manageable here" — MutiAgent cannot log out
   a variable, and claiming otherwise would be a lie the user discovers later.

## Consequences

**Positive**

- Zero new secret storage; the attack surface for MutiAgent's own state stays trivial.
- Refresh, rotation and revocation semantics stay exactly the agent's own.
- Collisions with a concurrent agent process are impossible because we do not write.

**Negative / accepted costs**

- Status accuracy depends on reading another product's file format, which may change.
  Mitigated: parse failures are `misconfigured`/`unknown` with the raw error visible, and
  the optional CLI probe (`codex login status`, `pi auth check --json`) is the fallback.
- Device-code and loopback OAuth flows need a human in the loop; the settings page must
  stay open, and we cannot complete them headlessly. That is inherent to the agents'
  designs.
- A user could have a valid credential in the OS keyring only (Codex
  `cli_auth_credentials_store = keyring`), which we cannot read. Reported as `unknown`
  with `source: 'keyring'` and the CLI probe is used instead.

## Alternatives considered

- **Own the OAuth flows in MutiAgent** (implement the provider handshakes ourselves).
  Rejected: we would need each provider's client id, redirect rules and refresh policy,
  we would write tokens into someone else's file format, and any provider change would
  strand users on our implementation.
- **Copy credentials into MutiAgent state for a unified store.** Rejected: a second store
  to leak, plus guaranteed divergence from the agent's own refresher.
- **Shell out to the CLI for everything, including status.** Rejected as the only
  mechanism: a status probe costs a process start and several agents print status to
  stderr with exit-code semantics that vary by version; file inspection is instant and
  works offline. Both are used, with the CLI probe as fallback.
- **RRF-based keyring integration.** Not portable, and unnecessary once we delegate.
