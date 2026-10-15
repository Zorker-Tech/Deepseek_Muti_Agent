# Installing and verifying MutiAgent

## Requirements

| Requirement | Why |
|---|---|
| DeepSeek Harness `0.2.1-alpha.3` (tested) | The plugin is an out-of-tree bundle; see [ADR-0001](../adr/0001-distribution-as-a-dsh-bundle.md) |
| Node ≥ 22.19 | The harness's own engine requirement |
| `git` on `PATH` | Worktree isolation ([ADR-0008](../adr/0008-worktree-isolation-and-progress.md)) |
| At least one of `codex`, `grok`, `pi` on `PATH` | Agents with none installed still load; the panel explains what is missing |

## Build the artifact

From a checkout of this repository:

```sh
pnpm install
pnpm run typecheck        # all seven packages
pnpm run build            # packages/plugin/lib/{index.js,client.js,mcp-stdio.js}
pnpm run verify:plugin    # registration + HTTP + MCP surfaces, no harness needed
```

`verify:plugin` is the gate to trust before installing: it loads the built bundle against
a stub context and asserts that tools, commands and routes register, that a
parameter-validation failure is rejected with the right code, that an untrusted MCP client
receives a confirmation challenge for a dangerous operation, and that all three agents are
detected.

## Install into a harness profile

The plugin must be installed into a **profile** — a directory under `$DSH_HOME/profiles/`
that stacks plugin-bundle layers.

```sh
# 1. Create (or reuse) a profile. Use the web template if you want the GUI panels;
#    `--dump-default-config` composes it without booting.
dsh --profile multiagent --from-default-profile web --dump-default-config >/dev/null

# 2. Install the bundle. This runs pnpm in the profile and appends the bundle to
#    `dsh.profile.bundles`.
dsh plugin --profile multiagent add /absolute/path/to/Muti_Agent/packages/plugin

# 3. Confirm the profile lists it.
cat "$DSH_HOME/profiles/multiagent/package.json"
#   "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@zorker/muti-agent-plugin"]

# 4. Boot.
dsh --profile multiagent --no-open --port 4319
```

Step 1 matters: creating a profile and *then* adding the plugin, rather than the reverse,
because `--from-default-profile` replaces the profile with a fresh template copy and would
discard the bundle list. If you already added the plugin and then reset the profile, add it
again.

### Verifying a boot

A successful activation is quiet. Evidence, in increasing order of strength:

```sh
# the composed tree contains our row
dsh --profile multiagent --dump-config | grep -A4 muti-agent

# from an agent inside the harness, or the composer: the method catalog
/agents-diagnostics
```

In the browser: the sidebar shows two new icon rows — **Agents** and **Mesh** — and
Settings gains an **Agents** section. The Agents panel is the per-agent session browser;
Mesh is the run/worktree/collaboration view.

### Verifying without the GUI

The authenticated gateway is reachable with the browser session cookie. The simplest
check is from a page context; from a shell you must present the cookie the harness set:

```sh
curl -sS http://127.0.0.1:4319/api/mutiagent/rpc \
  -H 'content-type: application/json' \
  -H "cookie: $(…) " \
  -d '{"method":"agents.diagnostics"}'
```

An unauthenticated request is refused by the harness's own trust fence before it reaches
the plugin — that is [ADR-0004](../adr/0004-host-client-transport.md)'s whole point.

## Configure

Settings are the plugin row's `config` in a profile patch. Edit
`$DSH_HOME/profiles/<name>/cordis.patch.yml` — never `cordis.yml`, which the launcher
regenerates on every boot:

```yaml
- id: muti-agent
  config:
    worktree:
      enabled: true
      conflictPolicy: block        # refuse to dispatch when hunk-level overlap is predicted
      featureBoundaries: ['packages/api', 'packages/web']
    agents:
      codex:
        model: gpt-5-codex
      grok:
        binaryPath: /usr/local/bin/grok
    runs:
      maxParallel: 6
    log:
      level: debug
```

Every field is documented by the settings schema, which the harness validates at
activation and the settings page renders. A row's `config` replaces the whole block, so
set the keys you need and rely on defaults for the rest.

Useful knobs:

| Setting | Effect |
|---|---|
| `stateDir` | Where MutiAgent keeps its index, run records and collaborations. Default `<harness home>/mutiagent` |
| `worktree.enabled` | `false` runs agents in the shared working tree — faster, no isolation |
| `worktree.conflictPolicy` | `report` (default) or `block` |
| `worktree.sampleIntervalMs` | Progress sampling cadence; `0` disables the sampler |
| `sharePlan` (`collaboration.sharePlan`) | `false` makes sharing observe-only, never injecting context |
| `credentials.probeCli` | `false` avoids spawning an agent CLI for a status probe |
| `envMode` (per agent) | `minimal` (default), `inherit-agent`, `inherit-all` — see [ADR-0014](../adr/0014-managed-process-execution.md) |

## Updating

```sh
pnpm run build
dsh plugin --profile multiagent add /absolute/path/to/Muti_Agent/packages/plugin
# A running harness picks up a *new* bundle via HMR; a *replaced* package needs a restart.
```

The client bundle is served from the package and cached by revision; a hard reload after a
restart is the reliable way to confirm the browser half updated.

## Uninstalling

```sh
dsh plugin --profile multiagent remove @zorker/muti-agent-plugin
rm -rf "$DSH_HOME/mutiagent"            # MutiAgent's own state
```

Removing the bundle removes both sidebar rows, the settings section and every registered
tool; nothing is written into the harness's own storage, so there is no residue to clean
in sessions or settings. Worktrees MutiAgent created are left in place deliberately —
they may hold unmerged work. Remove them individually with `worktrees.remove`, or by hand
with `git worktree remove`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `dsh: startup failed: … required plugin did not activate` naming `typert-loader` | The harness's own `lib/` artifacts were never built. Run `pnpm run build:artifacts` in the harness checkout. Unrelated to this plugin. |
| The plugin row reports a load error naming an operation id | A declared operation id violated the dotted-lower-snake-case contract. `pnpm run verify:plugin` catches this before installing. |
| Sidebar rows missing after install | The profile was reset after the bundle was added; re-run `dsh plugin --profile <name> add …`. |
| A panel says "not installed: …" | That agent's binary is not on `PATH`, or `binaryPath` points somewhere invalid. The reason is shown verbatim. |
| Credentials show `unknown` with source `keyring` | The credential lives in the OS keyring, which MutiAgent does not read. Enable `credentials.probeCli` and open the agent once. |
| A run fails with `worktree/not-a-repository` | Isolation was requested for a directory that is not inside a git work tree. Dispatch with `isolation: 'shared-cwd'` or initialize a repository. |
| Sessions list is empty | Press **Refresh**; the warm scan runs once at activation and on demand. A partition note says whether the agent is unscanned, uninstalled, or genuinely empty. |
