/**
 * Schema and wire version constants. Both are compatibility surfaces: changing
 * either requires a migration note in `docs/reference/schema.md` and a bump that
 * consumers can detect before interpreting data (ADR-0002).
 *
 * @module @zorker/muti-agent-contracts/version
 */

/**
 * Canonical schema version. Bumped when an existing field changes meaning or a
 * required field is added; additive optional fields do not bump it.
 */
export const SCHEMA_VERSION = 1

/** Version of the HTTP/MCP method envelope. */
export const WIRE_VERSION = 1

/** Plugin version, mirrored from the installable package manifest. */
export const PLUGIN_VERSION = '0.1.0'

/** The dotted method-name pattern every operation id and wire method must match. */
export const METHOD_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** Whether a dotted identifier is a well-formed operation/method name. */
export function isMethodName(value: string): boolean {
  return METHOD_PATTERN.test(value)
}
