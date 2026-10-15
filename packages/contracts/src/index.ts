/**
 * The canonical multi-agent schema shared by every MutiAgent layer: the adapter
 * SPI, the domain services, the tool catalog, the HTTP wire and the browser UI.
 *
 * Nothing in this package may import another package or a runtime dependency; it
 * is the one module both build faces (Node host bundle, browser client bundle)
 * share verbatim (ADR-0006).
 *
 * @module @zorker/muti-agent-contracts
 */

export * from './ids.ts'
export * from './agent.ts'
export * from './session.ts'
export * from './run.ts'
export * from './models.ts'
export * from './capabilities-inventory.ts'
export * from './mesh.ts'
export * from './errors.ts'
export * from './version.ts'
export * from './validate.ts'
export * from './capabilities.ts'
export * from './schemas.ts'
