# The wire contract

Three surfaces expose one catalog. This document is the contract a client may depend on:
method names, the envelope, the streaming format, and the MCP mapping.

Implementation: `packages/control-plane/src/{dispatch,gateway,tools}.ts`,
`packages/control-plane/src/mcp/server.ts`.
Decisions: [ADR-0004](../adr/0004-host-client-transport.md),
[ADR-0011](../adr/0011-mcp-control-plane.md).

## HTTP: the authenticated gateway

All three routes are registered on the harness's own `/api` channel
(`ctx.connection.fetch.register`), so the harness applies its browser-trust fence —
loopback `Host`, same-origin, signed session cookie — **before** a request reaches us. An
unauthenticated or cross-site request is refused by the harness and never dispatches.

| Route | Method | Body mode | Purpose |
|---|---|---|---|
| `/api/mutiagent/rpc` | `POST` | buffered | One method invocation |
| `/api/mutiagent/events` | `GET` | — | Server-sent event stream |
| `/api/mutiagent/mcp` | `POST` | buffered | MCP over streamable HTTP |

### Request

```json
{ "method": "sessions.list", "params": { "limit": 20 }, "confirm": false }
```

- `method` — an operation id ([`tools.md`](tools.md)). Unknown → `wire/unknown-method`.
- `params` — validated against that operation's schema. Invalid → `wire/bad-params`, whose
  message names every offending path.
- `confirm` — an **envelope-level** flag, not a parameter. It is stripped before the
  operation's own schema sees the request, so it can never be mistaken for data. Required
  for an operation whose `danger` is not `safe` when the caller is not trusted.

### Response

```json
{
  "ok": true,
  "schemaVersion": 1,
  "wireVersion": 1,
  "result": { "sessions": [] }
}
```

A failure is an HTTP 200 with a failure envelope — never a non-200 for a domain error, so
a client distinguishes transport health from operation outcome by the envelope alone:

```json
{
  "ok": false,
  "schemaVersion": 1,
  "wireVersion": 1,
  "error": {
    "code": "worktree/not-a-repository",
    "message": "/tmp/x is not inside a git work tree",
    "remediation": "Initialize a repository, or run with isolation=shared-cwd.",
    "details": { "path": "/tmp/x" },
    "retryable": false
  }
}
```

Only a malformed envelope (unparsable JSON, oversized body) answers non-200.

### Confirmation

A dangerous operation reached by an **untrusted** caller does not act; it returns a
challenge in place of a result:

```json
{ "ok": true, "result": {
  "confirmationRequired": true,
  "operation": "worktrees.remove",
  "prompt": "Remove a worktree MutiAgent owns. Unmerged work requires force. This cannot be undone automatically.",
  "howToConfirm": "Repeat with {\"confirm\": true} after a human has approved worktrees.remove."
} }
```

A **trusted** caller (the GUI, the harness's own agent, a slash command) passes the gate
directly, because the harness has already proven the user owns this process and the GUI
confirms before every irreversible action in its own dialog. This asymmetry is deliberate:
the gate exists to stop an *external* client from taking an irreversible action without a
human, not to make the GUI double-confirm.

## SSE: the event stream

`GET /api/mutiagent/events` returns `text/event-stream`, opened with a comment frame so
the client's `open` fires immediately:

```
: mutiagent 1/1

data: {"kind":"run-event","at":"2026-10-15T12:00:00.000Z","runId":"run-abc","event":{"kind":"message.delta","text":"…"}}

: keep-alive
```

- Each `data:` line is one [`MeshEvent`](schema.md#meshevent) as JSON.
- Heartbeat every 15 s (`gateway.heartbeatMs`) keeps intermediaries from closing an idle
  stream.
- A client that falls behind by more than 512 unread events has its queue dropped rather
  than growing host memory; it should re-read state (`runs.list`, `sessions.partitions`)
  on reconnect. The stream carries no replay log, by design: state operations are the
  source of truth and the stream is a change signal.
- `EventSource` reconnects on its own. The bundled client additionally falls back to a
  5-second poll of `runs.list` and `sessions.partitions` while the stream is down.

## MCP

Two transports, one server (`packages/control-plane/src/mcp/server.ts`). The subset
implemented is `initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
`ping`; notifications are accepted and never answered.

### stdio

```sh
MUTI_AGENT_STATE_DIR=/path/to/shared/state node packages/plugin/lib/mcp-stdio.js
```

One JSON-RPC message per line on stdin; responses on stdout; diagnostics on stderr. Frames
are handled in order, so a client can pipeline. A malformed frame is answered with a
`-32700` parse error rather than ignored, because a client waiting on a response would
otherwise hang.

`MUTI_AGENT_STATE_DIR` is **required**. Without it the server refuses to start rather than
creating a second, empty world that would disagree with the harness's.

### Streamable HTTP

`POST /api/mutiagent/mcp` with a JSON-RPC message (or a batch array). Responses are JSON.
The session id is returned in the `mcp-session-id` response header at `initialize` and
echoed by the client on later requests; a client that sends no header is served by the
only open session, so a simple single-session client works without implementing session
management.

A tool failure is a **successful** JSON-RPC call with `isError: true` and a text content
block carrying `code: message` plus the remediation line — that is what tells a model the
tool ran and failed, as opposed to the protocol being broken.

### Tool naming

`mutiagent_<operation id with dots replaced by underscores>`, for example
`sessions.list` → `mutiagent_sessions_list`. The mapping is **not injective**, so the
server resolves a tool name by deriving each exposed operation's name and comparing, never
by reversing the string transform — a lookup that guesses is a lookup that eventually
calls the wrong method.

Tool annotations mirror the catalog: `readOnlyHint` for `scope: 'read'`,
`destructiveHint` for `danger: 'irreversible'`, `openWorldHint` for anything that mutates.

### Protocol versions

`2025-06-18`, `2025-03-26`, `2024-11-05`. An unknown requested version negotiates down to
`2025-06-18` rather than failing, so a newer client is not locked out.

## Native harness tools

Every operation with `exposeAsTool: true` is registered on `ctx.tools` as
`mutiagent_<operation>`, with the operation's own JSON Schema as its `parameters` and a
pure `render` projection. Definitions are built structurally rather than with the
harness's `defineTool` helper ([ADR-0006](../adr/0006-zero-mandatory-harness-imports.md)).

A failed operation is thrown as `ToolCallFailure`, so the harness reports a failed tool
call — which is what lets the model correct itself — rather than a success carrying an
error body. A confirmation challenge is returned as a normal result, because it is
information the model needs, not a failure.

## Slash commands

| Command | Operation |
|---|---|
| `/agents` | `credentials.list` |
| `/agent-sessions` | `sessions.partitions` |
| `/agent-refresh` | `sessions.refresh` |
| `/agents-diagnostics` | `agents.diagnostics` |
| `/mesh-runs` | `runs.list` |
| `/mesh-state` | the state directory and isolation mode |

## Compatibility

- `schemaVersion` — bumped when an existing field changes meaning or a required field is
  added; additive optional fields do not bump it.
- `wireVersion` — bumped when the envelope itself changes.
- `mutiagent.methods` reports both, plus the plugin version, from a single source of truth
  (`packages/contracts/src/version.ts`).

A client should call `mutiagent.methods` once and treat the returned `inputSchema` per
method as authoritative; the schemas are emitted from the same declaration the dispatcher
validates with, so they cannot drift.
