/**
 * Native harness tools. Every non-read operation in the catalog becomes a tool the
 * harness's own agent can call, named `mutiagent_<operation>`, so orchestrating other
 * agents is something the harness agent does with the same methods the GUI uses
 * (ADR-0011).
 *
 * Tool definitions are built **structurally** rather than with `defineTool`. The
 * required shape is small and documented (`{ name, description, parameters, output }`
 * where `parameters` is plain JSON Schema and `output.render` is a pure projection),
 * and importing the helper would make this plugin's boot depend on a pre-stable
 * in-tree export (ADR-0006). The operation's own schema already *is* the JSON Schema
 * the registry wants, so nothing is re-implemented.
 *
 * @module @zorker/muti-agent-control-plane/tools
 */

import { PLUGIN_VERSION, SCHEMA_VERSION } from '@zorker/muti-agent-contracts'
import type { JsonSchema } from '@zorker/muti-agent-contracts'
import { Dispatcher, isChallenge, trustedActor } from './dispatch.ts'
import type { MeshOperation } from './operations/catalog.ts'

/** A content block as the harness's tool pipeline expects it. */
export interface ContentBlock {
  type: 'text'
  text: string
}

/**
 * A tool definition the harness's `tools.register` accepts.
 *
 * Field names and semantics follow the harness's `ToolDefinition`; only the members
 * this plugin actually supplies are declared.
 */
export interface MeshToolDefinition {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>
  output: {
    /** JSON Schema enforced against the canonical value `execute` returns. */
    schema: JsonSchema
    /**
     * Pure projection from validated arguments and the canonical value to model
     * content.
     *
     * @param args - Validated arguments.
     * @param value - The canonical value returned by `execute`.
     */
    render: (args: unknown, value: unknown) => ContentBlock[]
  }
  /**
   * Run one call.
   *
   * @param args - Validated arguments.
   * @param exec - Execution identity, including the caller's cancellation signal.
   */
  execute: (args: unknown, exec: { signal?: AbortSignal, agent?: { id?: string } }) => Promise<unknown>
  /** Pure presentation metadata for the pending state. */
  presentCall?: (args: unknown) => { card: 'generic', title: string, kind: 'other' | 'read' | 'execute', rawInput?: unknown }
  /** Cooperative timeout budget. */
  timeoutMs?: number
}

/** The tool name for an operation: dots become underscores so the name is portable. */
export function toolNameFor(operationId: string): string {
  return `mutiagent_${operationId.replace(/\./g, '_')}`
}

/**
 * Convert one operation into a harness tool definition.
 *
 * @param operation - The catalog entry.
 * @param dispatcher - Shared dispatch, so a tool call and an HTTP call are the same code path.
 * @returns A definition ready for `ctx.tools.register`.
 */
