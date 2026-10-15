/**
 * The OMP adapter: one `AgentAdapter` over **oh-my-pi** (`@oh-my-pi/pi-coding-agent`,
 * bin `omp`), implementing the SPI in `@zorker/muti-agent-core` (ADR-0002).
 *
 * Transport: `omp --mode json` (a headless, one-shot JSONL stream) for runs, and OMP's own
 * session files for discovery and transcript reading. `omp --mode rpc` exists and is
 * declared as an unavailable transport: it needs a long-lived duplex session, which is the
 * per-adapter opt-in ADR-0003 describes, not part of this pass.
 *
 * The model catalog comes from OMP's own files (`models.yml` providers and their models,
 * `config.yml`'s `modelRoles.default` and `enabledModels` scope); OMP's bundled catalog is
 * deliberately never read, so the catalog describes what this machine is configured to run.
 *
 * Four verified OMP behaviours shape `run()`:
 *
 * - OMP is a hard fork of pi, and the fork is visible in the run contract: `--mode json`
 *   prints the session header first and one `AgentSessionEvent` per line, but JSON mode
 *   **exits non-zero** when the terminal turn failed (`stopReason` `error`/`aborted`), where
 *   pi 1.2 exited 0; and a new session's id cannot be requested, because there is no
 *   `--session-id` flag — the id arrives in the stream's header record.
 * - The prompt is written to **stdin**, never argv: that keeps it out of the process table
 *   and out of `ARG_MAX`, and OMP reads piped stdin as its initial message. Context blocks
 *   are composed into that prompt by the orchestrator, so `--append-system-prompt` is
 *   deliberately unused.
 * - A resume passes `--resume <id-or-path>`; OMP resolves a path verbatim, an id against the
 *   project bucket first and then globally, and adopts the session's recorded cwd when it is
 *   enterable — so a resume whose recorded cwd differs from the requested one is warned
 *   about rather than refused (there is no interactive question to answer, unlike pi).
 * - `interrupt` stays `false`: `cancel()` kills the managed process group, and no OMP
 *   transport can abort one turn while keeping the session (the RPC transport would, and it
 *   is deferred).
 *
 * @module @zorker/muti-agent-adapter-omp
 */
import { type AgentAuthState, type AgentCapabilities, type AgentCapabilityInventory, type AgentDescriptor, type AgentModelCatalog, type AgentSession, type AuthOperationResult, type NativeSessionId, type ProjectionNote } from '@zorker/muti-agent-contracts';
import { type AdapterContext, type AdapterRun, type AdapterRunRequest, type AgentAdapter, type ListSessionsOptions, type LoginParams, type NativeTaskState, type ReadTranscriptOptions } from '@zorker/muti-agent-core';
import { type OmpTranscript } from './sessions.ts';
/** Canonical agent id. */
export declare const OMP_ID = "omp";
/** Human name. */
export declare const OMP_DISPLAY_NAME = "OMP";
/** Binary name OMP publishes; resolved through `PATH` unless the config overrides it. */
export declare const OMP_BINARY = "omp";
/** Environment variable names this adapter resolves for a run; never values. */
export declare const OMP_RUN_ENVIRONMENT_KEYS: readonly string[];
/** One row of `omp models --json`, with its values verbatim. */
export interface OmpModelEntry {
    /** Provider id, verbatim. */
    provider: string;
    /** Model id, verbatim. */
    id: string;
    /** `provider/id` selector OMP renders for the row. */
    selector?: string;
    /** Display name, verbatim. */
    name?: string;
    /** Context window in tokens, when the row reports one. */
    contextWindow?: number;
    /** Maximum output tokens, when the row reports one. */
    maxTokens?: number;
    /** Whether the row declares reasoning support. */
    reasoning?: boolean;
    /** Whether the row accepts image input, from its declared `input`. */
    images?: boolean;
}
/** The result of a native model-listing probe. */
export interface OmpModelListing {
    models: readonly OmpModelEntry[];
    notes: readonly ProjectionNote[];
}
/**
 * OMP's adapter. Construct through {@link createOmpAdapter}; the constructor is public so a
 * test can inject an environment.
 */
