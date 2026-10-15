/**
 * MutiAgent's own durable state. Everything MutiAgent persists lives under one
 * directory, so a user can inspect, back up or delete it without hunting for
 * scattered files, and so the plugin can never write into another product's or
 * the harness's storage (ADR-0012).
 *
 * Layout under `<root>`:
 * ```
 * state.json            small hot record (settings-independent, atomic writes)
 * index/<agent>.json    bounded session projection cache, one file per agent
 * collaborations/<id>.json
 * runs/<runId>.json     redacted run records
 * worktrees.json        MeshWorkspace records
 * journal.jsonl         append-only record of every mutation, for forensics
 * ```
 *
 * Writes are atomic (write-temp-then-rename) and serialized per path, so a crash
 * leaves either the previous or the next complete document, never a torn one.
 *
 * @module @zorker/muti-agent-core/state/store
 */

import { mkdir, readFile, rename, writeFile, appendFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from '../adapter/types.ts'

/** A JSON-serializable value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** One journal line: what changed, when, by whom. */
export interface JournalEntry {
  at: string
  kind: string
  id?: string
  actor?: string
  detail?: JsonValue
}

/** Filesystem-backed state with atomic writes and a per-path write chain. */
export class StateStore {
  private readonly chains = new Map<string, Promise<void>>()
  private journalChain: Promise<void> = Promise.resolve()

  /**
   * @param root - Absolute directory MutiAgent owns; created on first write.
   * @param log - Logger for state diagnostics.
   */
  constructor(
    readonly root: string,
    private readonly log: Logger,
  ) {}

  /** Absolute path of a file inside the state root. */
  path(...segments: readonly string[]): string {
    return join(this.root, ...segments)
  }

  /**
   * Read and parse a JSON document.
   *
   * @param relative - Path relative to the state root.
   * @returns The parsed value, or `undefined` when absent or unparsable; a parse
   *   failure is logged because it means state was corrupted, not merely absent.
   */
  async readJson<T>(relative: string): Promise<T | undefined> {
    try {
      const text = await readFile(this.path(relative), 'utf8')
      return JSON.parse(text) as T
    } catch (cause) {
      if (isNotFound(cause)) return undefined
      this.log.warn(`state document ${relative} could not be read`, {
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return undefined
    }
  }

  /**
   * Atomically replace a JSON document.
   *
   * @param relative - Path relative to the state root.
   * @param value - Value to serialize.
   */
  async writeJson(relative: string, value: unknown): Promise<void> {
    await this.serialize(relative, async () => {
      const target = this.path(relative)
      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await rename(temp, target)
    })
  }

  /**
   * Read, transform and write a document under one lock, so two concurrent
   * mutations cannot lose each other's work.
   *
   * @param relative - Path relative to the state root.
   * @param initial - Value used when the document does not exist yet.
   * @param mutate - Pure transform; return the value to persist.
   * @returns The persisted value.
   */
  async updateJson<T>(relative: string, initial: T, mutate: (current: T) => T): Promise<T> {
    let result: T = initial
    await this.serialize(relative, async () => {
      const current = (await this.readJson<T>(relative)) ?? initial
      result = mutate(current)
      const target = this.path(relative)
      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`
      await writeFile(temp, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      await rename(temp, target)
    })
    return result
  }

  /** Delete a document, ignoring absence. */
  async remove(relative: string): Promise<void> {
    await this.serialize(relative, async () => {
      try {
        await unlink(this.path(relative))
      } catch (cause) {
        if (!isNotFound(cause)) throw cause
      }
    })
  }

  /**
   * Append one journal record. Never throws: a failed journal write must not fail
   * the operation it describes.
   *
   * @param entry - What changed.
   */
  appendJournal(entry: JournalEntry): void {
    const line = `${JSON.stringify(entry)}\n`
    this.journalChain = this.journalChain
      .then(async () => {
        const target = this.path('journal.jsonl')
        await mkdir(dirname(target), { recursive: true })
        await appendFile(target, line, 'utf8')
      })
      .catch((cause: unknown) => {
        this.log.warn('journal append failed', {
          error: cause instanceof Error ? cause.message : String(cause),
        })
      })
  }

  /** Read the tail of the journal, newest last. */
  async readJournal(limit = 200): Promise<readonly JournalEntry[]> {
    try {
      const text = await readFile(this.path('journal.jsonl'), 'utf8')
      const lines = text.split('\n').filter(line => line.trim() !== '')
      const tail = lines.slice(Math.max(0, lines.length - limit))
      const out: JournalEntry[] = []
      for (const line of tail) {
        try {
          out.push(JSON.parse(line) as JournalEntry)
        } catch {
          // A torn final line from a crash is skipped rather than failing the read.
        }
      }
      return out
    } catch {
      return []
    }
  }

  /** Ensure the root exists. */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  /**
   * Run a mutation under this path's chain. Serialization is per path, so
   * unrelated documents never contend.
   */
  private async serialize(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.chains.set(key, next.catch(() => undefined))
    try {
      await next
    } finally {
      if (this.chains.get(key) === next || (await this.isSettled(key, next))) this.chains.delete(key)
    }
  }

  private async isSettled(key: string, candidate: Promise<void>): Promise<boolean> {
    const current = this.chains.get(key)
    if (current === undefined) return true
    // A later mutation replaced the chain head; leave it in place.
    return current === candidate
  }
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Resolve MutiAgent's state root.
 *
 * @param options - Explicit override (from plugin settings), and the harness home.
 * @returns The absolute state directory, preferring the explicit override.
 */
export function resolveStateRoot(options: { override?: string; harnessHome?: string; cwd?: string } = {}): string {
  if (options.override !== undefined && options.override !== '') return options.override
  const home = options.harnessHome
  if (home !== undefined && home !== '') return join(home, 'mutiagent')
  const envHome = process.env.HOME ?? process.env.USERPROFILE ?? options.cwd ?? '.'
  return join(envHome, '.muti-agent')
}
