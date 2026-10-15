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
import { ErrorCodes, agentId as brandAgentId, runId as brandRunId, nativeSessionId, sessionKey, } from '@zorker/muti-agent-contracts';
import { resolve as resolvePath } from 'node:path';
import { buildEnvironment, detectionFrom, jsonLines, probeVersion, resolveBinary, } from '@zorker/muti-agent-core';
import { loginOmp, logoutOmp, readOmpAuthStatus } from "./auth.js";
import { readOmpCapabilities } from "./capabilities.js";
import { OmpRunProjection } from "./events.js";
import { readOmpModelCatalog } from "./models.js";
import { findOmpSessionFile, listOmpSessions, parseOmpSettings, readOmpNativeTasks, readOmpSessionLeadAt, readOmpTranscript, resolveOmpStore, } from "./sessions.js";
/** Canonical agent id. */
export const OMP_ID = 'omp';
/** Human name. */
export const OMP_DISPLAY_NAME = 'OMP';
/** Binary name OMP publishes; resolved through `PATH` unless the config overrides it. */
export const OMP_BINARY = 'omp';
/** Environment variable names this adapter resolves for a run; never values. */
export const OMP_RUN_ENVIRONMENT_KEYS = [
    'PI_CONFIG_DIR',
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'OMP_PROFILE',
    'PI_PROFILE',
];
/** How many bytes of native stderr are attached to a failed run's result. */
const MAX_STDERR_CHARS = 2_000;
/** Cap on the `omp models --json` probe, which may refresh provider catalogs online. */
const LIST_MODELS_TIMEOUT_MS = 60_000;
/** Approval modes `--approval-mode` accepts, in OMP's own vocabulary. */
const OMP_APPROVAL_MODES = ['always-ask', 'write', 'yolo'];
/**
 * The capability declaration, literal because consumers branch on it (ADR-0002).
 *
 * `nativeTodos` and `nativePlan` are declared because OMP keeps both in the session file
 * itself: a committed `todo` snapshot is a `custom` entry with `customType:
 * "user_todo_edit"` or the `details.phases` of a successful `todo` tool result, and plan
 * mode is a `mode_change` entry whose `mode` is `plan`/`plan_paused` with the plan file
 * path alongside — both read by `readNativeTasks()`.
 */
const OMP_CAPABILITIES = {
    runModes: ['headless-exec'],
    streaming: true,
    resume: true,
    interrupt: false,
    listSessions: true,
    readTranscript: true,
    nativeTodos: true,
    nativePlan: true,
    externalWorktree: false,
    mcpClient: true,
    listModels: true,
    sandboxProfiles: [],
    approvalModes: OMP_APPROVAL_MODES,
    credentials: { status: true, login: ['interactive'], logout: false },
};
/**
 * OMP's adapter. Construct through {@link createOmpAdapter}; the constructor is public so a
 * test can inject an environment.
 */
