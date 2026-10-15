/**
 * MutiAgent domain core: the canonical schema's first runtime layer. Adapters
 * implement the SPI in `./adapter/types.ts`; every service here uses only that SPI,
 * so a new agent needs no service changes (ADR-0002).
 *
 * @module @zorker/muti-agent-core
 */

export * from './log.ts'
export * from './adapter/types.ts'
export * from './adapter/registry.ts'
export * from './process/runner.ts'
export * from './process/files.ts'
export * from './process/lines.ts'
export * from './process/git.ts'
export * from './discovery/detect.ts'
export * from './state/store.ts'
export * from './sessions/index.ts'
export * from './worktree/manager.ts'
export * from './orchestration/collaboration.ts'
export * from './orchestration/runs.ts'
export * from './credentials/service.ts'
export * from './service.ts'
