/**
 * OMP's model and provider catalog, read from OMP's own configuration files.
 *
 * OMP resolves the models a machine can actually run from the agent directory's
 * `models.yml` / `models.yaml` — `providers` is the only root key its registry
 * consumes — together with the effective `config.yml` settings (`modelRoles.default`
 * names the startup model, `enabledModels` scopes chat-model selection). This module
 * projects those files onto `AgentModelCatalog` (ADR-0002), read-only and
 * credential-blind: an `apiKey` is classified by the shape OMP's own resolver gives it
 * (`!command`, an exact environment-variable name, or a literal) and never read into
 * the catalog, and `credentialPresent` comes from whether that variable is set or
 * `agent.db` holds a credential row for the provider.
 *
 * What is deliberately not read: OMP's bundled catalog (`@oh-my-pi/pi-catalog`, the
 * built-in provider and model rows plus per-provider policy rules). It is versioned
 * with OMP itself, it is not a user's configuration, and a catalog built from it would
 * describe OMP rather than this machine. The result is therefore the **configured
 * subset** — exactly what a user's own files change — and every read says so in
 * `notes`.
 *
 * Three facts about the file model shape the code:
 *
 * - `models.yml` is read from the **agent directory only** (a named profile's agent
 *   directory in profile mode); OMP documents no project-tier equivalent, so a
 *   `<cwd>/.omp/models.yml` is checked, reported and deliberately not projected.
 *   `config.yml`, by contrast, has a project layer at `<cwd>/.omp/config.yml`, and its
 *   `modelRoles` layer is merged project-over-agent exactly as OMP's own settings do.
 * - A provider entry is either a full custom provider (`models` non-empty, which
 *   requires `baseUrl` and an `apiKey` unless `auth: none`/`oauth`) or an override
 *   (`models` empty) that patches a bundled provider; an override may name providers
 *   and models this reader cannot enumerate, which is reported rather than invented.
 * - A parse failure is a declared gap, never an error: the reader returns whatever else
 *   was recoverable and names the file and the reason in `sources` and `notes`.
 *
 * @module @zorker/muti-agent-adapter-omp/models
 */
import type { AgentId, AgentModelCatalog } from '@zorker/muti-agent-contracts';
import type { OmpReadContext } from './sessions.ts';
/** Options for {@link readOmpModelCatalog}. */
export interface OmpModelCatalogOptions {
    /** Environment credential references are resolved against; defaults to the host's. */
    env?: NodeJS.ProcessEnv;
    /** Directory whose `.omp` project tier is read; defaults to the process working directory. */
    cwd?: string;
    /** Observation time in milliseconds; injected for testability. */
    now?: number;
}
/**
 * How OMP resolves one provider's declared `apiKey`.
 *
 * The value itself is carried only for a literal, because only that form can be sent
 * without running the user's command or reading the environment first.
 */
export type OmpDeclaredCredential = 
/** `!command`: OMP runs a shell command. Refused by the LLM route rather than executed. */
{
    kind: 'command';
}
/** No reference: the value itself. */
 | {
    kind: 'literal';
    value: string;
}
/** The variable OMP's exact-name lookup resolves, or a bundled provider's ambient variable. */
 | {
    kind: 'env';
    names: readonly string[];
}
/** Nothing declared and no ambient variable OMP is known to read. */
 | {
    kind: 'none';
};
/**
 * One `models.yml` provider declaration, projected for the harness LLM bridge.
 *
 * This is the same parse the catalog is built from, projected differently: a route needs
 * the endpoint, the declared headers and the credential shape, which the canonical
 * `AgentProvider` deliberately does not carry (ADR-0002 keeps that schema provider-neutral).
 */
export interface OmpLlmDeclaration {
    /** Provider id, verbatim. */
    providerId: string;
    /** `api`, verbatim; absent when the entry declares none. */
    api?: string;
    /** `baseUrl`, verbatim. */
    baseUrl?: string;
    /** Provider-declared request headers. May carry a credential-shaped value; never logged. */
    headers?: Readonly<Record<string, string>>;
    credential: OmpDeclaredCredential;
    /** Model ids this provider's own `models` array declares. */
    modelIds: readonly string[];
    /** Declared models whose own entry overrides `api` or `baseUrl`, which a route cannot honour. */
    transportOverrides: readonly string[];
}
/** One read of OMP's configuration: the canonical catalog, and the LLM routes it declares. */
export interface OmpCatalogRead {
    /** What the catalog SPI consumes. */
    catalog: AgentModelCatalog;
    /** One entry per `models.yml` provider, in file order. */
    declarations: readonly OmpLlmDeclaration[];
}
/**
 * Read OMP's configured model and provider catalog. Read-only, and never throwing for an
 * absent file, a missing agent directory or a malformed `models.yml`: each degrades into a
 * `sources` entry and a {@link ProjectionNote}.
 *
 * @param ctx - Ambient services (logger, runtime config, read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment, project directory and observation time; injected for testability.
 * @returns The catalog of what OMP's own configuration declares on this machine.
 */
export declare function readOmpModelCatalog(ctx: OmpReadContext, agent: AgentId, options?: OmpModelCatalogOptions): Promise<AgentModelCatalog>;
/**
 * Read OMP's configuration once, as both the canonical catalog and the provider
 * declarations an LLM route needs.
 *
 * One parse feeds both projections, so a route can never describe an endpoint or a model
 * set that the catalog does not: the same `models.yml` text decides what this machine can
 * run and what the harness may select.
 *
 * @param ctx - Ambient services (logger, runtime config, read-only file helpers).
 * @param agent - This adapter's canonical agent id.
 * @param options - Environment, project directory and observation time; injected for testability.
 * @returns The catalog plus one declaration per `models.yml` provider.
 */
export declare function readOmpModelCatalogWithRoutes(ctx: OmpReadContext, agent: AgentId, options?: OmpModelCatalogOptions): Promise<OmpCatalogRead>;
//# sourceMappingURL=models.d.ts.map