export class OmpAdapter {
    ctx;
    env;
    id = OMP_ID;
    displayName = OMP_DISPLAY_NAME;
    agent = brandAgentId(OMP_ID);
    described;
    /**
     * @param ctx - Ambient core services: logger, config, process runner, file probe.
     * @param env - Host environment to resolve the store and detection from.
     */
    constructor(ctx, env = process.env) {
        this.ctx = ctx;
        this.env = env;
    }
    /**
     * The static capability declaration.
     *
     * @returns The literal declaration; never detection-dependent.
     */
    capabilities() {
        return OMP_CAPABILITIES;
    }
    /**
     * Describe this agent, including detection on this machine. Detection is cached because
     * the catalog is queried on every GUI load and the probe spawns a process.
     *
     * @returns The descriptor.
     */
    async describe() {
        if (this.described !== undefined)
            return this.described;
        const layout = await this.layout();
        const resolution = await resolveBinary(OMP_BINARY, {
            ...(this.ctx.config.binaryPath === undefined ? {} : { candidates: [this.ctx.config.binaryPath] }),
            env: this.env,
        });
        const version = resolution.found && resolution.path !== undefined
            ? await probeVersion(this.ctx.process, resolution.path)
            : undefined;
        const descriptor = {
            id: this.agent,
            displayName: this.displayName,
            summary: 'OMP (oh-my-pi, @oh-my-pi/pi-coding-agent): a pi fork whose sessions are append-only JSONL trees ' +
                'headed by a fixed-width title slot.',
            capabilities: OMP_CAPABILITIES,
            detection: detectionFrom(resolution, {
                ...(version === undefined ? {} : { version }),
                homeDir: layout.agentDir,
            }),
            transports: [
                { mode: 'headless-exec', mechanism: 'omp --mode json', available: true },
                {
                    mode: 'duplex-protocol',
                    mechanism: 'omp --mode rpc (line-delimited JSON commands on stdin, events on stdout)',
                    available: false,
                },
            ],
            environmentKeys: OMP_RUN_ENVIRONMENT_KEYS,
            sessionRoot: layout.sessionDirOverride ?? layout.defaultSessionsRoot,
            credentialPath: layout.credentialPath,
        };
        this.described = descriptor;
        return descriptor;
    }
    /**
     * Enumerate OMP's sessions from its own store. Read-only.
     *
     * @param options - Cwd filter, limit and cancellation.
     * @returns Session summaries, newest first.
     */
    async listSessions(options) {
        return listOmpSessions(this.ctx, this.agent, options, this.storeEnv());
    }
    /**
     * Read a bounded transcript window along a session's live branch. Read-only.
     *
     * @param nativeId - OMP session id, or a session file path.
     * @param options - Message and byte caps.
     * @returns The window and its declared gaps.
     */
    async readTranscript(nativeId, options) {
        return readOmpTranscript(this.ctx, nativeId, options, this.storeEnv());
    }
    /**
     * Read OMP's own todo list and plan-mode state for a session.
     *
     * @param nativeId - OMP session id, or a session file path.
     * @returns The observed state, or `undefined` when the session records neither.
     */
    async readNativeTasks(nativeId) {
        return readOmpNativeTasks(this.ctx, this.agent, nativeId, this.storeEnv());
    }
    /**
     * Read OMP's capability inventory: tools, skills, MCP servers, commands and context files.
     *
     * @returns The inventory, read from OMP's own configuration without running it.
     */
    async readCapabilities() {
        return readOmpCapabilities(this.ctx, this.agent, { env: this.storeEnv() });
    }
    /**
     * Inspect OMP's credential store (`agent.db`) and the host environment. Never returns
     * secret material.
     *
     * @returns The observed auth state.
     */
    async authStatus() {
        return readOmpAuthStatus(this.ctx, this.agent, { env: this.storeEnv() });
    }
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
    async login(params) {
        return loginOmp(this.ctx, this.agent, params, this.storeEnv(), this.binaryPath());
    }
    /**
     * Report that OMP has no logout subcommand, with the paths that do revoke.
     *
     * @returns An unsuccessful result carrying the guidance and the observed state.
     */
    async logout() {
        return logoutOmp(this.ctx, this.agent, this.storeEnv());
    }
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
    async listModels() {
        return readOmpModelCatalog(this.ctx, this.agent, { env: this.storeEnv() });
    }
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
    async listNativeModels(search) {
        const layout = await this.layout();
        const args = search === undefined || search.trim() === ''
            ? ['models', '--json']
            : ['models', 'find', search.trim(), '--json'];
        const outcome = await this.ctx.process.run({
            command: this.binaryPath(),
            args,
            cwd: layout.agentDir,
            envMode: 'minimal',
            env: { ...this.derivedEnv(layout), ...this.ctx.config.env },
            timeoutMs: LIST_MODELS_TIMEOUT_MS,
            captureBytes: 1024 * 1024,
        });
        const notes = [];
        if (outcome.code !== 0) {
            notes.push({
                field: '*',
                reason: `\`omp models --json\` exited with ${outcome.code === undefined ? `signal ${String(outcome.signal)}` : `code ${String(outcome.code)}`}`,
            });
        }
        const listing = parseModelsJson(`${outcome.stdout.head}${outcome.stdout.tail}`);
        if (listing.error !== undefined) {
            notes.push({ field: 'models', reason: `omp's JSON model list could not be read: ${listing.error}` });
        }
        else if (listing.models.length === 0) {
            notes.push({ field: 'models', reason: 'omp listed no models' });
        }
        return { models: listing.models, notes };
    }
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
    nativeLaunchCommand(nativeId) {
        const argv = [this.binaryPath()];
        const settings = parseOmpSettings(this.ctx.config.settings);
        const envDir = this.env.PI_CODING_AGENT_SESSION_DIR;
        const resolvedDir = settings.sessionDir ??
            (envDir === undefined || envDir.trim() === '' ? undefined : envDir.trim());
        if (resolvedDir !== undefined)
            argv.push('--session-dir', this.ctx.files.resolvePath(resolvedDir));
        if (nativeId === undefined)
            return argv;
        argv.push('--resume', String(nativeId));
        return argv;
    }
    /**
     * Dispatch a run through `omp --mode json`, ending with exactly one `run.finished`.
     *
     * @param request - Run parameters; `prompt` travels on stdin.
     * @returns The run handle, its event stream and its terminal result.
     */
    async run(request) {
        const layout = await this.layout();
        const runIdValue = brandRunId(request.runId);
        const projection = new OmpRunProjection(runIdValue);
        const queue = new EventQueue();
        const finished = deferred();
        const startedAtMs = Date.now();
        const resumeId = request.resumeNativeId === undefined ? undefined : nativeSessionId(request.resumeNativeId);
        const resume = await this.resolveResume(resumeId, request.cwd);
        const args = this.buildRunArgs(request, resume.argument);
        const timeoutMs = request.timeoutMs ?? this.ctx.config.timeoutMs;
        const spec = {
            command: this.binaryPath(),
            args,
            cwd: request.cwd,
            envMode: this.ctx.config.envMode,
            env: this.buildRunEnv(request, layout),
            stdin: request.prompt,
            ...(timeoutMs > 0 ? { timeoutMs } : {}),
            captureBytes: 512 * 1024,
        };
        // The names are computed from the same spec the runner derives the child environment
        // from; in production `this.env` is the host environment the runner was built with.
        const environmentKeys = buildEnvironment(spec, this.env).names;
        const managed = this.ctx.process.start(spec);
        const handle = this.handleFor(request, args, environmentKeys, startedAtMs);
        queue.push({
            kind: 'run.started',
            runId: runIdValue,
            agentId: this.agent,
            at: new Date().toISOString(),
            ...(resumeId === undefined ? {} : { nativeSessionId: resumeId }),
        });
        if (layout.profile !== undefined && this.ctx.config.homeDir !== undefined) {
            // A named profile derives its own agent directory and ignores PI_CODING_AGENT_DIR, so
            // the run's environment selects the default profile for the override to take effect.
            projection.addNote(`the host environment selects profile "${layout.profile}", which would ignore the adapter's homeDir ` +
                'override, so the run was started with the default profile selected');
        }
        if (resume.warning !== undefined) {
            projection.addNote(resume.warning);
            queue.push(projection.warn(resume.warning, new Date().toISOString()));
        }
        if (request.prompt.trim() === '') {
            // OMP's print mode sends nothing and exits 0 when it receives neither argv nor stdin
            // content, so an empty prompt would look like a successful no-op turn.
            projection.addNote('the prompt was empty, so omp was started with nothing to send');
            queue.push(projection.warn('the prompt is empty: omp will exit without doing work', new Date().toISOString()));
        }
        if (request.sandbox !== undefined && request.sandbox !== '') {
            // Declaration over detection: capabilities().sandboxProfiles is empty, so a profile
            // can only arrive from a caller that ignored the declaration.
            projection.addNote('omp has no sandbox, so the requested sandbox profile was ignored');
            queue.push(projection.warn(`omp has no sandbox; the requested profile "${request.sandbox}" was ignored`, new Date().toISOString()));
        }
        if (request.approval !== undefined && !OMP_APPROVAL_MODES.includes(request.approval)) {
            projection.addNote(`approval "${request.approval}" is not one of omp's modes (${OMP_APPROVAL_MODES.join(', ')}), so no ` +
                'approval flag was passed and omp uses its configured mode');
        }
        void this.drive({ managed, queue, projection, handle, finished, startedAtMs, timeoutMs, runIdValue });
        return {
            // Nothing secret is an argv element: the prompt is on stdin and credentials reach
            // omp through agent.db or the derived environment.
            argv: args,
            environmentKeys,
            events: queue,
            result: finished.promise,
            cancel: () => {
                managed.kill('cancel');
            },
        };
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    /** The environment the store is resolved from: the host's plus per-adapter extras. */
    storeEnv() {
        return { ...this.env, ...this.ctx.config.env };
    }
    /** The resolved binary: the configured override, else the bare name for `PATH`. */
    binaryPath() {
        return this.ctx.config.binaryPath === undefined || this.ctx.config.binaryPath === ''
            ? OMP_BINARY
            : this.ctx.config.binaryPath;
    }
    /** Resolve the store layout from the same environment a run will see. */
    layout() {
        return resolveOmpStore(this.ctx, this.storeEnv());
    }
    /**
     * The variables this adapter always resolves for OMP, before caller overrides.
     *
     * A home-directory override is expressed as `PI_CODING_AGENT_DIR`, which OMP honours only
     * for the default profile, so an explicitly-empty `OMP_PROFILE` is set alongside it: OMP
     * documents an explicitly-empty profile variable as selecting the default profile, and a
     * non-empty legacy `PI_PROFILE` is ignored once `OMP_PROFILE` is defined.
     */
    derivedEnv(layout) {
        return {
            PI_CODING_AGENT_DIR: layout.agentDir,
            ...(layout.sessionDirOverride === undefined
                ? {}
                : { PI_CODING_AGENT_SESSION_DIR: layout.sessionDirOverride }),
            ...(this.ctx.config.homeDir === undefined ? {} : { OMP_PROFILE: '' }),
        };
    }
    /** Build the orchestrator-facing part of a run handle. */
    handleFor(request, argv, environmentKeys, startedAtMs) {
        return {
            id: brandRunId(request.runId),
            agentId: this.agent,
            status: 'running',
            startedAt: new Date(startedAtMs).toISOString(),
            cwd: request.cwd,
            isolation: request.isolation,
            argv,
            environmentKeys,
        };
    }
    /**
     * The argv for a run. `--mode json` is the headless transport; a resume passes
     * `--resume <id-or-path>` and never silently starts a fresh session instead.
     */
    buildRunArgs(request, resumeArgument) {
        const args = ['--mode', 'json'];
        if (resumeArgument !== undefined)
            args.push('--resume', resumeArgument);
        const model = request.model ?? this.ctx.config.model;
        if (model !== undefined && model.trim() !== '') {
            // OMP accepts `provider/model` and a bare id through `--model`; `--provider` is the
            // explicit form for the run record and keeps a provider whose ids contain a slash
            // unambiguous.
            const split = splitOmpModel(model);
            if (split.provider !== undefined)
                args.push('--provider', split.provider);
            args.push('--model', split.model);
        }
        if (request.approval !== undefined && OMP_APPROVAL_MODES.includes(request.approval)) {
            args.push('--approval-mode', request.approval);
        }
        return args;
    }
    /** The environment for a run: derived variables, then the adapter's, then the caller's. */
    buildRunEnv(request, layout) {
        return {
            ...this.derivedEnv(layout),
            ...this.ctx.config.env,
            ...request.env,
        };
    }
    /**
     * Resolve a resume id to the argument OMP should receive, and to any warning its own
     * resolution implies.
     *
     * OMP resolves a path verbatim and an id against the project bucket first, then globally;
     * it adopts the session's recorded cwd when that directory is enterable, so a session from
     * another project continues there. That is a divergence the caller should see, not a
     * reason to refuse the resume, because OMP has no interactive question to answer here.
     */
    async resolveResume(resumeId, cwd) {
        if (resumeId === undefined)
            return {};
        const path = await findOmpSessionFile(this.ctx, resumeId, this.storeEnv());
        if (path === undefined) {
            // OMP's own lookup may still succeed: it falls back to a global scan by id prefix,
            // and the terminal classification catches a resume that never started a session.
            return { argument: String(resumeId) };
        }
        const lead = await readOmpSessionLeadAt(this.ctx, path);
        const sessionCwd = lead.header === undefined || lead.header.cwd === '' ? undefined : lead.header.cwd;
        if (sessionCwd === undefined || resolvePath(sessionCwd) === resolvePath(cwd))
            return { argument: path };
        return {
            argument: path,
            warning: `session ${String(resumeId)} records cwd ${sessionCwd}, which differs from the requested ${cwd}; ` +
                'omp adopts a session\'s recorded cwd when that directory is enterable, so the run may execute there',
        };
    }
    /** Read the stream, then classify the exit into exactly one terminal result. */
    async drive(options) {
        const { managed, queue, projection, handle, finished, startedAtMs, runIdValue } = options;
        const stream = managed.stdout;
        if (stream === null) {
            projection.addNote('the run produced no stdout stream, so no events could be recorded');
        }
        else {
            try {
                for await (const record of jsonLines(stream, {
                    onError: (error, lineNumber) => {
                        // `jsonLines` flushes a synthetic trailing newline, so its own parser reports
                        // one empty line for a stream that simply ended; that is not a defect.
                        if (error === 'empty line')
                            return;
                        projection.addNote(`stdout line ${lineNumber} was not valid JSON (${error})`);
                    },
                    onOverflow: dropped => {
                        projection.addNote(`an over-long stdout line dropped ${dropped} bytes`);
                    },
                })) {
                    const at = new Date().toISOString();
                    for (const event of projection.observe(record.value, record.raw, at))
                        queue.push(event);
                }
            }
            catch (cause) {
                queue.push(projection.warn(`reading omp's event stream failed: ${cause instanceof Error ? cause.message : String(cause)}`, new Date().toISOString()));
            }
        }
        const outcome = await managed.outcome;
        const state = projection.state();
        const stderrTail = bounded(`${outcome.stderr.tail}${outcome.stderr.head}`.trim());
        let status = 'succeeded';
        let error;
        if (outcome.cancelled) {
            status = 'cancelled';
            error = { code: ErrorCodes.runCancelled, message: 'the run was cancelled' };
        }
        else if (outcome.timedOut) {
            status = 'timeout';
            error = {
                code: ErrorCodes.runTimeout,
                message: `the run exceeded its ${options.timeoutMs} ms budget`,
            };
        }
        else if (outcome.code === undefined && outcome.signal === undefined) {
            // The process never reported an exit status, which is how the runner reports a
            // spawn failure (a missing binary or a working directory that does not exist).
            status = 'failed';
            error = {
                code: ErrorCodes.runStartFailed,
                message: `omp could not be started in ${handle.cwd}`,
                remediation: 'Check that the omp binary exists and is executable, and that the working directory exists.',
            };
        }
        else if (outcome.code !== undefined && outcome.code !== 0) {
            status = 'failed';
            error = classifyOmpExit(outcome.code, stderrTail);
        }
        else if (state.lastStopReason === 'error') {
            // OMP's JSON mode exits non-zero for a terminal failure, but stays 0 for a silent
            // abort (a plan-mode compaction transition), which the stream's own reason reports.
            status = 'failed';
            error = {
                code: ErrorCodes.runAgentCrashed,
                message: state.lastErrorMessage ?? 'the assistant response failed',
                remediation: 'Check the model and provider credentials configured for this agent; the run itself started cleanly.',
            };
        }
        else if (state.sessionId === undefined) {
            // No session header means OMP never established a session at all: the signature of a
            // resume it could not resolve before any turn work.
            status = 'failed';
            error = {
                code: ErrorCodes.runContextUnavailable,
                message: 'omp exited without starting a session and produced no events',
                remediation: 'Check the session id and the working directory: omp resolves a resume id against the ' +
                    "project's session bucket and then globally, and reports an unknown id as an error.",
            };
        }
        else if (state.aborted) {
            status = 'cancelled';
            error = { code: ErrorCodes.runCancelled, message: 'omp aborted the turn' };
        }
        if (state.sessionId !== undefined && !state.settled && status === 'succeeded') {
            projection.addNote('the stream ended before omp reported a terminal agent_end, so the turn may not have finished');
        }
        const result = this.terminal(handle, status, projection, startedAtMs, {
            ...(error?.code === undefined ? {} : { code: error.code }),
            ...(error?.message === undefined ? {} : { message: error.message }),
            ...(error?.remediation === undefined ? {} : { remediation: error.remediation }),
            ...(error === undefined || stderrTail === '' ? {} : { output: stderrTail }),
            ...(outcome.code === undefined ? {} : { exitCode: outcome.code }),
            ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
            ...(state.finalText === undefined ? {} : { finalText: state.finalText }),
            ...(state.usage === undefined ? {} : { usage: state.usage }),
            ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
        });
        queue.push({ kind: 'run.finished', runId: runIdValue, at: result.finishedAt, result });
        queue.close();
        finished.resolve(result);
    }
    /** Assemble the terminal result, with `exactOptionalPropertyTypes`-safe optionals. */
    terminal(handle, status, projection, startedAtMs, details) {
        const result = {
            handle: {
                ...handle,
                status,
                ...(details.sessionId === undefined
                    ? {}
                    : { sessionKey: sessionKey(this.agent, nativeSessionId(details.sessionId)) }),
            },
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAtMs,
            ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
            ...(details.signal === undefined ? {} : { signal: details.signal }),
            ...(details.finalText === undefined ? {} : { finalText: details.finalText }),
            ...(details.usage === undefined ? {} : { usage: details.usage }),
            notes: [...projection.state().notes],
        };
        if (details.code !== undefined && details.message !== undefined) {
            result.error = {
                code: details.code,
                message: details.message,
                ...(details.remediation === undefined ? {} : { remediation: details.remediation }),
                ...(details.output === undefined ? {} : { output: details.output }),
            };
        }
        return result;
    }
}
/**
 * Create the OMP adapter.
 *
 * @param ctx - Ambient core services for this adapter.
 * @returns A ready adapter.
 */
export function createOmpAdapter(ctx) {
    return new OmpAdapter(ctx);
}
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
export function splitOmpModel(model) {
    const trimmed = model.trim();
    if (trimmed.startsWith('@'))
        return { model: trimmed };
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1)
        return { model: trimmed };
    const provider = trimmed.slice(0, slash);
    const id = trimmed.slice(slash + 1);
    if (id === '' || !/^[A-Za-z0-9._-]+$/.test(provider))
        return { model: trimmed };
    return { provider, model: id };
}
/** A single-consumer async queue: the pump pushes, the run's consumer pulls. */
class EventQueue {
    buffered = [];
    waiter;
    closed = false;
    /**
     * Enqueue one event.
     *
     * @param event - Event to emit, in order.
     */
    push(event) {
        const waiter = this.waiter;
        if (waiter !== undefined) {
            this.waiter = undefined;
            waiter({ value: event, done: false });
            return;
        }
        this.buffered.push(event);
    }
    /** Signal completion, after the terminal event has been pushed. */
    close() {
        this.closed = true;
        const waiter = this.waiter;
        if (waiter !== undefined) {
            this.waiter = undefined;
            waiter({ value: undefined, done: true });
        }
    }
    async *[Symbol.asyncIterator]() {
        while (true) {
            const buffered = this.buffered.shift();
            if (buffered !== undefined) {
                yield buffered;
                continue;
            }
            if (this.closed)
                return;
            const result = await new Promise(resolve => {
                this.waiter = resolve;
            });
            if (result.done === true)
                return;
            yield result.value;
        }
    }
}
/** A promise with an exposed resolver, so a background pump can settle it. */
function deferred() {
    let resolve;
    const promise = new Promise(res => {
        resolve = res;
    });
    return {
        promise,
        resolve: (value) => {
            resolve?.(value);
        },
    };
}
/** Classify a non-zero omp exit, or a process that never ran, into a canonical code. */
function classifyOmpExit(code, stderr) {
    if (/session .* not found|no sessions found|session file not found/i.test(stderr)) {
        return {
            code: ErrorCodes.sessionNotFound,
            message: 'omp could not find the requested session',
            remediation: "Check the session id, or resume within the session's own project directory; MutiAgent reads the same store omp does.",
        };
    }
    if (/no api key|invalid api key|not (logged in|authenticated)|unauthorized|\b401\b|no models available/i.test(stderr)) {
        return {
            code: ErrorCodes.authNotConfigured,
            message: `omp exited with code ${String(code)} without a usable credential`,
            remediation: 'Authenticate omp (run `omp login`, or use /login) or export the API key its models.yml names.',
        };
    }
    if (/rate.?limit|\b429\b|quota/i.test(stderr)) {
        return {
            code: ErrorCodes.runRateLimited,
            message: `omp exited with code ${String(code)} after a provider rate limit`,
            remediation: 'Retry after the quota resets, or configure a different model for this agent.',
        };
    }
    return {
        code: ErrorCodes.runAgentCrashed,
        message: `omp exited with code ${String(code)}`,
        remediation: 'Inspect the attached stderr tail; a missing model or an unreadable extension are the usual causes.',
    };
}
/** Bound a diagnostic string for a run record, keeping its tail. */
function bounded(text) {
    return text.length > MAX_STDERR_CHARS ? text.slice(text.length - MAX_STDERR_CHARS) : text;
}
/**
 * Parse the `{ models: [...] }` document `omp models --json` prints.
 *
 * Rows are read field by field, so a revision that adds a field cannot break the parse; a
 * document that is not the expected shape is reported as an error instead of being read as
 * an empty list.
 *
 * @param text - Captured stdout.
 * @returns The rows and, when the document was unusable, why.
 */
