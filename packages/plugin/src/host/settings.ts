/**
 * Plugin settings: the `config` a profile row may override, expressed as one Standard
 * Schema so the harness validates it at activation **and** the settings UI can derive a
 * form from the same declaration (ADR-0006 rule 5).
 *
 * Every deployment-varying choice lives here rather than as a constant: state location,
 * per-agent overrides, isolation policy, concurrency, and gateway limits. The defaults
 * are chosen so an empty `config: {}` behaves sensibly on a machine with all three
 * agents installed.
 *
 * @module @zorker/muti-agent-plugin/host/settings
 */

import { s, type Schema } from '@zorker/muti-agent-contracts'

/** Per-agent override block. */
export interface AgentSettingsConfig {
  /** Whether this agent participates at all. */
  enabled: boolean
  /** Absolute path to the agent binary; empty means "resolve from PATH". */
  binaryPath: string
  /** Override for the agent's home/config directory; empty means "use its own default". */
  homeDir: string
  /** Default model for runs of this agent; empty means "the agent's own default". */
  model: string
  /** Per-run wall-clock budget in milliseconds; `0` means no budget. */
  timeoutMs: number
  /**
   * How the child environment is derived.
   *
   * `minimal` passes only a documented base plus this agent's own variables — the
   * default, because inheriting the harness's environment would leak `DSH_*` and other
   * products' keys into a foreign agent. `inherit-agent` adds non-secret host variables.
   * `inherit-all` passes everything, and is only appropriate in a disposable container.
   */
  envMode: 'minimal' | 'inherit-agent' | 'inherit-all'
  /** Explicit environment entries for every run of this agent. Values are not logged. */
  env: Readonly<Record<string, string>>
}

/** Worktree isolation settings. */
export interface WorktreeConfig {
  enabled: boolean
  /** Where worktrees are created. */
  location: 'in-repo' | 'state-root'
  /** Base ref to branch from; empty means the repository's default branch. */
  baseRef: string
  /** How strictly predicted conflicts are treated. */
  conflictPolicy: 'report' | 'block'
  /** Module boundaries used for the functional-conflict heuristic. */
  featureBoundaries: readonly string[]
  /** Merge an idle worktree automatically at the end of a run. */
  autoIntegrate: boolean
  /** How often to sample worktree progress, in milliseconds; `0` disables sampling. */
  sampleIntervalMs: number
}

/** Run concurrency and retention settings. */
export interface RunsConfig {
  /** Maximum simultaneous delegated runs; excess dispatches queue. */
  maxParallel: number
  /** Finished run records kept on disk. */
  historyLimit: number
  /** Grace period for live runs during plugin unload, in milliseconds. */
  shutdownGraceMs: number
}

/** Session index settings. */
export interface SessionsConfig {
  /** Delay before the warm scan starts, in milliseconds. A short delay keeps activation instant. */
  warmScanDelayMs: number
}

/** Browser gateway settings. */
export interface GatewayConfig {
  /** Maximum accepted request body size, in bytes. */
  maxBodyBytes: number
  /** SSE heartbeat interval in milliseconds. */
  heartbeatMs: number
}

/** Credential surface settings. */
export interface CredentialsConfig {
  /**
   * Whether an inconclusive credential file read may fall back to the agent's own CLI
   * status probe. Costs one process start per probe.
   */
  probeCli: boolean
}

/** Collaboration settings. */
export interface CollaborationConfig {
  /** Whether the shared plan and todo board are injected into delegated runs. */
  sharePlan: boolean
}

/** Logging settings. */
export interface LogConfig {
  level: 'silent' | 'error' | 'warn' | 'info' | 'debug'
}

/** The whole plugin configuration. */
export interface MutiAgentPluginConfig {
  /** State directory; empty derives it from the harness home. */
  stateDir: string
  agents: Record<string, AgentSettingsConfig>
  worktree: WorktreeConfig
  runs: RunsConfig
  sessions: SessionsConfig
  gateway: GatewayConfig
  credentials: CredentialsConfig
  collaboration: CollaborationConfig
  log: LogConfig
}

