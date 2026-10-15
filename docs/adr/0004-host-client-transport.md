# ADR-0004 — Host↔client transport: authenticated fetch routes + SSE, not Typert RPC

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

The harness GUI is a browser Cordis tree. Its normal host↔client path is Typert:
host services annotate methods with `@Remote`, a code generator emits descriptors and
codecs per package, `@deepseek-ai/dsh-api-remotes` mounts them, and the client calls
`ctx.remote.<namespace>.<method>(…)`. Events are forwarded only for a fixed allowlist
(`API_REMOTE_FORWARDED_EVENTS`).

That path is not usable out-of-tree without vendoring the generator and participating in
the harness's client-assembly graph. Two other documented seams exist:

1. `ctx.webServer.register({ kind, path, handler })` — raw `node:http` request/response,
   **no authentication applied**. Any local process (or a DNS-rebound browser page) could
   call it. Acceptable for the harness's own loopback helpers; not acceptable for an
   endpoint that spawns agent processes and reports credentials.
2. `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` — an exact
   Fetch route on the shared `/api` channel. The physical carrier applies its trust and
   authentication policy first, and **only owner Peers reach an exact route**; every other
   principal gets 403. Routes also get the parsed `Request`/`Response` shape and a
   body-mode declaration (`buffered` under the JSON cap, or `streaming` with backpressure).

## Decision

MutiAgent's browser↔host API uses **`ctx.connection.fetch.register`** exclusively:

- **One request/response endpoint** — `POST /api/mutiagent/rpc` — carrying a
  `{ method, params }` envelope and returning `{ ok, result }` or `{ ok:false, error }`.
  A method registry (not N routes) keeps route registration a single effect and makes the
  surface introspectable: `GET`-shaped `mutiagent.methods` returns the catalog, which the
  MCP server and the tool catalog also derive from.
- **One Server-Sent Events endpoint** — `GET /api/mutiagent/events` — streaming
  `AgentRunEvent`, todo/plan changes and progress updates. SSE rather than a WebSocket
  because the harness owns the only upgrade path it exposes (`registerUpgrade` is per
  exact path and the browser's `/api` socket belongs to API Gateway); SSE needs no
  negotiation, reconnects with `Last-Event-ID`, and is trivially debuggable with `curl`.
- **No Typert.** No `@Remote` decorators, no generated descriptors, no client assembly
  participation. The client half uses plain `fetch('/api/mutiagent/rpc', …)` with the
  browser session cookie that the harness already set (`HttpOnly`, `SameSite=Strict`,
  `Path=/`), and `EventSource` for the stream.
- **The gateway degrades cleanly.** In a profile without a Web host (headless, ACP, SDK)
  the route registration is skipped and the same service graph remains reachable through
  `ctx.mutiAgent` and the MCP server. Registration is guarded by a capability probe, not
  by a profile name.

The wire contract is versioned and documented in `docs/reference/wire.md`; it is a public
interface of the plugin, because external MCP clients and scripts may also call it.

## Consequences

**Positive**

- Inheritance of the harness's browser-trust fence (loopback `Host`, same-`Origin`,
  signed cookie) for free. We add no new unauthenticated local surface.
- No code generation step, so the client bundle stays a plain CJS artifact (ADR-0005) and
  the plugin has no build-time dependency on harness internals.
- One method registry serves three consumers — HTTP, MCP tools, harness tools — so a new
  capability is added once.

**Negative / accepted costs**

- We are not on the harness's typed RPC path, so we own our own envelope validation
  (done once, with Standard Schemas from the contracts package) and our own error mapping.
- SSE over the `/api` channel holds a `node:http` response open; the harness's carrier
  documents streaming-body routes as supported, and client disconnection aborts the
  handler signal, which we honor by tearing down the stream.
- A future harness change to the exact-route contract would break the gateway. It is
  isolated behind one module (`src/host/gateway.ts`) with a capability probe, so the blast
  radius is a single file.

## Alternatives considered

- **Typert `@Remote` services.** Rejected: requires the generator and
  `@deepseek-ai/dsh-api-remotes` client assembly, both in-tree only (ADR-0001).
- **Raw `ctx.webServer.register`.** Rejected on security: no authentication, so any
  local process could dispatch runs and read credential status. Only defensible for
  read-only, secret-free endpoints; we have none.
- **WebSocket via `registerUpgrade`.** Rejected: the path is exact and the browser already
  owns its socket to the API Gateway; adding a second socket means our own reconnect,
  heartbeat and authentication handling. SSE is strictly less code for one-directional
  updates, and our uplink is ordinary `POST`s.
- **Polling instead of SSE.** Kept as the automatic fallback when `EventSource` is
  unavailable or the stream errors repeatedly, but not as the primary channel: run
  output is bursty and polling either lags or floods.