function parseModelsJson(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return { models: [], error: 'the probe printed nothing' };
    let decoded;
    try {
        decoded = JSON.parse(trimmed);
    }
    catch (cause) {
        return { models: [], error: cause instanceof Error ? cause.message : String(cause) };
    }
    const raw = Array.isArray(decoded) ? decoded : readRecordField(decoded, 'models');
    if (!Array.isArray(raw))
        return { models: [], error: 'the document holds no `models` array' };
    const models = [];
    for (const row of raw) {
        const provider = readRecordField(row, 'provider');
        const id = readRecordField(row, 'id');
        if (typeof provider !== 'string' || provider === '' || typeof id !== 'string' || id === '')
            continue;
        const selector = readRecordField(row, 'selector');
        const name = readRecordField(row, 'name');
        const contextWindow = readRecordField(row, 'contextWindow');
        const maxTokens = readRecordField(row, 'maxTokens');
        const reasoning = readRecordField(row, 'reasoning');
        const input = readRecordField(row, 'input');
        models.push({
            provider,
            id,
            ...(typeof selector === 'string' && selector !== '' ? { selector } : {}),
            ...(typeof name === 'string' && name !== '' ? { name } : {}),
            ...(typeof contextWindow === 'number' && Number.isFinite(contextWindow) ? { contextWindow } : {}),
            ...(typeof maxTokens === 'number' && Number.isFinite(maxTokens) ? { maxTokens } : {}),
            ...(typeof reasoning === 'boolean' ? { reasoning } : {}),
            ...(Array.isArray(input) ? { images: input.includes('image') } : {}),
        });
    }
    return { models };
}
/**
 * Read one field of a decoded JSON value, without narrowing the caller to `any`.
 *
 * @param value - Decoded JSON value.
 * @param key - Field name.
 * @returns The field value, or `undefined` when the value is not an object or lacks the key.
 */
function readRecordField(value, key) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    return value[key];
}
/**
 * The harness wiring surface: the routes OMP's own `models.yml` declares, registered as
 * harness LLM providers. Exported here so a host reaches them through the package it
 * already depends on.
 */
export { OMP_LLM_SETTINGS_NS, OMP_ROUTE_PREFIX, createOmpLlmAdapter, ompRouteKey, registerOmpLlm, resolveOmpCredential, } from "./llm.js";
//# sourceMappingURL=index.js.map