const AgentDefaults = {
  enabled: true,
  binaryPath: '',
  homeDir: '',
  model: '',
  timeoutMs: 0,
  envMode: 'minimal',
} as const

const AgentSettingsSchema = s.objectOpt(
  {},
  {
    enabled: s.boolean().describeAs('Whether this agent participates.'),
    binaryPath: s.string().describeAs('Absolute path to the agent binary.'),
    homeDir: s.string().describeAs('Override for the agent\'s home/config directory.'),
    model: s.string().describeAs('Default model for this agent\'s runs.'),
    timeoutMs: s.number().int().min(0).describeAs('Per-run wall-clock budget in milliseconds; 0 means none.'),
    envMode: s
      .string()
      .enumOf(['minimal', 'inherit-agent', 'inherit-all'])
      .describeAs('How the child environment is derived from the host environment.'),
    env: s.record(s.string()).describeAs('Environment entries for every run of this agent.'),
  },
)

const WorktreeSchema = s.objectOpt(
  {},
  {
    enabled: s.boolean().describeAs('Whether delegated runs get their own git worktree.'),
    location: s.string().enumOf(['in-repo', 'state-root']).describeAs('Where worktrees are created.'),
    baseRef: s.string().describeAs('Ref to branch from; empty uses the default branch.'),
    conflictPolicy: s.string().enumOf(['report', 'block']).describeAs('How predicted conflicts are treated.'),
    featureBoundaries: s.array(s.string()).describeAs('Module boundaries for functional-conflict detection.'),
    autoIntegrate: s.boolean().describeAs('Merge an idle worktree automatically when a run ends.'),
    sampleIntervalMs: s.number().int().min(0).describeAs('Worktree sampling interval; 0 disables sampling.'),
  },
)

const RunsSchema = s.objectOpt(
  {},
  {
    maxParallel: s.number().int().min(1).max(64).describeAs('Maximum simultaneous delegated runs.'),
    historyLimit: s.number().int().min(1).max(10_000).describeAs('Finished run records kept on disk.'),
    shutdownGraceMs: s.number().int().min(0).describeAs('Grace period for live runs on unload.'),
  },
)

const SessionsSchema = s.objectOpt(
  {},
  { warmScanDelayMs: s.number().int().min(0).describeAs('Delay before the warm session scan starts.') },
)

const GatewaySchema = s.objectOpt(
  {},
  {
    maxBodyBytes: s.number().int().min(1024).describeAs('Maximum accepted request body size.'),
    heartbeatMs: s.number().int().min(1000).describeAs('SSE heartbeat interval.'),
  },
)

const CredentialsSchema = s.objectOpt(
  {},
  { probeCli: s.boolean().describeAs('Allow a CLI status probe when the credential file is inconclusive.') },
)

const CollaborationSchema = s.objectOpt(
  {},
  { sharePlan: s.boolean().describeAs('Inject the shared plan and todo board into delegated runs.') },
)

const LogSchema = s.objectOpt(
  {},
  {
    level: s
      .string()
      .enumOf(['silent', 'error', 'warn', 'info', 'debug'])
      .describeAs('Log verbosity for MutiAgent\'s own diagnostics.'),
  },
)

/**
 * The plugin's settings schema. Exported as the row's `Config`, so the harness validates
 * a profile's `config` block at activation and the settings page can render a form from
 * the same declaration.
 */
export const PluginSettingsSchema: Schema<MutiAgentPluginConfig> = s.objectOpt(
  {},
  {
    stateDir: s.string().describeAs('State directory; empty derives it from the harness home.'),
    agents: s
      .record(AgentSettingsSchema)
      .describeAs('Per-agent overrides, keyed by agent id (`codex`, `grok`, `pi`).'),
    worktree: WorktreeSchema,
    runs: RunsSchema,
    sessions: SessionsSchema,
    gateway: GatewaySchema,
    credentials: CredentialsSchema,
    collaboration: CollaborationSchema,
    log: LogSchema,
  },
) as unknown as Schema<MutiAgentPluginConfig>