export function defineMeshTool(
  operation: MeshOperation<never, unknown>,
  dispatcher: Dispatcher,
): MeshToolDefinition {
  const confirmed = operation.danger !== 'safe' && operation.scope !== 'read'
  const description = [
    operation.summary,
    `Authority: ${operation.scope}${operation.danger === 'safe' ? '' : `, ${operation.danger}`}.`,
    confirmed
      ? 'This tool only reads a confirmation challenge unless you pass `confirm: true` after a human approved it.'
      : '',
    `MutiAgent ${PLUGIN_VERSION}, schema v${String(SCHEMA_VERSION)}.`,
  ]
    .filter(part => part !== '')
    .join(' ')

  const definition: MeshToolDefinition = {
    name: toolNameFor(operation.id),
    description,
    parameters: toHarnessToolSchema(operation.params.toJsonSchema() as unknown as JsonSchemaNode),
    output: {
      // Every operation returns an object, so an open object is the honest schema: it is
      // accepted by the harness's structural check, and it does not claim field-level
      // validation we do not perform. `json` is an author-side keyword in the harness's
      // parameter dialect and is rejected here.
      schema: { type: 'object', additionalProperties: true } as JsonSchema,
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    execute: async (args, exec) => {
      const actor = trustedActor(
        exec.agent?.id === undefined ? 'harness-agent' : `harness-agent:${exec.agent.id}`,
      )
      const result = await dispatcher.invoke(
        { method: operation.id, params: args ?? {} },
        { actor, ...(exec.signal === undefined ? {} : { signal: exec.signal }) },
      )
      // The harness reports a thrown error as a failed tool call, which is what a
      // model needs in order to correct itself; an envelope it cannot see would be
      // reported as success with an error body.
      if (!result.ok) {
        throw new ToolCallFailure(result.error.code, result.error.message, result.error.remediation)
      }
      if (isChallenge(result.result)) return result.result
      return result.result
    },
    presentCall: args => ({
      card: 'generic',
      title: operation.summary,
      kind: operation.scope === 'read' ? 'read' : 'execute',
      ...(args === undefined ? {} : { rawInput: args }),
    }),
  }
  if (operation.scope !== 'read') definition.timeoutMs = 24 * 60 * 60 * 1000
  return definition
}

/** A failure carrying the operation's structured error, so the model sees the code. */
export class ToolCallFailure extends Error {
  /**
   * @param code - MutiAgent error code.
   * @param message - What went wrong.
   * @param remediation - The next step, when there is one.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly remediation?: string,
  ) {
    super(remediation === undefined ? `${code}: ${message}` : `${code}: ${message}\n\nNext step: ${remediation}`)
    this.name = 'ToolCallFailure'
  }
}

/**
 * Build every exposed tool.
 *
 * @param dispatcher - Shared dispatch.
 * @returns Definitions keyed by tool name.
 */
export function buildTools(dispatcher: Dispatcher): readonly MeshToolDefinition[] {
  return dispatcher.operations
    .tools()
    .map(operation => defineMeshTool(operation, dispatcher))
}

/** A JSON Schema node as this module manipulates it while projecting to the harness. */
interface JsonSchemaNode {
  type?: string
  oneOf?: readonly JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: readonly string[]
  additionalProperties?: boolean | JsonSchemaNode
  items?: JsonSchemaNode
  enum?: readonly unknown[]
  const?: unknown
  description?: string
  [key: string]: unknown
}

/** Keywords the harness's tool-schema subset enforces; everything else is dropped. */
const HARNESS_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

/**
 * Project a canonical JSON Schema onto the subset the harness's tool registry enforces.
 *
 * The harness accepts `type/oneOf/properties/required/additionalProperties/items/enum/const`
 * plus annotations, and requires `additionalProperties` to be a **boolean**. Our schemas
 * are richer — a record's `additionalProperties` is a value schema, and bounds such as
 * `minLength` and `minimum` carry real meaning — so this projection drops or widens what
 * the harness cannot express.
 *
 * Nothing is lost that mattered: the emitted document is the *model-facing* description,
 * while authoritative validation of every argument happens in the dispatcher against the
 * original schema ([ADR-0011](../../../docs/adr/0011-mcp-control-plane.md)). The MCP and
 * HTTP surfaces keep the richer document.
 *
 * @param schema - A schema produced by the canonical validators.
 * @returns A structurally equivalent schema inside the harness's subset.
 */
export function toHarnessToolSchema(schema: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description') {
      out.description = String(value)
      continue
    }
    if (key === 'additionalProperties') {
      // A value schema cannot be expressed here; an open object preserves the meaning
      // "this map accepts entries", and the validator still checks each value.
      out.additionalProperties = typeof value === 'boolean' ? value : true
      continue
    }
    if (!HARNESS_KEYWORDS.has(key)) continue
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const properties: Record<string, JsonSchemaNode> = {}
      for (const [name, child] of Object.entries(value as Record<string, JsonSchemaNode>)) {
        properties[name] = toHarnessToolSchema(child)
      }
      out.properties = properties
      continue
    }
    if (key === 'items' && typeof value === 'object' && value !== null) {
      out.items = toHarnessToolSchema(value as JsonSchemaNode)
      continue
    }
    if (key === 'oneOf' && Array.isArray(value)) {
      out.oneOf = (value as JsonSchemaNode[]).map(branch => toHarnessToolSchema(branch))
      continue
    }
    out[key] = value
  }
  if (out.type === 'object' && typeof out.additionalProperties !== 'boolean') {
    out.additionalProperties = true
  }
  return out
}

/** Render a canonical value as bounded JSON for a model. */
function renderValue(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  const limit = 120_000
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… truncated at ${String(limit)} characters`
}
