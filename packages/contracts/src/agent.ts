/**
 * Agent descriptors: what an integrated agent is, what it can do, and how MutiAgent
 * is allowed to talk to it. Consumers branch on {@link AgentCapabilities}, never on
 * an agent id, so a new agent needs no consumer changes (ADR-0002).
 *
 * @module @zorker/muti-agent-contracts/agent
 */

import type { AgentId } from './ids.ts'

/**
 * How a delegated run is driven.
 *
 * - `headless-exec`: a one-shot process that runs a prompt and exits, emitting a
 *   line-oriented event stream.
 * - `duplex-protocol`: a long-lived request/response session (JSON-RPC or equivalent).
 */
export type RunMode = 'headless-exec' | 'duplex-protocol'

/** Credential flows an agent can complete without a human editing a file by hand. */
export type CredentialFlow = 'oauth-loopback' | 'device-code' | 'api-key' | 'interactive'

/**
 * What an adapter supports, declared rather than assumed.
 *
 * Every consumer must read these flags instead of hardcoding per-agent behavior; an
 * unsupported capability renders as an explanation in the UI, never as a dead control.
 */
export interface AgentCapabilities {
  /** Run modes this adapter implements. */
  runModes: readonly RunMode[]
  /** Whether a run emits incremental events before it finishes. */
  streaming: boolean
  /** Whether a previously created native session can be continued. */
  resume: boolean
  /** Whether a run can be interrupted mid-turn (not only killed). */
  interrupt: boolean
  /** Whether session summaries can be enumerated without running the agent. */
  listSessions: boolean
  /** Whether a full transcript can be read from disk. */
  readTranscript: boolean
  /** Whether the agent maintains its own todo list that MutiAgent can read. */
  nativeTodos: boolean
  /** Whether the agent has a plan mode whose state MutiAgent can read. */
  nativePlan: boolean
  /** Whether the agent can be told to work in a git worktree it did not create. */
  externalWorktree: boolean
  /** Whether the agent is an MCP client and can therefore pull the shared board. */
  mcpClient: boolean
  /** Whether the agent exposes a model/provider listing MutiAgent can surface. */
  listModels: boolean
  /** Sandbox profile names the agent accepts, when it has a sandbox. */
  sandboxProfiles: readonly string[]
  /** Approval modes the agent accepts. */
  approvalModes: readonly string[]
  /** Credential operations supported through the native CLI. */
  credentials: {
    /** Whether status can be determined without a human. */
    status: boolean
    /** Login flows available non-interactively or with a surfaced human step. */
    login: readonly CredentialFlow[]
    /** Whether logout is available. */
    logout: boolean
  }
}

/** How an agent was located on this machine. */
export interface AgentDetection {
  /** Whether a usable binary was found. */
  installed: boolean
  /** Absolute path of the resolved binary, when found. */
  binaryPath?: string
  /** Which probe produced the path: `path`, `config`, or `well-known`. */
  source: 'path' | 'config' | 'well-known' | 'none'
  /** Version string reported by the binary, verbatim. */
  version?: string
  /** Absolute path of the agent's home/config directory. */
  homeDir?: string
  /** Why detection failed, when it did. Never a stack trace; a remediation line. */
  reason?: string
}

/** One transport an adapter can use, for display and diagnostics. */
export interface AgentTransport {
  /** Run mode this transport implements. */
  mode: RunMode
  /** Native mechanism, e.g. `codex exec --json`. */
  mechanism: string
  /** Whether the transport is implemented in this adapter version. */
  available: boolean
}

/**
 * A fully described integrated agent. Produced by an adapter's `describe()` and
 * returned verbatim from the catalog operations, so the GUI and external MCP clients
 * see the same declaration.
 */
export interface AgentDescriptor {
  /** Canonical agent id. */
  id: AgentId
  /** Human name, e.g. `Codex`. */
  displayName: string
  /** One-line description of the product behind the adapter. */
  summary: string
  /** Capability declaration. */
  capabilities: AgentCapabilities
  /** Detection result on this machine. */
  detection: AgentDetection
  /** Transports the adapter knows about. */
  transports: readonly AgentTransport[]
  /** Environment variables the adapter sets for a run, names only. */
  environmentKeys: readonly string[]
  /** Where session data lives, for display. */
  sessionRoot?: string
  /** Where credentials live, for display. Not a secret. */
  credentialPath?: string
}

/** Authentication state of one agent, with no secret material anywhere inside. */
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'expired' | 'misconfigured' | 'unknown'

/** Where the observed credential came from. */
export type AuthSource = 'file' | 'env' | 'keyring' | 'cli-probe' | 'none'

/** Authentication state of one agent, safe to transmit to the GUI and to tools. */
export interface AgentAuthState {
  /** Canonical agent id. */
  agentId: AgentId
  /** Classified state. */
  status: AuthStatus
  /** How the state was determined. */
  source: AuthSource
  /** Credential mechanism observed, e.g. `api-key`, `chatgpt-oauth`. */
  method?: string
  /** Account identifier or email, when the agent's store exposes one. */
  account?: string
  /** Subscription/plan label, when exposed. */
  plan?: string
  /** ISO 8601 expiry of the current credential, when known. */
  expiresAt?: string
  /** Where the credential is stored, for display. */
  credentialPath?: string
  /** Environment variables currently supplying a credential, names only. */
  environmentKeys: readonly string[]
  /** Human-readable explanation of a non-authenticated state. */
  detail?: string
  /** ISO 8601 time this state was observed. */
  observedAt: string
}

/** Result of a login or logout attempt: the intent plus the observed post-state. */
export interface AuthOperationResult {
  /** Whether the CLI process exited successfully. */
  ok: boolean
  /** What was attempted. */
  action: 'login' | 'logout'
  /** Interaction the user must complete, when the flow is not fully automatic. */
  interaction?: {
    kind: 'browser-url' | 'device-code' | 'stdin-secret' | 'none'
    /** Verification URL to open, when the flow provides one. */
    url?: string
    /** Device/user code to display, when the flow provides one. */
    code?: string
    /** Instructions for the human, in the flow's own terms. */
    instructions?: string
  }
  /** State observed immediately after the attempt; never the intent. */
  state: AgentAuthState
  /** Redacted tail of the CLI output, for diagnosis. */
  output?: string
}