export declare class OmpAdapter implements AgentAdapter {
    private readonly ctx;
    private readonly env;
    readonly id: string;
    readonly displayName: string;
    private readonly agent;
    private described;
    /**
     * @param ctx - Ambient core services: logger, config, process runner, file probe.
     * @param env - Host environment to resolve the store and detection from.
     */
    constructor(ctx: AdapterContext, env?: NodeJS.ProcessEnv);
    /**
     * The static capability declaration.
     *
     * @returns The literal declaration; never detection-dependent.
     */
    capabilities(): AgentCapabilities;
    /**
     * Describe this agent, including detection on this machine. Detection is cached because
     * the catalog is queried on every GUI load and the probe spawns a process.
     *
     * @returns The descriptor.
     */
    describe(): Promise<AgentDescriptor>;
    /**
     * Enumerate OMP's sessions from its own store. Read-only.
     *
     * @param options - Cwd filter, limit and cancellation.
     * @returns Session summaries, newest first.
     */
    listSessions(options: ListSessionsOptions): Promise<readonly AgentSession[]>;
    /**
     * Read a bounded transcript window along a session's live branch. Read-only.
     *
     * @param nativeId - OMP session id, or a session file path.
     * @param options - Message and byte caps.
     * @returns The window and its declared gaps.
     */
    readTranscript(nativeId: NativeSessionId, options: ReadTranscriptOptions): Promise<OmpTranscript>;
    /**
     * Read OMP's own todo list and plan-mode state for a session.
     *
     * @param nativeId - OMP session id, or a session file path.
     * @returns The observed state, or `undefined` when the session records neither.
     */
    readNativeTasks(nativeId: NativeSessionId): Promise<NativeTaskState | undefined>;
    /**
     * Read OMP's capability inventory: tools, skills, MCP servers, commands and context files.
     *
     * @returns The inventory, read from OMP's own configuration without running it.
     */
    readCapabilities(): Promise<AgentCapabilityInventory>;
    /**
     * Inspect OMP's credential store (`agent.db`) and the host environment. Never returns
     * secret material.
     *
     * @returns The observed auth state.
     */
    authStatus(): Promise<AgentAuthState>;
    /**
     * Delegate a login to `omp login`.
     *
     * The SPI carries no provider, and OMP's subcommand is an interactive OAuth flow; the
     * process is spawned and its own outcome reported, with the guidance a human needs. The
     * optional secret is never used, logged or placed in argv.
     *
     * @param params - Requested flow; only `interactive` has a CLI counterpart.
     * @returns The CLI outcome (or the refusal) plus the freshly observed state.
     */
    login(params: LoginParams): Promise<AuthOperationResult>;
    /**
     * Report that OMP has no logout subcommand, with the paths that do revoke.
     *
     * @returns An unsuccessful result carrying the guidance and the observed state.
     */
    logout(): Promise<AuthOperationResult>;
    /**
     * Read the model and provider catalog from OMP's own configuration files. Read-only.
     *
     * This is the SPI's catalog: `models.yml` providers and their models, the
     * `modelOverrides` a provider declares, and `modelRoles.default` plus `enabledModels`
     * from `config.yml`. OMP's bundled catalog is deliberately not read, so the result is the
     * configured subset; every read says so in `notes`.
     *
     * @returns The catalog, with every declared gap.
     */
    listModels(): Promise<AgentModelCatalog>;
    /**
     * Ask OMP itself for the models it can currently reach.
     *
     * This is an extra beyond the SPI: it runs `omp models --json`, which reports the resolved
     * catalog (bundled rows plus this machine's configuration and credentials) as JSON. OMP
     * refreshes provider catalogs *online if uncached*, so the probe is bounded but may reach a
     * provider; the file-based {@link listModels} needs no process and no network.
     *
     * @param search - Optional search text, passed to `omp models find`.
     * @returns Parsed rows plus declared gaps.
     */
    listNativeModels(search?: string): Promise<OmpModelListing>;
    /**
     * Argv that opens OMP's own TUI, optionally resuming a session.
     *
     * `--session-dir` is included whenever the adapter resolved a session directory itself,
     * because the TUI would otherwise resolve its own. The agent directory and the profile
     * cannot travel in argv: a launcher must export `PI_CODING_AGENT_DIR` (and clear
     * `OMP_PROFILE`/`PI_PROFILE` when it wants a home-directory override to win).
     *
     * @param nativeId - Session to resume; omitted opens OMP's default new session.
     * @returns The argv to launch.
     */
    nativeLaunchCommand(nativeId?: NativeSessionId): readonly string[];
    /**
     * Dispatch a run through `omp --mode json`, ending with exactly one `run.finished`.
     *
     * @param request - Run parameters; `prompt` travels on stdin.
     * @returns The run handle, its event stream and its terminal result.
     */
    run(request: AdapterRunRequest): Promise<AdapterRun>;
    /** The environment the store is resolved from: the host's plus per-adapter extras. */
    private storeEnv;
    /** The resolved binary: the configured override, else the bare name for `PATH`. */
    private binaryPath;
    /** Resolve the store layout from the same environment a run will see. */
    private layout;
    /**
     * The variables this adapter always resolves for OMP, before caller overrides.
     *
     * A home-directory override is expressed as `PI_CODING_AGENT_DIR`, which OMP honours only
     * for the default profile, so an explicitly-empty `OMP_PROFILE` is set alongside it: OMP
     * documents an explicitly-empty profile variable as selecting the default profile, and a
     * non-empty legacy `PI_PROFILE` is ignored once `OMP_PROFILE` is defined.
     */
    private derivedEnv;
    /** Build the orchestrator-facing part of a run handle. */
    private handleFor;
    /**
     * The argv for a run. `--mode json` is the headless transport; a resume passes
     * `--resume <id-or-path>` and never silently starts a fresh session instead.
     */
    private buildRunArgs;
    /** The environment for a run: derived variables, then the adapter's, then the caller's. */
    private buildRunEnv;
    /**
     * Resolve a resume id to the argument OMP should receive, and to any warning its own
     * resolution implies.
     *
     * OMP resolves a path verbatim and an id against the project bucket first, then globally;
     * it adopts the session's recorded cwd when that directory is enterable, so a session from
     * another project continues there. That is a divergence the caller should see, not a
     * reason to refuse the resume, because OMP has no interactive question to answer here.
     */
    private resolveResume;
    /** Read the stream, then classify the exit into exactly one terminal result. */
    private drive;
    /** Assemble the terminal result, with `exactOptionalPropertyTypes`-safe optionals. */
    private terminal;
}
/**
 * Create the OMP adapter.
 *
 * @param ctx - Ambient core services for this adapter.
 * @returns A ready adapter.
 */
