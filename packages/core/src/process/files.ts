/**
 * Filesystem probing for foreign stores: everything here tolerates a file that
 * another process is writing right now, and never mutates anything (ADR-0012).
 *
 * @module @zorker/muti-agent-core/process/files
 */

import { createReadStream } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { basename, isAbsolute, join, resolve } from 'node:path'

/** Cheap identity of a file's current content generation. */
export interface FileFingerprint {
  /** Size in bytes, or `-1` when the file is absent. */
  size: number
  /** Modification time in milliseconds, or `0` when absent. */
  mtimeMs: number
  /** Inode number on platforms that report one. */
  ino: number
}

/** One directory entry, without following symlinks. */
export interface DirEntryInfo {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  size: number
  mtimeMs: number
}

/** Read-only filesystem helpers handed to adapters. */
export class FileProbe {
  /**
   * @param maxReadBytes - Hard cap for any single read, bounding memory.
   */
  constructor(private readonly maxReadBytes = 8 * 1024 * 1024) {}

  /** Expand a leading `~` and resolve relative to `base`. */
  resolvePath(path: string, base = process.cwd()): string {
    if (path === '~') return homedir()
    if (path.startsWith('~/')) return join(homedir(), path.slice(2))
    return isAbsolute(path) ? path : resolve(base, path)
  }

  /** Whether a path exists and is a regular file. */
  async isFile(path: string): Promise<boolean> {
    try {
      const handle = await openFile(path, 'r')
      try {
        const stat = await handle.stat()
        return stat.isFile()
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }
  }

  /** Whether a path exists and is a directory. */
  async isDirectory(path: string): Promise<boolean> {
    try {
      const handle = await openFile(path, 'r')
      try {
        const stat = await handle.stat()
        return stat.isDirectory()
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }
  }

  /** Fingerprint a file, or return the "absent" fingerprint. */
  async fingerprint(path: string): Promise<FileFingerprint> {
    try {
      const handle = await openFile(path, 'r')
      try {
        const stat = await handle.stat()
        return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }
      } finally {
        await handle.close()
      }
    } catch {
      return { size: -1, mtimeMs: 0, ino: 0 }
    }
  }

  /**
   * Read up to `maxBytes` from the head of a file.
   *
   * @param path - Absolute path.
   * @param maxBytes - Cap; defaults to this probe's configured cap.
   * @returns The decoded text and whether the file was longer than the cap.
   */
  async readHead(path: string, maxBytes?: number): Promise<{ text: string; truncated: boolean; missing: boolean }> {
    const cap = Math.max(1, Math.min(maxBytes ?? this.maxReadBytes, this.maxReadBytes))
    try {
      const handle = await openFile(path, 'r')
      try {
        const stat = await handle.stat()
        const length = Math.min(stat.size, cap)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, 0)
        return { text: buffer.toString('utf8'), truncated: stat.size > length, missing: false }
      } finally {
        await handle.close()
      }
    } catch {
      return { text: '', truncated: false, missing: true }
    }
  }

