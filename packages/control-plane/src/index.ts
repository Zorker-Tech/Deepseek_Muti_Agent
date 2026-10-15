/**
 * MutiAgent control plane: the operation catalog and the three surfaces generated from
 * it — native harness tools, an MCP server, and the authenticated HTTP+SSE gateway
 * (ADR-0011).
 *
 * @module @zorker/muti-agent-control-plane
 */

export * from './operations/catalog.ts'
export * from './operations/register.ts'
export * from './dispatch.ts'
export * from './gateway.ts'
export * from './tools.ts'
export * from './adapters.ts'
export * from './mcp/server.ts'
export * from './mcp/stdio.ts'
