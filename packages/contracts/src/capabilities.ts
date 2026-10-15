/**
 * Validators for an adapter's capability declaration.
 *
 * @module @zorker/muti-agent-contracts/capabilities
 */

import { s, type Schema } from './validate.ts'

/** Validator for a run mode. */
export const RunModeSchema: Schema<string> = s
  .string()
  .enumOf(['headless-exec', 'duplex-protocol'])
  .describeAs('How a delegated run is driven.')

/** Validator for a credential flow kind. */
export const CredentialFlowSchema: Schema<string> = s
  .string()
  .enumOf(['oauth-loopback', 'device-code', 'api-key', 'interactive'])
  .describeAs('A credential flow an agent can complete.')

/**
 * Validator for {@link import('./agent.ts').AgentCapabilities}. Used by the
 * registry to reject a malformed declaration at registration time instead of
 * letting a consumer branch on an undefined flag later.
 */
export const AgentCapabilitiesSchema = s
  .objectOpt(
    {
      runModes: s.array(RunModeSchema).describeAs('Run modes this adapter implements.'),
      streaming: s.boolean().describeAs('Whether a run emits incremental events.'),
      resume: s.boolean().describeAs('Whether a native session can be continued.'),
      interrupt: s.boolean().describeAs('Whether a run can be interrupted mid-turn.'),
      listSessions: s.boolean().describeAs('Whether sessions can be enumerated offline.'),
      readTranscript: s.boolean().describeAs('Whether a transcript can be read from disk.'),
      nativeTodos: s.boolean().describeAs('Whether the agent maintains a readable todo list.'),
      nativePlan: s.boolean().describeAs('Whether the agent has a readable plan mode.'),
      externalWorktree: s.boolean().describeAs('Whether the agent accepts an externally created worktree.'),
      mcpClient: s.boolean().describeAs('Whether the agent can pull data through MCP.'),
      listModels: s.boolean().describeAs('Whether the agent exposes a model list.'),
      sandboxProfiles: s.array(s.string()).describeAs('Sandbox profile names the agent accepts.'),
      approvalModes: s.array(s.string()).describeAs('Approval modes the agent accepts.'),
      credentials: s
        .objectOpt(
          {
            status: s.boolean().describeAs('Whether status is determinable without a human.'),
            login: s.array(CredentialFlowSchema).describeAs('Login flows available.'),
            logout: s.boolean().describeAs('Whether logout is available.'),
          },
          {},
        )
        .describeAs('Credential operations supported through the native CLI.'),
    },
    {},
  )
  .describeAs('What an adapter declares it supports.')
