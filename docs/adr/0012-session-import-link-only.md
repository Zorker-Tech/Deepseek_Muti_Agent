# ADR-0012 — Foreign sessions are indexed by link, never imported by copy

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

"One-click import of installed agents' sessions" is a requirement. There are two ways to
interpret *import*:

**(A) Copy/translate** each foreign transcript into a harness session: create a harness
session id, translate native records into harness session events, and let the harness's
own sidebar, projections and search show them.

**(B) Index in place:** discover each agent's session store, read it, and keep a
MutiAgent-owned index that links to the native record without modifying either side.

Constraints that decide this:

- Harness session semantics are strict and load-bearing: house rule "Model-visible ⟺
  logged", versioned session format (`SESSION_FORMAT_VERSION`) with explicitly *no*
  downgrade path, immutable canonical generation files written by exactly one live writer
  under a lock, and a documented reader-compatibility review process. A synthesized
  session is a first-class artifact that must remain replayable forever.
- Foreign formats are **not** ours and are versioned: Codex rollouts have a `history_mode`
  and a `state_5.sqlite` migration in progress ("TODO: sqlite migration phase 1"); Grok
  declares `chat_format_version: 0|1` with a `ChatRequestMessage → ConversationItem`
  transition; Pi has `CURRENT_SESSION_VERSION = 3` with two completed migrations.
  Translating them means tracking three third-party format evolutions forever.
- Writing into a foreign store is a live-impropriety: it is another product's private
  state, and a concurrent agent process may hold its own lock.

## Decision

**Session import is (B): in-place indexing, link-only.**

1. **Discovery** enumerates each detected agent's session roots
   (`$CODEX_HOME/sessions`, `$GROK_HOME/sessions`, `<agent-dir>/sessions`, each
   configurable and overridable) and builds an `AgentSession` projection per file:
   metadata read from the native header/summary, plus a bounded tail read for recent
   messages.
2. **The index is MutiAgent state**, in `$DSH_HOME/mutiagent/index/`: a JSON record per
   session plus an incremental scan journal, keyed by `(agentId, nativeId)`. It stores:
   native path, native id, canonical projection, source file `mtime`+`size`+`inode`
   fingerprint, and an `importedAt`. Nothing is written outside this directory.
3. **"Import" means register, not copy.** The single-click action
   (`mutiagent.session.import`) marks a discovered session as *tracked*: it appears in the
   Agent Sessions panel, can be read, resumed, delegated to, and bound to a worktree —
   while the authoritative transcript stays where the agent wrote it.
4. **No harness session is created.** We never synthesize harness session events, so we
   never enter the harness's persistence/compatibility obligations, and the harness's own
   sidebar keeps showing exactly the sessions it owns. The Agent Sessions panel is where
   foreign sessions live (ADR-0007).
5. **Reads are strictly read-only and bounded.** Files are opened read-only; the reader
   tolerates truncation, concurrent appends, `zstd`-compressed rollouts (Codex) and
   partially written last lines; it caps bytes per session read and per refresh. A parse
   failure yields a session entry with `status: 'unreadable'` and the error, plus whatever
   metadata was recoverable.
6. **Freshness without full rescans.** The scanner walks roots incrementally (mtime-first
   ordering, per-directory cursors), keeps a warm cache, and refreshes on demand plus on a
   slow timer. A session whose fingerprint is unchanged is not re-read.
7. **Deletion of a foreign session is never performed by us**; a tracked session whose
   native file disappears becomes `missing` and is retained for its metadata until the
   user removes the tracking entry.
8. **Detach is instant and lossless for the user**: removing a tracked session drops our
   index entry only.

## Consequences

**Positive**

- No dependency on three foreign format-version migrations; we degrade to
  "unreadable + reason" instead of producing corrupt sessions.
- No harness format obligations (no session generation files, no version bumps, no
  reader-compatibility reviews) for data we do not own.
- Foreign session stores are never mutated, so a concurrent agent can never be corrupted
  by us, and we cannot be blamed for one.

**Negative / accepted costs**

- Foreign sessions do not appear in the harness's own sidebar or in harness session search,
  and the harness agent cannot "continue" them as harness sessions. Mitigated by the
  dedicated panel, by resume-through-the-native-agent, and by MutiAgent's own cross-agent
  search over the index.
- We maintain a reader per agent format. Each reader is small, tolerant, and tested
  against recorded fixtures, and lives in exactly one module per adapter
  (`src/sessions.ts`).
- Duplicate-ish storage: the index holds a bounded projection (summary + recent messages)
  in addition to the native file. Bounded by a per-session cap and an LRU for message
  bodies; summaries are cheap.
- If a user genuinely wants a foreign transcript inside the harness, that is a *separate*
  explicit export path (out of scope for v0.1, and it would be a one-way write with its
  own ADR).

## Alternatives considered

- **Copy/translate into harness sessions (option A).** Rejected on the harness's own
  stated contract: session data is versioned with no downgrade support and a
  reader-compatibility review requirement, so a translation layer would become a
  permanent compatibility liability for third-party formats we do not control.
- **Hard-link or symlink the native files into the harness session root.** Rejected:
  violates the harness's one-writer/immutable-generation assumptions and would make the
  harness's own reader interpret a foreign format.
- **Read foreign sessions only on demand (no index).** Rejected: the sidebar feature needs
  an enumerable, filterable list with titles and timestamps without touching every file on
  each page load, and cross-agent search needs an index anyway.
- **Use the harness's `sessionQuery` service to store foreign sessions.** Rejected: it
  indexes harness session generations; feeding it foreign records would be option A in
  disguise.