export declare function createOmpAdapter(ctx: AdapterContext): OmpAdapter;
/**
 * Split a configured model string into OMP's `--provider` and `--model` values.
 *
 * `provider/id` is split at the first slash; anything else is passed verbatim, because a
 * bare pattern is legal (OMP also accepts role aliases such as `@slow`, a `:<thinking>`
 * suffix and fuzzy patterns), and guessing would silently select a different model.
 *
 * @param model - Model string from the run request or the adapter config.
 * @returns The provider, when the string has the `provider/id` shape, and the model value.
 */
export declare function splitOmpModel(model: string): {
    provider?: string;
    model: string;
};
/**
 * The harness wiring surface: the routes OMP's own `models.yml` declares, registered as
 * harness LLM providers. Exported here so a host reaches them through the package it
 * already depends on.
 */
export { OMP_LLM_SETTINGS_NS, OMP_ROUTE_PREFIX, createOmpLlmAdapter, ompRouteKey, registerOmpLlm, resolveOmpCredential, } from './llm.ts';
export type { OmpLlmAdapterDeps, OmpLlmRegistration, OmpLlmRegistrationOptions, OmpLlmRoute } from './llm.ts';
export type { OmpCatalogRead, OmpDeclaredCredential, OmpLlmDeclaration } from './models.ts';
export type { OmpReadContext } from './sessions.ts';
//# sourceMappingURL=index.d.ts.map