  /**
   * Read the last `maxBytes` of a file, dropping a leading partial line when one
   * is present so the result starts on a record boundary.
   *
   * @param path - Absolute path.
   * @param maxBytes - Cap on bytes read.
   * @returns The decoded text, whether earlier content exists, and whether the
   *   file was absent, and whether the first line was dropped as partial.
   */
  async readTail(
    path: string,
    maxBytes = 512 * 1024,
  ): Promise<{ text: string; truncated: boolean; droppedPartialLine: boolean; missing: boolean }> {
    const cap = Math.max(1, Math.min(maxBytes, this.maxReadBytes))
    try {
      const handle = await openFile(path, 'r')
      try {
        const stat = await handle.stat()
        const length = Math.min(stat.size, cap)
        const start = stat.size - length
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, start)
        let text = buffer.toString('utf8')
        let droppedPartialLine = false
        if (start > 0) {
          const firstNewline = text.indexOf('\n')
          if (firstNewline === -1) {
            // The cap is smaller than one line; nothing usable is present.
            return { text: '', truncated: true, droppedPartialLine: true, missing: false }
          }
          text = text.slice(firstNewline + 1)
          droppedPartialLine = true
        }
        return { text, truncated: start > 0, droppedPartialLine, missing: false }
      } finally {
        await handle.close()
      }
    } catch {
      return { text: '', truncated: false, droppedPartialLine: false, missing: true }
    }
  }

  /**
   * Parse a JSON file, tolerating absence and corruption.
   *
   * @param path - Absolute path.
   * @returns The parsed value, or an error describing why it is unavailable.
   */
  async readJson<T>(path: string): Promise<{ ok: true; value: T } | { ok: false; error: string; missing: boolean }> {
    const { text, missing } = await this.readHead(path)
    if (missing) return { ok: false, error: 'file not found', missing: true }
    try {
      return { ok: true, value: JSON.parse(text) as T }
    } catch (cause) {
      return {
        ok: false,
        missing: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }

  /**
   * Read a JSONL/NDJSON file line by line without loading it into memory.
   *
   * A malformed line is reported through {@link onError} and skipped, because a
   * file written by another process can legitimately end mid-record.
   *
   * @param path - Absolute path.
   * @param onLine - Called once per complete non-empty line, with its 1-based number.
   * @param options - Byte cap and per-line parse error hook.
   */
  async readJsonLines(
    path: string,
    onLine: (value: unknown, lineNumber: number, raw: string) => void,
    options: { maxBytes?: number; onError?: (error: string, lineNumber: number) => void } = {},
  ): Promise<{ lines: number; bytes: number; missing: boolean }> {
    const cap = options.maxBytes ?? Number.POSITIVE_INFINITY
    let bytes = 0
    let lines = 0
    try {
      const stream = createReadStream(path, { encoding: 'utf8' })
      const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
      try {
        for await (const raw of reader) {
          bytes += Buffer.byteLength(raw, 'utf8') + 1
          lines += 1
          if (raw.trim() === '') continue
          if (bytes > cap) break
          try {
            onLine(JSON.parse(raw) as unknown, lines, raw)
          } catch (cause) {
            options.onError?.(cause instanceof Error ? cause.message : String(cause), lines)
          }
        }
      } finally {
        reader.close()
        stream.destroy()
      }
      return { lines, bytes, missing: false }
    } catch {
      return { lines, bytes, missing: true }
    }
  }

  /**
   * List one directory level, sorted by modification time, newest first.
   *
   * @param path - Absolute directory path.
   * @returns Entries, or an empty array when the directory is absent.
   */
  async listDir(path: string): Promise<readonly DirEntryInfo[]> {
    const { readdir, stat } = await import('node:fs/promises')
    let names: string[]
    try {
      names = await readdir(path)
    } catch {
      return []
    }
    const entries: DirEntryInfo[] = []
    for (const name of names) {
      const full = join(path, name)
      try {
        const info = await stat(full)
        entries.push({
          name,
          path: full,
          isDirectory: info.isDirectory(),
          isFile: info.isFile(),
          size: info.size,
          mtimeMs: info.mtimeMs,
        })
      } catch {
        // A racing delete or a broken symlink: not an entry we can use.
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return entries
  }

  /**
   * Recursively collect files whose name matches a predicate, depth-first with a
   * bounded visit count so a pathological tree cannot hang a scan.
   *
   * @param root - Directory to walk.
   * @param matches - Predicate on the file name.
   * @param options - Maximum depth and maximum files to collect.
   * @returns Matching entries, newest first.
   */
  async findFiles(
    root: string,
    matches: (name: string) => boolean,
    options: { maxDepth?: number; maxFiles?: number } = {},
  ): Promise<readonly DirEntryInfo[]> {
    const maxDepth = options.maxDepth ?? 6
    const maxFiles = options.maxFiles ?? 5_000
    const found: DirEntryInfo[] = []
    const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) break
      const entries = await this.listDir(next.path)
      for (const entry of entries) {
        if (entry.isFile && matches(entry.name)) found.push(entry)
        else if (entry.isDirectory && next.depth < maxDepth) {
          queue.push({ path: entry.path, depth: next.depth + 1 })
        }
      }
      if (found.length >= maxFiles) break
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return found.slice(0, maxFiles)
  }

  /** The file name portion of a path, for display. */
  baseName(path: string): string {
    return basename(path)
  }
}
