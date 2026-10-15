/**
 * Git helpers for worktree isolation. Every command here is explicit, non-shell,
 * and classified on failure (ADR-0008, ADR-0014).
 *
 * @module @zorker/muti-agent-core/process/git
 */

import { isAbsolute, resolve } from 'node:path'
import { MutiAgentError, ErrorCodes } from '@zorker/muti-agent-contracts'
import type { ProcessRunner } from './runner.ts'

/** One entry of `git status --porcelain=v1 -z` output. */
export interface GitStatusEntry {
  /** Two-character status code, verbatim (`M `, `??`, `A `, `D `, …). */
  code: string
  /** Repository-relative path. */
  path: string
  /** Original path for a rename/copy. */
  from?: string
}

/** A parsed `git diff --numstat` row. */
export interface GitNumStat {
  path: string
  insertions: number
  deletions: number
  /** `true` for a binary file, where git reports `-` instead of counts. */
  binary: boolean
}

/** Result of a git command. */
export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | undefined
}

/** Git operations used by the worktree manager and the progress watcher. */
export class Git {
  /**
   * @param process - The managed process runner.
   * @param gitBinary - Git executable; resolved from PATH by default.
   * @param timeoutMs - Per-command budget.
   */
  constructor(
    private readonly process: ProcessRunner,
    private readonly gitBinary = 'git',
    private readonly timeoutMs = 60_000,
  ) {}

  /**
   * Run a git command in a directory.
   *
   * @param cwd - Directory to run in.
   * @param args - Git arguments, passed verbatim.
   * @param options - Extra environment and a caller signal.
   * @returns The raw result; non-zero exits are returned, not thrown.
   */
  async exec(
    cwd: string,
    args: readonly string[],
    options: { env?: Readonly<Record<string, string>>; signal?: AbortSignal } = {},
  ): Promise<GitResult> {
    const outcome = await this.process.run({
      command: this.gitBinary,
      args: [...args],
      cwd,
      envMode: 'minimal',
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: this.timeoutMs,
      captureBytes: 512 * 1024,
    })
    return {
      ok: outcome.code === 0,
      stdout: outcome.stdout.tail.trim() === '' ? outcome.stdout.head.trim() : outcome.stdout.tail.trim(),
      stderr: outcome.stderr.tail.trim(),
      code: outcome.code,
    }
  }

  /** Whether a directory is inside a git work tree. */
  async isRepository(path: string): Promise<boolean> {
    const result = await this.exec(path, ['rev-parse', '--is-inside-work-tree'])
    return result.ok && result.stdout === 'true'
  }

  /** The repository root containing a directory, or `undefined`. */
  async repoRoot(path: string): Promise<string | undefined> {
    const result = await this.exec(path, ['rev-parse', '--show-toplevel'])
    return result.ok && result.stdout !== '' ? result.stdout : undefined
  }

  /**
   * The git directory, which is where `info/exclude` lives (worktree-aware).
   *
   * `git rev-parse --git-dir` answers with a **relative** path (`.git`) when it is run
   * from the repository root, and a relative path is resolved against the *calling*
   * process's working directory — not the repository. Returning it unresolved once made
   * a write land in an unrelated repository's exclude file.
   *
   * @param path - Directory to inspect.
   * @returns An absolute git directory, or `undefined` when it cannot be determined.
   */
  async gitDir(path: string): Promise<string | undefined> {
    const result = await this.exec(path, ['rev-parse', '--absolute-git-dir'])
    if (result.ok && result.stdout !== '') return result.stdout
    const relative = await this.exec(path, ['rev-parse', '--git-dir'])
    if (!relative.ok || relative.stdout === '') return undefined
    return isAbsolute(relative.stdout) ? relative.stdout : resolve(path, relative.stdout)
  }

  /** Current branch name, or `undefined` on a detached HEAD. */
  async currentBranch(path: string): Promise<string | undefined> {
    const result = await this.exec(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!result.ok) return undefined
    return result.stdout === 'HEAD' ? undefined : result.stdout
  }

  /** Current commit sha. */
  async head(path: string): Promise<string | undefined> {
    const result = await this.exec(path, ['rev-parse', 'HEAD'])
    return result.ok ? result.stdout : undefined
  }

