# ADR-0013 — Verification strategy: fixtures, contract tests, and a real harness run

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

The riskiest parts of MutiAgent are the ones that talk to other products:

- native session formats (three, all versioned, none ours),
- native CLI output shapes (JSON/NDJSON event streams),
- native credential files,
- the harness's Cordis service contracts, which are pre-stable,
- the browser module-loader envelope, which is an in-tree detail we reproduce.

Unit tests that mock all of the above would prove nothing about the real world, and
"it looked right in the editor" is not evidence. At the same time we cannot require a
logged-in Codex/Grok/Pi account in CI, nor spend real API budget per build.

## Decision

Four tiers, each with a stated claim, and a hard rule that a claim is only made at the
tier that actually proves it.

1. **Tier 1 — pure unit tests (`node:test`, no network, no processes).** Schema
   validators, canonical projections, conflict detection math, worktree path derivation,
   Context Block rendering, redaction, MCP framing. Claim proven: *logic is correct for
   given inputs.*
2. **Tier 2 — fixture replay per adapter (`tests/fixtures/<agent>/`).** Recorded native
   artifacts — real session files, real `--json`/NDJSON transcripts, real `auth.json`
   shapes with **secrets replaced by obviously fake values** — replayed through the
   adapter's readers and event mappers. Adapter tests assert the exact canonical output,
   including declared `ProjectionNote`s. Claim proven: *we parse each real native format
   correctly for the recorded revision*, and a format change shows up as a failing
   fixture diff instead of a silent runtime gap. Fixtures are recorded with a documented
   procedure (`docs/operations/fixtures.md`) and carry the producing version in a sibling
   `.meta.json`.
3. **Tier 3 — capability probe tests against an installed binary.** Where a binary is
   present, tests run the *non-billing* probes only: `--version`, `login status`/
   `auth check`, `sessions list`, `--help` parsing. Claim proven: *detection, version
   parsing, auth status and session enumeration work against the real installed CLI.*
   These self-skip when the binary is absent, so CI stays green on a clean runner, and the
   skip is printed — a skipped probe is never reported as a pass.
4. **Tier 4 — integration in a real harness (`docs/operations/install.md`).** Install the
   built bundle into a `dsh` profile and verify, with a live harness:
   - the profile boots and `--dump-config` shows the bundle's layer and rows;
   - the host plugin activates and `mutiagent.methods` lists the catalog;
   - `GET /api/mutiagent/events` opens as an authenticated SSE stream and returns 401/403
     without the browser cookie;
   - the standard harness CLI can list agents and sessions from every adapter;
   - a delegated run executes end-to-end against a real agent on a real repository, in a
     real worktree, and its events appear in the stream;
   - the browser page loads the client bundle (asserted from the served
     `/plugins/??.../client.js` response and the boot manifest), and the panel rows render
     without console errors.
   Claim proven: *the product works in the environment it ships into.* This tier is a
   required gate for a release claim; every other tier is necessary and not sufficient.

Cross-cutting rules:

- **No claim without its tier.** A feature is not "working" because Tier 1–2 pass; and a
  screenshot of rendered UI is not evidence of Tier 4 if the browser was not driven.
- **Redaction is tested, not assumed.** A test asserts that a submitted API key never
  appears in any emitted envelope, log line, or tool result.
- **Dangerous-operation gating is tested on all three surfaces** (native tool, MCP, HTTP)
  with the same expectation (ADR-0011).
- **Snapshot determinism**: canonical projections are compared as stable-serialized JSON
  with sorted keys, timestamps normalized, and absolute paths replaced by placeholders, so
  fixtures are portable across machines.

## Consequences

**Positive**

- A native format or CLI change fails a test with a diff, early, instead of degrading a
  user's session list in production.
- The most expensive tier (Tier 4) is a scripted, repeatable operation rather than an
  ad-hoc manual click-through.
- Honest reporting: the tier structure makes it obvious what has and has not been proven.

**Negative / accepted costs**

- Fixture capture requires access to each agent once, per format revision, and needs a
  maintenance pass when an agent releases a breaking format change.
- Tier 3 skips on machines without the binaries, so "all tests pass" is a weaker statement
  than it sounds; the runner prints per-tier coverage to make that visible.
- Tier 4 needs a real agent login and a real repository. Kept out of default CI, executed
  as a release gate.

## Alternatives considered

- **Mock everything (harness services, agent protocols) and rely on types.** Rejected: the
  failure modes here are precisely the ones mocks hide — an off-by-one in a JSONL reader, a
  renamed field in a rollout record, a Cordis method that no longer exists.
- **Record and replay full HTTP/CLI sessions with a VCR-style library.** Partially adopted
  (the NDJSON stream fixtures are exactly this), but not as the primary frame: it records
  the transport while we mostly care about the *format*, and it tempts a test to assert on
  a stale transcript instead of on our projection.
- **Live end-to-end tests with real model calls in CI.** Rejected: cost, flakiness and
  credential requirements. They are the release gate, run on demand.
