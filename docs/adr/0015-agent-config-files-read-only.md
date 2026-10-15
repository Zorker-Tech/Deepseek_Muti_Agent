# ADR-0015 — Agent configuration files are read, never written

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

A machine's usable models are mostly **not** built into an agent. They are declared in its
configuration file, together with the endpoint and the environment variable that carries
the key:

| Agent | File | Declares |
|---|---|---|
| Codex | `$CODEX_HOME/config.toml` | `model`, `review_model`, `[model_providers.*]` with `base_url`/`env_key`/`wire_api`, `model_catalog_json`, project layer `.codex/config.toml` |
| Grok Build | `$GROK_HOME/config.toml` | `[models] default`, `allowed_models`, `[model.<id>]`, plus `GROK_CONFIG`/`GROK_CONFIG_PATH` JSON overlays |
| Pi | `<agent-dir>/models.json` (+ `settings.json`) | `providers` with `baseUrl`/`api`/`apiKey` and their `models`, `modelOverrides`, `defaultProvider`/`defaultModel`/`enabledModels` |

Observed on the machine this was built on: Codex's default model and its `deepseek` provider
at `https://api.deepseek.com` come from `~/.codex/config.toml`; Pi's two providers at LAN
addresses and both of its models come from `~/.pi/agent/models.json`. A catalog built from
each product's built-in list would have been wrong about both.

The obvious next question is whether MutiAgent should also **write** these files, since a
user managing several agents would like one place to add a provider or change a default.

## Decision

**Read, never write.**

1. Each adapter produces an `AgentModelCatalog` (`packages/contracts/src/models.ts`) from the
   agent's own configuration files, in that agent's own precedence order, reporting every
   file it read in `sources` and every loss in `notes`.
2. **No configuration file is ever modified.** This is the same commitment ADR-0012 makes for
   session stores: MutiAgent does not edit another product's state. A user who wants to add a
   provider edits that agent's file, and MutiAgent's next read reflects it.
3. **Secrets are never read.** `AgentProvider.apiKeyEnv` is the *name* of a variable;
   `credentialPresent` is whether it exists. A literal key or a `!command` reference in
   `models.json` is reported as declared, never evaluated, never emitted.
4. **A parse failure is a declared gap.** A malformed file yields the recoverable subset plus
   a `ProjectionNote` naming the file and the reason. `listModels` never throws: one agent
   with an unreadable config must not hide the other two.
5. **The catalog is a menu, not a whitelist.** `preferences.set` does not validate a model id
   against the catalog, because an agent accepts models its own configuration never names (a
   provider's served list, a built-in catalog). Refusing an unknown id would reject a model
   the agent would happily run.
6. **No network calls.** Where a configuration names a remote catalog
   (Codex's `model_catalog_url`, Pi's pi.dev overlay, Grok's endpoint-served list), the URL is
   reported and not fetched. A control plane that made network requests to render a dropdown
   would be slow, offline-hostile, and surprising.
7. **One added dependency: `smol-toml`, bundled.** Codex and Grok are TOML; Pi is JSON. The
   parser is a build-time concern of the host artifact (esbuild inlines it), so it adds no
   install-time requirement for a user, and it is used strictly for reading. Hand-rolling a
   TOML reader was rejected — the failure mode of a subtly wrong parser is a silently wrong
   model list.

## Consequences

**Positive**

- The model list is true for this machine, which is the only list that matters for choosing
  what to run.
- The provenance is visible: the composer control's tooltip names the provider's endpoint, the
  key variable, and the file the answer came from, so "where does this model come from" is one
  hover away.
- Zero risk of corrupting another product's configuration, including its comments and
  formatting.

**Negative / accepted costs**

- **Managing a model from the GUI is impossible.** Adding a provider, changing a default, or
  rotating an endpoint means editing the agent's file. The plugin surfaces the path and the
  current content, and stops there. This is the cost of the decision above and it is stated in
  the UI rather than discovered.
- TOML round-tripping was never attempted, so comment and key-order preservation — the usual
  reason configuration writers are refused — never becomes a problem.
- A file the user edits while MutiAgent reads it can be observed mid-write; reads go through
  the bounded, writer-tolerant probe from ADR-0014, and a torn read is a declared gap.
- Each adapter carries a reader for one product's configuration dialect, and a changing format
  means a reader update. Bounded by one module per adapter (`src/models.ts`).

## Alternatives considered

- **Write configuration files.** Rejected for now: TOML serialization without destroying
  comments, per-product schema versions, and concurrent edits by the agent itself are three
  separate failure modes, for a feature a user can already accomplish by editing the file. If
  it is ever added, it needs its own ADR with a backup-and-diff protocol, not a quiet write.
- **Read the product's built-in model list instead of configuration.** Rejected: that is the
  list which is *wrong* for this machine. It also cannot exist for Codex (no built-in list at
  all).
- **Fetch remote catalogs** (`model_catalog_url`, pi.dev, the agent's endpoint). Rejected per
  decision 6; kept as a possible explicit, user-initiated refresh later.
- **One shared model pool across agents.** Rejected: a model id means different things to
  different agents (`gpt-6-luna` via a corporate gateway is not the same route as the same
  name from OpenAI), so the catalog stays per agent and the preference is keyed by agent.
