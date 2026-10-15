# ADR-0003 — Per-agent transport strategy: headless exec first, duplex protocol when needed

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

Every target agent offers at least two programmatic surfaces, and they differ in shape:

| Agent | Simple, line-oriented | Rich, request/response |
|---|---|---|
| Codex | `codex exec --json` → JSONL `ThreadEvent` on stdout | `codex app-server --stdio` → JSON-RPC v2 (`thread/start`, `turn/start`, `turn/interrupt`, approvals) |
| Grok | `grok -p --output-format streaming-json` → NDJSON | `grok agent stdio` → ACP JSON-RPC, plus `x.ai/*` extension methods |
| Pi | `pi --mode json` → NDJSON event stream | `pi --mode rpc` → NDJSON commands on stdin, responses + events on stdout |

All three simple modes are one-shot: they run a prompt and exit. All three rich modes are
long-lived bidirectional sessions with resume, interrupt and (for Codex) interactive
approvals. The simple modes need no framing protocol beyond "parse each line"; the rich
modes need correlation ids, handshakes and lifecycle management.

MutiAgent needs: parallel delegated runs, interrupt/cancel, live token/event streaming,
resume of an existing native session, and (later) interactive approval forwarding.

## Decision

1. **Both surfaces are modeled in the canonical schema; neither is mandatory.**
   `AgentCapabilities.runModes` declares which an adapter supports:
   `'headless-exec' | 'duplex-protocol'`. Adapters implement what the binary actually
   supports and declare the rest absent.
2. **v0.1 implements `headless-exec` for all three agents.** It is sufficient for
   dispatch, streamed events, cancellation-by-signal, and result capture, and it has the
   smallest failure surface. Cancellation kills the managed process group and reports
   `cancelled`; it cannot continue a run.
3. **`duplex-protocol` is a per-adapter opt-in**, landed when a feature demonstrably
   needs it — Codex approvals, ACP permission forwarding, Pi live steering. The
   `AgentRunEvent` union already carries the events those flows produce, so adding the
   transport does not change any consumer.
4. **Resume is expressed canonically, not as a protocol.** `RunRequest.resumeSessionId`
   maps to `codex exec resume`, `grok -p --resume`, `pi --session-id`. Consumers ask for
   "continue session X"; the adapter picks the mechanism.
5. **The adapter owns framing.** Native lines never escape the adapter; it emits
   `AgentRunEvent` objects. Unknown native event types become
   `AgentRunEvent{kind:'unknown', native}` rather than being dropped, so a protocol
   revision degrades into a visible gap instead of silent data loss.
6. **Never invoke an agent in interactive TUI mode from the control plane.** Interactive
   work is *launched*, not driven: `adapter.launchNativeSession()` opens a terminal
   locally (or hands the command to the user), because a TUI cannot be a subprocess of a
   non-TTY host (ADR-0011, terminal package in the harness).

## Consequences

**Positive**

- Fast path to a working product: no handshake, no id correlation, no socket lifetime.
- One uniform cancellation story (`AbortSignal` → process tree kill → classified event).
- Forward-compatible: the rich transports are additive per adapter.

**Negative / accepted costs**

- Until a duplex transport lands, we cannot forward an interactive approval prompt, nor
  steer a running turn. Documented in `reference/harness-gaps.md` and surfaced in the UI
  as a capability badge rather than a silent limitation.
- `headless-exec` costs one process start per turn, so a long multi-turn delegated
  conversation is less efficient than a duplex session. Accepted for v0.1; the resume
  path keeps context on the agent's side.
- Adapters must parse two different native event taxonomies per agent if they later add
  the duplex mode — mitigated by keeping the mapping table in one module per agent
  (`src/events.ts`), not scattered across the adapter.

## Alternatives considered

- **Duplex protocol only.** Rejected for v0.1: three protocol implementations (one of
  which, ACP, needs a client-side handshake and capability negotiation) before any
  product value ships, and each is a distinct hang/corruption mode.
- **Subprocess-drive the TUI with a pseudo-terminal and scrape the screen.** Rejected:
  brittle, unversioned, and it makes the model's spoken text the API. The harness has a
  proper `terminal` package for human-facing interactive shells; that is the right tool
  for launching, not for parsing.
- **Use each agent's SDK where one exists (Pi's TypeScript SDK, Codex's TS SDK).**
  Rejected as the primary path: the SDKs bundle their own CLI version assumptions and
  drag dependency trees into the host process. Revisited only if the SDK gains a
  capability the CLI lacks.