/**
 * Validate the row's `config` and apply defaults.
 *
 * @param raw - The `config` value from the profile composition.
 * @returns The composed configuration, with every default filled in.
 * @throws {import('@zorker/muti-agent-contracts').SchemaValidationError} when a value
 *   is present but invalid; a self-contained misconfiguration must fail loudly.
 */
export function resolvePluginConfig(raw: unknown): MutiAgentPluginConfig {
  const parsed = PluginSettingsSchema.parse(raw ?? {}) as Partial<MutiAgentPluginConfig>
  const agents: Record<string, AgentSettingsConfig> = {}
  for (const key of ['codex', 'grok', 'omp', 'pi']) {
    agents[key] = { ...AgentDefaults, ...normalizeAgent(parsed.agents?.[key]), env: normalizeEnv(parsed.agents?.[key]?.env) }
  }
  for (const [key, value] of Object.entries(parsed.agents ?? {})) {
    if (key in agents) continue
    agents[key] = { ...AgentDefaults, ...normalizeAgent(value), env: normalizeEnv(value.env) }
  }
  return {
    stateDir: parsed.stateDir ?? '',
    agents,
    worktree: {
      enabled: parsed.worktree?.enabled ?? true,
      location: parsed.worktree?.location ?? 'in-repo',
      baseRef: parsed.worktree?.baseRef ?? '',
      conflictPolicy: parsed.worktree?.conflictPolicy ?? 'report',
      featureBoundaries: parsed.worktree?.featureBoundaries ?? [],
      autoIntegrate: parsed.worktree?.autoIntegrate ?? false,
      sampleIntervalMs: parsed.worktree?.sampleIntervalMs ?? 30_000,
    },
    runs: {
      maxParallel: parsed.runs?.maxParallel ?? 4,
      historyLimit: parsed.runs?.historyLimit ?? 200,
      shutdownGraceMs: parsed.runs?.shutdownGraceMs ?? 5000,
    },
    sessions: { warmScanDelayMs: parsed.sessions?.warmScanDelayMs ?? 1500 },
    gateway: {
      maxBodyBytes: parsed.gateway?.maxBodyBytes ?? 4 * 1024 * 1024,
      heartbeatMs: parsed.gateway?.heartbeatMs ?? 15_000,
    },
    credentials: { probeCli: parsed.credentials?.probeCli ?? true },
    collaboration: { sharePlan: parsed.collaboration?.sharePlan ?? true },
    log: { level: parsed.log?.level ?? 'info' },
  }
}

/** Normalize one agent block to the full field set. */
function normalizeAgent(value: Partial<AgentSettingsConfig> | undefined): Omit<AgentSettingsConfig, 'env'> {
  return {
    enabled: value?.enabled ?? AgentDefaults.enabled,
    binaryPath: value?.binaryPath ?? AgentDefaults.binaryPath,
    homeDir: value?.homeDir ?? AgentDefaults.homeDir,
    model: value?.model ?? AgentDefaults.model,
    timeoutMs: value?.timeoutMs ?? AgentDefaults.timeoutMs,
    envMode: value?.envMode ?? AgentDefaults.envMode,
  }
}

/** Normalize an environment map to plain strings. */
function normalizeEnv(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = entry
  return out
}

/**
 * The settings surface the plugin's entry point uses: one schema that validates at load
 * and documents itself to the settings UI.
 */
export const readPluginSettings = {
  /** The Standard-Schema declaration the harness reads as the row's `Config`. */
  schema: PluginSettingsSchema,
  /**
   * Validate a row's `config` and fill in every default.
   *
   * @param raw - The `config` value from the profile composition.
   * @returns Success with the composed configuration, or the collected issues.
   */
  safeParse: (raw: unknown): { ok: true, value: MutiAgentPluginConfig } | { ok: false, issues: readonly { path: readonly (string | number)[], message: string }[] } => {
    const parsed = PluginSettingsSchema.safeParse(raw ?? {})
    if (!parsed.ok) return { ok: false, issues: parsed.issues }
    return { ok: true, value: resolvePluginConfig(raw) }
  },
}
