/**
 * Standalone MCP entry. `node lib/mcp-stdio.js` speaks MCP over stdin/stdout so an
 * agent, IDE or another orchestrator can drive MutiAgent without the harness running
 * (ADR-0011). Diagnostics go to stderr; stdout carries only protocol frames.
 *
 * @module @zorker/muti-agent-plugin/host/mcp-stdio-entry
 */

import { startStdioServer } from '@zorker/muti-agent-control-plane'

/** Start the server, reporting a startup failure as a clean stderr message and exit. */
async function main(): Promise<void> {
  try {
    await startStdioServer(process.env)
  } catch (cause) {
    process.stderr.write(
      `[muti-agent] mcp server could not start: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
    process.exitCode = 1
  }
}

await main()
