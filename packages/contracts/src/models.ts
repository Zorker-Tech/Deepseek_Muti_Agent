/**
 * The model and provider catalog of one agent, read from that agent's own configuration.
 *
 * Why this exists: an agent's usable models are mostly **not** built in. They are declared
 * in its config file — Codex's `config.toml` `[model_providers]` and `model`, Grok's
 * `config.toml` `[models]`, Pi's `models.json` `providers` — together with the endpoint and
 * the environment variable that carries the API key. A control plane that offered only the
 * product's own model list would be wrong about what a machine can actually run, so the
 * catalog is read from the same files the agent reads (ADR-0002, ADR-0012).
 *
 * Reading is read-only, like every other foreign store MutiAgent touches; a parse failure
 * degrades to a declared gap rather than an error.
 *
 * @module @zorker/muti-agent-contracts/models
 */

import type { AgentId } from './ids.ts'
import type { ProjectionNote } from './session.ts'

/** Where a declaration was found. */
export type ModelSource = 'builtin' | 'config' | 'env' | 'catalog'

/** One endpoint an agent can reach, as its configuration declares it. */
export interface AgentProvider {
  /** Provider id as the agent names it, e.g. `openai`, `lmstudio`, `openrouter`. */
  id: string
  /** Display name, when the configuration gives one. */
  name?: string
  /** Base URL the provider is reached at. */
  baseUrl?: string
  /**
   * Name of the environment variable that carries this provider's API key.
   *
   * A name, never a value: MutiAgent reports which variable a provider expects so a user
   * can see why a provider is unusable, and never reads the secret itself.
   */
  apiKeyEnv?: string
  /** Whether that variable (or a stored credential for this provider) is present. */
  credentialPresent?: boolean
  /** Wire protocol the provider speaks, when named, e.g. `responses`, `openai-completions`. */
  wireApi?: string
  /** Where this provider definition came from. */
  source: ModelSource
}

/** One model an agent will accept by id. */
export interface AgentModel {
  /** The id to pass to the agent, verbatim. */
  id: string
  /** Display name, when the configuration gives one. */
  displayName?: string
  /** Provider that serves it, when the configuration ties it to one. */
  providerId?: string
  /** Whether this is the model the agent will use with no override. */
  isDefault?: boolean
  /** Context window in tokens, when configured. */
  contextWindow?: number
  /** Reasoning-effort levels this model accepts, when configured. */
  reasoningEfforts?: readonly string[]
  /** Where this model was declared. */
  source: ModelSource
}

/** One configuration file the catalog was read from. */
export interface ModelSourceFile {
  /** Absolute path. */
  path: string
  /** Whether it existed. */
  present: boolean
  /** Why it contributed nothing, when that is worth saying. */
  note?: string
}

/** One agent's model and provider catalog. */
export interface AgentModelCatalog {
  /** The agent this catalog describes. */
  agentId: AgentId
  /** The model the agent would use with no override. */
  defaultModel?: string
  /** Endpoints the agent can reach. */
  providers: readonly AgentProvider[]
  /** Models the agent accepts. */
  models: readonly AgentModel[]
  /** Files read, so a user can see where the answer came from. */
  sources: readonly ModelSourceFile[]
  /** Declared gaps: what could not be read and why. */
  notes: readonly ProjectionNote[]
  /** When the catalog was read. */
  observedAt: string
}
