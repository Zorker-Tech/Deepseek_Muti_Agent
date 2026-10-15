# ADR-0014 — Managed process execution: explicit environment, process groups, classified exits

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Aiomx (owner), MutiAgent architecture

## Context

Every delegated run, every auth operation, and every git worktree command is a subprocess.
Subprocess handling in a long-lived host process is where orchestrators usually break:

- an agent that spawns its own children survives a naive `kill()` and keeps working;
- leaking the harness's entire environment into a foreign agent leaks credentials
  (`DSH_*` variables, provider keys) and platform-specific noise;
- a non-zero exit conflates "not logged in", "rate limited", "policy blocked",
  "user cancelled" and "crashed", all of which need different remediation;
- a subprocess inheriting stdin from a TTY-less host hangs forever waiting for input;
- stdout/stderr buffers grow without bound on a chatty agent (a real risk: agents print
  entire file contents and diffs).

The harness has its own `subprocess` seam, which is the right tool in-tree; out-of-tree we
cannot depend on it (ADR-0006), so we implement a small, well-specified runner.

## Decision

One `ProcessRunner` in `packages/core/src/process/` with these invariants:

1. **Explicit environment, allow-list based.** The child gets `PATH`, `HOME`, `SHELL`,
   `TERM`, `LANG`/`LC_ALL`, `TMPDIR`, and platform essentials, plus:
   - the per-agent variables the adapter declares (e.g. `CODEX_HOME`, `GROK_HOME`,
     `PI_CODING_AGENT_DIR`) derived from the *resolved config*, not blindly inherited;
   - credentials for the agent currently being run, taken from its own store only when the
     adapter's config says so (`envMode: 'minimal' | 'inherit-agent' | 'inherit-all'`,
     default `minimal`).
   `DSH_*` is never inherited, and neither is any variable matching
   `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i` unless it belongs to the target agent's
   declared set. The exact list is logged (names only, never values) into the run record,
   so a missing-variable failure is diagnosable.
2. **Own process group / job object.** Children are spawned `detached` on POSIX (new
   process group) and with `windowsHide` + job semantics on Windows, so cancellation
   terminates the whole tree (`kill(-pid, SIGTERM)`, then `SIGKILL` after a grace period).
   This is what stops an agent's own tool subprocesses from surviving a cancel.
3. **Never inherit stdin from the host.** stdin is a pipe; it is closed (or fed an explicit
   credential payload) immediately. A subprocess that expects a TTY therefore fails fast
   instead of hanging. Interactive flows are launched, not piped (ADR-0010, ADR-0011).
4. **Bounded capture with ring buffers.** stdout/stderr are captured into fixed-size ring
   buffers (default 512 KiB each, configurable) with a counter of dropped bytes. The tail
   is what diagnostics need; the head is kept too (first 8 KiB) because version banners and
   errors usually appear first. A tool that needs the full stream (an event stream) reads
   incrementally through the line-splitting reader and does not buffer.
5. **Line-oriented streaming reader.** NDJSON/JSONL streams are parsed with a byte-level
   line splitter that: handles `\n` only (never `\r\n`-unsafe), tolerates a trailing
   partial line, ignores blank lines, and yields a typed `ParseError` for a malformed line
   without aborting the stream. `\r\n`, UTF-8 split across chunk boundaries, and very long
   lines (bounded, then reported) are explicitly handled — these are the observed
   real-world failure modes.
6. **Classified exits.** A non-zero exit becomes a `MutiAgentError` with a code chosen by
   an adapter-supplied classifier over (exit code, signal, stderr patterns):
   `auth/*`, `run/rate-limited`, `run/policy-blocked`, `run/agent-crashed`,
   `run/cancelled`, `run/timeout`, `run/protocol-error`. Unknown non-zero stays
   `run/agent-crashed` with the raw tail attached. Nothing is swallowed and nothing is
   guessed silently.
7. **Every run is recorded.** `MeshTask`/run records hold the exact argv (with secret
   arguments redacted), the environment variable *names*, cwd, start/end times, exit code,
   signal, and the captured tails. That record is what the mesh panel shows.
8. **Timeouts are explicit and per-operation.** No default infinity: runs get a configurable
   wall-clock budget (default none, i.e. bounded only by cancellation), probes get 10 s,
   git commands 60 s. A timeout kills the group and reports `run/timeout`, distinguishing it
   from a user cancellation.

## Consequences

**Positive**

- Cancellation actually cancels, including an agent's grandchildren.
- No credential bleed between the harness environment and foreign agents, and no
  accidental `DSH_*` propagation that could confuse a nested harness.
- Failures are actionable in the UI and in tool output, with the raw evidence attached.
- Bounded memory: a chatty agent cannot exhaust the host process.

**Negative / accepted costs**

- We reimplement a subset of what the harness's `subprocess` package does (and its
  Windows job-object handling is more thorough than ours). Accepted per ADR-0006; the
  runner is ~400 lines and covered by Tier 1 tests.
- Detached process groups on POSIX mean we must reap children explicitly; a bug here leaks
  zombies. Tested by asserting reaping after cancel.
- `envMode: 'minimal'` will occasionally be too strict for an agent that relies on an
  undocumented variable; the diagnostic (names only) makes that a one-line config fix
  rather than a mystery.

## Alternatives considered

- **`child_process.exec` / `execSync`.** Rejected: no streaming, shell injection surface,
  unbounded buffers, and no process-group control.
- **Use the harness `subprocess`/`shell` services.** Rejected for portability (ADR-0006);
  noted as a future optional accelerator behind the same `ProcessRunner` interface, since
  it would inherit the harness's sandbox integration.
- **A PTY per agent.** Rejected for control-plane runs: a TUI is not the API, and PTY
  output needs terminal emulation to be useful. The harness's `terminal` package is the
  right vehicle for the *launch* case only.
- **Inherit the whole parent environment (`envMode: 'inherit-all'`) as the default.**
  Rejected as unsafe-by-default; available as an explicit per-agent opt-in.