  /** Merge base between a ref and HEAD, when one exists. */
  async mergeBase(path: string, ref: string): Promise<string | undefined> {
    const result = await this.exec(path, ['merge-base', 'HEAD', ref])
    return result.ok ? result.stdout : undefined
  }

  /** The repository's default branch ref, trying the usual candidates. */
  async defaultRef(path: string): Promise<string | undefined> {
    const symbolic = await this.exec(path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    if (symbolic.ok && symbolic.stdout !== '') return symbolic.stdout.replace('refs/remotes/', '')
    for (const candidate of ['main', 'master', 'trunk', 'develop']) {
      const probe = await this.exec(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`])
      if (probe.ok && probe.stdout !== '') return candidate
    }
    return undefined
  }

  /** Whether a ref exists. */
  async hasRef(path: string, ref: string): Promise<boolean> {
    const result = await this.exec(path, ['rev-parse', '--verify', '--quiet', ref])
    return result.ok && result.stdout !== ''
  }

  /** Whether a branch name is already taken. */
  async hasBranch(path: string, branch: string): Promise<boolean> {
    return this.hasRef(path, `refs/heads/${branch}`)
  }

  /**
   * Create a worktree.
   *
   * @param repoRoot - Repository to branch from.
   * @param worktreePath - Absolute destination path.
   * @param branch - New branch name to create and check out.
   * @param baseRef - Commit-ish to branch from; omitted for the current HEAD.
   * @returns The created worktree's resolved path.
   * @throws {MutiAgentError} `worktree/create-failed` with git's own message.
   */
  async addWorktree(
    repoRoot: string,
    worktreePath: string,
    branch: string,
    baseRef?: string,
  ): Promise<void> {
    const args = ['worktree', 'add', '-b', branch, worktreePath]
    if (baseRef !== undefined) args.push(baseRef)
    const result = await this.exec(repoRoot, args)
    if (!result.ok) {
      throw new MutiAgentError(
        ErrorCodes.worktreeCreateFailed,
        `git worktree add failed for ${branch}`,
        {
          details: { repoRoot, worktreePath, branch },
          remediation: 'Check that the branch name is free and the destination path does not exist.',
          cause: result.stderr,
        },
      )
    }
  }

  /**
   * Remove a worktree.
   *
   * @param repoRoot - Repository owning the worktree.
   * @param worktreePath - Worktree to remove.
   * @param force - Required when the worktree has uncommitted or unmerged work.
   */
  async removeWorktree(repoRoot: string, worktreePath: string, force = false): Promise<GitResult> {
    const args = ['worktree', 'remove']
    if (force) args.push('--force')
    args.push(worktreePath)
    return this.exec(repoRoot, args, { env: { GIT_OPTIONAL_LOCKS: '0' } })
  }

  /** Prune stale worktree administrative entries. */
  async pruneWorktrees(repoRoot: string): Promise<void> {
    await this.exec(repoRoot, ['worktree', 'prune'])
  }

  /** Parse `git worktree list --porcelain` into path/branch/base records. */
  async listWorktrees(repoRoot: string): Promise<readonly { path: string; branch?: string; head?: string }[]> {
    const result = await this.exec(repoRoot, ['worktree', 'list', '--porcelain'])
    if (!result.ok) return []
    const out: { path: string; branch?: string; head?: string }[] = []
    let current: { path: string; branch?: string; head?: string } | undefined
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current !== undefined) out.push(current)
        current = { path: line.slice('worktree '.length) }
      } else if (line.startsWith('HEAD ') && current !== undefined) {
        current.head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ') && current !== undefined) {
        current.branch = line.slice('branch '.length).replace('refs/heads/', '')
      }
    }
    if (current !== undefined) out.push(current)
    return out
  }

  /** Working-tree status as structured entries. */
  async status(path: string): Promise<readonly GitStatusEntry[]> {
    const result = await this.exec(path, ['status', '--porcelain=v1', '--untracked-files=all'], {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    })
    if (!result.ok) return []
    const entries: GitStatusEntry[] = []
    for (const line of result.stdout.split('\n')) {
      if (line.length < 4) continue
      const code = line.slice(0, 2)
      const rest = line.slice(3)
      const arrow = rest.indexOf(' -> ')
      if (arrow === -1) entries.push({ code, path: rest })
      else entries.push({ code, path: rest.slice(arrow + 4), from: rest.slice(0, arrow) })
    }
    return entries
  }

  /**
   * Per-file change counts.
   *
   * @param path - Directory to run in.
   * @param args - Diff arguments, e.g. `['<base>...HEAD']` or `['HEAD']`.
   * @returns Parsed rows; binary files carry `binary: true` and zero counts.
   */
  async numstat(path: string, args: readonly string[]): Promise<readonly GitNumStat[]> {
    const result = await this.exec(path, ['diff', '--numstat', '--no-color', ...args], {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    })
    if (!result.ok) return []
    const rows: GitNumStat[] = []
    for (const line of result.stdout.split('\n')) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const [insertions, deletions, file] = parts
      if (insertions === undefined || deletions === undefined || file === undefined) continue
      const binary = insertions === '-' || deletions === '-'
      rows.push({
        path: file,
        insertions: binary ? 0 : Number.parseInt(insertions, 10),
        deletions: binary ? 0 : Number.parseInt(deletions, 10),
        binary,
      })
    }
    return rows
  }

  /**
   * Hunk start positions and lengths of a unified diff, keyed by file.
   *
   * Used for the same-hunk conflict heuristic: two worktrees touching overlapping
   * line ranges in the same file are far more likely to conflict than two touching
   * the same file at unrelated offsets.
   *
   * @param path - Directory to run in.
   * @param args - Diff arguments.
   * @returns File path → hunk ranges, in diff order.
   */
  async hunks(path: string, args: readonly string[]): Promise<ReadonlyMap<string, readonly { start: number; lines: number }[]>> {
    const result = await this.exec(path, ['diff', '--no-color', '--unified=0', ...args], {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    })
    const out = new Map<string, { start: number; lines: number }[]>()
    if (!result.ok) return out
    let current: string | undefined
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('+++ b/')) {
        current = line.slice('+++ b/'.length)
        if (!out.has(current)) out.set(current, [])
        continue
      }
      if (line.startsWith('+++ /dev/null')) {
        current = undefined
        continue
      }
      if (current === undefined) continue
      const match = hunk.exec(line)
      if (match === null) continue
      const start = Number.parseInt(match[1] ?? '0', 10)
      const lines = match[2] === undefined ? 1 : Number.parseInt(match[2], 10)
      out.get(current)?.push({ start, lines })
    }
    return out
  }

  /** Commits HEAD is ahead of a base ref. */
  async aheadBehind(path: string, base: string): Promise<{ ahead: number; behind: number } | undefined> {
    const result = await this.exec(path, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
    if (!result.ok) return undefined
    const [behind, ahead] = result.stdout.split(/\s+/)
    if (behind === undefined || ahead === undefined) return undefined
    return { behind: Number.parseInt(behind, 10), ahead: Number.parseInt(ahead, 10) }
  }

  /**
   * Add a pattern to the repository's local exclude file, never to a tracked file.
   *
   * @param gitDir - The git directory from {@link gitDir}.
   * @param pattern - Pattern to ensure present.
   */
  async ensureExcluded(gitDir: string, pattern: string): Promise<void> {
    const { appendFile, mkdir, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const infoDir = join(gitDir, 'info')
    const excludePath = join(infoDir, 'exclude')
    try {
      await mkdir(infoDir, { recursive: true })
      let existing = ''
      try {
        existing = await readFile(excludePath, 'utf8')
      } catch {
        existing = ''
      }
      if (existing.split('\n').some(line => line.trim() === pattern)) return
      const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
      await appendFile(excludePath, `${prefix}# muti-agent worktrees\n${pattern}\n`, 'utf8')
    } catch {
      // Failing to exclude is cosmetic: the worktree root is still usable, and the
      // canonical path is reported to the user so a dirty status stays explainable.
    }
  }

  /** Whether a merge is in progress (used to refuse integration in a dirty state). */
  async isMerging(path: string): Promise<boolean> {
    const gitDir = await this.gitDir(path)
    if (gitDir === undefined) return false
    const { join } = await import('node:path')
    const { access } = await import('node:fs/promises')
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD']) {
      try {
        await access(join(gitDir, marker))
        return true
      } catch {
        // Marker absent: keep checking.
      }
    }
    return false
  }
}
