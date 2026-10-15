/**
 * Worktree isolation and progress follow-up. MutiAgent owns the worktree lifecycle
 * for every delegated run so all agents behave identically, and samples each active
 * worktree so conflicts are visible while agents are still working (ADR-0008).
 *
 * @module @zorker/muti-agent-core/worktree/manager
 */

import { join } from 'node:path'
import {
  ErrorCodes,
  MutiAgentError,
  worktreeId as brandWorktree,
  type ConflictFinding,
  type ConflictReport,
  type ConflictSeverity,
  type FileChangeStat,
  type MeshWorkspace,
  type WorktreeProgress,
} from '@zorker/muti-agent-contracts'
import type { Logger } from '../adapter/types.ts'
import type { Git } from '../process/git.ts'
import type { StateStore } from '../state/store.ts'

/** The directory MutiAgent keeps its worktrees under, inside the repository. */
export const WORKTREE_DIR_NAME = '.mutiagent'

/** Policy for what to do when two worktrees are predicted to conflict. */
export type ConflictPolicy = 'report' | 'block'

/** Settings for the worktree manager. */
export interface WorktreeOptions {
  /** Where worktrees are created: inside the repo, or under the state root. */
  location: 'in-repo' | 'state-root'
  /** Absolute root used when `location` is `state-root`. */
  stateRoot: string
  /** Base ref to branch from when a request does not name one. */
  baseRef?: string
  /** How strictly conflicts are treated. */
  conflictPolicy: ConflictPolicy
  /**
   * Module boundaries used for the functional-conflict heuristic: two worktrees that
   * touch different files inside the same boundary are reported as related.
   */
  featureBoundaries: readonly string[]
  /** Merge/rebase an idle worktree automatically at the end of a run. */
  autoIntegrate: boolean
}

/** Persisted worktree records. */
interface WorktreeDocument {
  version: 1
  worktrees: Record<string, MeshWorkspace>
}

const WORKTREE_PATH = 'worktrees.json'

/** Allocation request for one worktree. */
export interface AllocateRequest {
  agentId: string
  repoRoot: string
  baseRef?: string
  label?: string
  runId?: string
  collaborationId?: string
  reuse?: boolean
}

/**
 * Creates, samples and integrates git worktrees.
 *
 * Ownership rule: a worktree recorded here may be removed by MutiAgent; a worktree
 * that exists on disk without a record is reported as `orphan` and never reused or
 * deleted (ADR-0008).
 */
export class WorktreeManager {
  /**
   * @param git - Git command helper.
   * @param state - MutiAgent's state store.
   * @param options - Isolation policy settings.
   * @param log - Logger.
   */
  constructor(
    private readonly git: Git,
    private readonly state: StateStore,
    private readonly options: WorktreeOptions,
    private readonly log: Logger,
  ) {}

  /** Whether git is usable at all on this machine. */
  async available(): Promise<boolean> {
    const probe = await this.git.exec(process.cwd(), ['--version'])
    return probe.ok
  }

  /**
   * Create (or reuse) a worktree for one run.
   *
   * @param request - Agent, repository, base ref, and labels.
   * @returns The worktree record, already registered.
   * @throws {MutiAgentError} `worktree/not-a-repository` when the path is not a repo,
   *   `worktree/create-failed` when git refuses.
   */
  async allocate(request: AllocateRequest): Promise<MeshWorkspace> {
    if (!(await this.available())) {
      throw new MutiAgentError(ErrorCodes.worktreeGitUnavailable, 'git is not available on this machine', {
        remediation: 'Install git, or configure isolation to shared-cwd.',
      })
    }
    const repoRoot = await canonicalRepoRoot(this.git, request.repoRoot)
    if (repoRoot === undefined) {
      throw new MutiAgentError(
        ErrorCodes.worktreeNotARepository,
        `${request.repoRoot} is not inside a git work tree`,
        {
          details: { path: request.repoRoot },
          remediation: 'Initialize a repository, or run with isolation=shared-cwd.',
        },
      )
    }

    if (request.reuse === true) {
      const reusable = await this.reusableFor(request.agentId, repoRoot)
      if (reusable !== undefined) return reusable
    }

    const baseRef = request.baseRef ?? this.options.baseRef ?? (await this.git.defaultRef(repoRoot))
    const baseCommit = baseRef === undefined
      ? await this.git.head(repoRoot)
      : await this.git.head(repoRoot) ?? (await this.git.mergeBase(repoRoot, baseRef))
    if (baseCommit === undefined) {
      throw new MutiAgentError(ErrorCodes.worktreeCreateFailed, `could not resolve a base commit in ${repoRoot}`, {
        details: { repoRoot },
        remediation: 'Make at least one commit, then retry.',
      })
    }

    const id = brandWorktree(`wt-${randomToken()}`)
    const slug = slugify(request.label ?? request.agentId)
    const branch = await this.uniqueBranch(repoRoot, `mutiagent/${slug}`)
    const directory = this.worktreePath(repoRoot, request.agentId, id, slug)

    await this.git.addWorktree(repoRoot, directory, branch, baseRef)
    const gitDir = await this.git.gitDir(repoRoot)
    if (gitDir !== undefined) await this.git.ensureExcluded(gitDir, `${WORKTREE_DIR_NAME}/`)

    const record: MeshWorkspace = {
      id,
      path: directory,
      repoRoot,
      branch,
      baseCommit,
      baseRef: baseRef ?? 'HEAD',
      agentId: request.agentId as MeshWorkspace['agentId'],
      createdAt: new Date().toISOString(),
      state: 'active',
      reusable: true,
      ...(request.runId === undefined ? {} : { runId: request.runId as NonNullable<MeshWorkspace['runId']> }),
      ...(request.collaborationId === undefined
        ? {}
        : {
            collaborationId: request.collaborationId as NonNullable<MeshWorkspace['collaborationId']>,
          }),
    }
    await this.save(record)
    this.state.appendJournal({
      at: record.createdAt,
      kind: 'worktree.created',
      id: String(id),
      detail: { path: directory, branch, repoRoot, agentId: request.agentId },
    })
    return record
  }

  /** Absolute directory for a new worktree. */
  private worktreePath(repoRoot: string, agentId: string, id: string, slug: string): string {
    const short = String(id).replace(/^wt-/, '').slice(0, 8)
    if (this.options.location === 'state-root') {
      return join(this.options.stateRoot, 'worktrees', slug, short)
    }
    return join(repoRoot, WORKTREE_DIR_NAME, 'worktrees', agentId, `${slug}-${short}`)
  }

  /**
   * An idle, unmodified worktree for an agent that a new run may reuse.
   *
   * Reuse is safe only when the tree is clean, already merged or untouched: reusing a
   * worktree with uncommitted work would merge two agents' changes by accident.
   */
  private async reusableFor(agentId: string, repoRoot: string): Promise<MeshWorkspace | undefined> {
    const all = await this.list()
    for (const record of all) {
      if (String(record.agentId) !== agentId) continue
      if (record.repoRoot !== repoRoot) continue
      if (!record.reusable) continue
      if (record.runId !== undefined) continue
      if (record.state !== 'idle' && record.state !== 'active') continue
      const status = await this.git.status(record.path)
      if (status.length === 0) return record
    }
    return undefined
  }

  /** Ensure a branch name is free, suffixing a counter when it is taken. */
  private async uniqueBranch(repoRoot: string, base: string): Promise<string> {
    if (!(await this.git.hasBranch(repoRoot, base))) return base
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base}-${String(index)}`
      if (!(await this.git.hasBranch(repoRoot, candidate))) return candidate
    }
    return `${base}-${randomToken().slice(0, 6)}`
  }

  /** Every recorded worktree. */
  async list(): Promise<readonly MeshWorkspace[]> {
    const document = await this.state.readJson<WorktreeDocument>(WORKTREE_PATH)
    return Object.values(document?.worktrees ?? {})
  }

  /**
   * Every worktree belonging to one repository.
   *
   * Canonicalizes the query the same way allocation does, so a caller that spells a
   * repository path differently from the way it was created still finds its worktrees.
   *
   * @param repoRoot - A directory inside, or at the root of, the repository.
   * @returns Matching records, newest first.
   */
  async listForRepo(repoRoot: string): Promise<readonly MeshWorkspace[]> {
    const canonical = await canonicalRepoRoot(this.git, repoRoot)
    const records = await this.list()
    return records.filter(record => record.repoRoot === canonical)
  }

  /** One worktree by id. */
  async get(id: string): Promise<MeshWorkspace | undefined> {
    const document = await this.state.readJson<WorktreeDocument>(WORKTREE_PATH)
    return document?.worktrees[id]
  }

  /** Persist one record, replacing any previous record with the same id. */
  private async save(record: MeshWorkspace): Promise<void> {
    await this.state.updateJson<WorktreeDocument>(WORKTREE_PATH, { version: 1, worktrees: {} }, current => ({
      version: 1,
      worktrees: { ...current.worktrees, [String(record.id)]: record },
    }))
  }

  /**
   * Take one progress sample and store it on the record.
   *
   * @param id - Worktree id.
   * @param agentAlive - Whether the owning agent process is still running.
   * @returns The sample, or `undefined` when the worktree is unknown or unreadable.
   */
  async sample(id: string, agentAlive = false): Promise<WorktreeProgress | undefined> {
    const record = await this.get(id)
    if (record === undefined) return undefined
    const progress = await this.samplePath(record, agentAlive)
    await this.save({
      ...record,
      progress,
      state: record.state === 'removed' || record.state === 'merged' ? record.state : agentAlive ? 'active' : 'idle',
    })
    return progress
  }

  /** Sample every recorded, still-present worktree. */
  async sampleAll(aliveRunIds: readonly string[] = []): Promise<readonly MeshWorkspace[]> {
    const records = await this.list()
    const out: MeshWorkspace[] = []
    for (const record of records) {
      if (record.state === 'removed' || record.state === 'merged') {
        out.push(record)
        continue
      }
      const alive = record.runId !== undefined && aliveRunIds.includes(String(record.runId))
      const progress = await this.samplePath(record, alive)
      const updated: MeshWorkspace = {
        ...record,
        progress,
        state: alive ? 'active' : 'idle',
      }
      await this.save(updated)
      out.push(updated)
    }
    return out
  }

  /** Build one progress sample for a worktree path. */
  private async samplePath(record: MeshWorkspace, agentAlive: boolean): Promise<WorktreeProgress> {
    const notes: string[] = []
    const head = (await this.git.head(record.path)) ?? record.baseCommit
    const branch = (await this.git.currentBranch(record.path)) ?? record.branch
    const aheadBehind = await this.git.aheadBehind(record.path, record.baseCommit)
    const status = await this.git.status(record.path)
    const committed = await this.git.numstat(record.path, [`${record.baseCommit}...HEAD`])
    const working = await this.git.numstat(record.path, ['HEAD'])
    const hunkMap = await this.git.hunks(record.path, [`${record.baseCommit}...HEAD`])

    const files = new Map<string, FileChangeStat>()
    for (const row of committed) {
      files.set(row.path, {
        path: row.path,
        insertions: row.insertions,
        deletions: row.deletions,
        status: 'modified',
      })
    }
    for (const row of working) {
      const existing = files.get(row.path)
      if (existing === undefined) {
        files.set(row.path, {
          path: row.path,
          insertions: row.insertions,
          deletions: row.deletions,
          status: 'modified',
        })
      } else {
        files.set(row.path, {
          ...existing,
          insertions: existing.insertions + row.insertions,
          deletions: existing.deletions + row.deletions,
        })
      }
    }
    for (const entry of status) {
      const kind = statusKind(entry.code)
      const existing = files.get(entry.path)
      const finalPath = entry.path
      if (existing === undefined) {
        files.set(finalPath, { path: finalPath, insertions: 0, deletions: 0, status: kind })
      } else if (kind !== 'modified') {
        files.set(finalPath, { ...existing, status: kind })
      }
    }
    for (const [path, hunks] of hunkMap) {
      const existing = files.get(path)
      if (existing !== undefined && hunks.length > 0) files.set(path, { ...existing, hunks })
    }
    if (hunkMap.size === 0 && files.size > 0) {
      notes.push('hunk ranges are unavailable for this repository state')
    }

    const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
    const totals = list.reduce(
      (accumulator, file) => ({
        insertions: accumulator.insertions + file.insertions,
        deletions: accumulator.deletions + file.deletions,
        files: accumulator.files + 1,
      }),
      { insertions: 0, deletions: 0, files: 0 },
    )

    return {
      at: new Date().toISOString(),
      head,
      branch,
      ahead: aheadBehind?.ahead ?? 0,
      ...(aheadBehind === undefined ? {} : { behind: aheadBehind.behind }),
      files: list,
      totals,
      agentAlive,
      dirty: status.length > 0,
      notes,
    }
  }

  /**
   * Compare every active worktree in one repository and report conflicts.
   *
   * @param repoRoot - Repository to analyse.
   * @returns Findings, a suggested integration order, and declared gaps.
   */
  async conflicts(repoRoot: string): Promise<ConflictReport> {
    const notes: string[] = []
    const canonical = await canonicalRepoRoot(this.git, repoRoot)
    const records = (await this.list()).filter(
      record => record.repoRoot === canonical && record.state !== 'removed',
    )
    const withProgress: MeshWorkspace[] = []
    for (const record of records) {
      if (record.progress !== undefined) {
        withProgress.push(record)
        continue
      }
      const progress = await this.samplePath(record, false)
      withProgress.push({ ...record, progress })
    }

    const findings: ConflictFinding[] = []
    for (let left = 0; left < withProgress.length; left += 1) {
      for (let right = left + 1; right < withProgress.length; right += 1) {
        const a = withProgress[left]
        const b = withProgress[right]
        if (a === undefined || b === undefined) continue
        findings.push(...this.comparePair(a, b))
      }
    }
    findings.sort((x, y) => severityRank(y.severity) - severityRank(x.severity))
    if (withProgress.some(record => record.progress?.files.some(file => file.hunks === undefined))) {
      notes.push('hunk-level overlap needs a readable diff; same-file overlap is still reported')
    }
    if (this.options.conflictPolicy === 'block') {
      notes.push('conflictPolicy is "block": worktrees with a blocking finding should be integrated first')
    }
    const report: ConflictReport = {
      repoRoot: canonical,
      at: new Date().toISOString(),
      worktrees: withProgress.map(record => record.id),
      findings: findings.map(finding =>
        this.options.conflictPolicy === 'block' && finding.kind === 'same-hunk'
          ? { ...finding, severity: 'blocking' as ConflictSeverity }
          : finding,
      ),
      notes,
    }
    const suggested = suggestOrder(withProgress)
    if (suggested.length > 0) report.suggestedOrder = suggested
    return report
  }

  /** Compare two worktrees and produce their findings. */
  private comparePair(a: MeshWorkspace, b: MeshWorkspace): ConflictFinding[] {
    const findings: ConflictFinding[] = []
    const aFiles = new Map((a.progress?.files ?? []).map(file => [file.path, file]))
    const bFiles = new Map((b.progress?.files ?? []).map(file => [file.path, file]))

    const shared: string[] = []
    for (const path of aFiles.keys()) {
      if (bFiles.has(path)) shared.push(path)
    }
    if (shared.length > 0) {
      findings.push({
        kind: 'same-file',
        severity: 'warning',
        left: a.id,
        right: b.id,
        paths: shared,
        detail: `${String(shared.length)} file(s) are modified by both ${String(a.agentId)} and ${String(b.agentId)}`,
      })
    }

    const overlapping: string[] = []
    for (const path of shared) {
      const leftHunks = aFiles.get(path)?.hunks
      const rightHunks = bFiles.get(path)?.hunks
      if (leftHunks === undefined || rightHunks === undefined) continue
      if (hunksOverlap(leftHunks, rightHunks)) overlapping.push(path)
    }
    if (overlapping.length > 0) {
      findings.push({
        kind: 'same-hunk',
        severity: 'blocking',
        left: a.id,
        right: b.id,
        paths: overlapping,
        detail: `edits overlap in the same line ranges of ${String(overlapping.length)} file(s)`,
      })
    }

    if (this.options.featureBoundaries.length > 0) {
      const related: string[] = []
      for (const leftPath of aFiles.keys()) {
        const leftBoundary = boundaryOf(leftPath, this.options.featureBoundaries)
        if (leftBoundary === undefined) continue
        for (const rightPath of bFiles.keys()) {
          if (rightPath === leftPath) continue
          if (boundaryOf(rightPath, this.options.featureBoundaries) === leftBoundary) {
            related.push(leftBoundary)
            break
          }
        }
      }
      const unique = [...new Set(related)]
      if (unique.length > 0) {
        findings.push({
          kind: 'feature-boundary',
          severity: 'info',
          left: a.id,
          right: b.id,
          paths: unique,
          detail: `both agents touch the same feature area(s): ${unique.join(', ')}`,
        })
      }
    }

    if (a.baseCommit !== b.baseCommit) {
      findings.push({
        kind: 'base-drift',
        severity: 'info',
        left: a.id,
        right: b.id,
        paths: [],
        detail: `worktrees were created from different commits (${a.baseCommit.slice(0, 8)} and ${b.baseCommit.slice(0, 8)})`,
      })
    }
    return findings
  }

  /**
   * Remove a worktree.
   *
   * @param id - Worktree id.
   * @param options - `force` discards unmerged work; refused by default because that
   *   is unrecoverable.
   * @returns The updated record, marked `removed`.
   * @throws {MutiAgentError} `worktree/unmerged` when the worktree has unmerged work
   *   and `force` was not requested, `worktree/dirty` when it has uncommitted changes.
   */
  async remove(id: string, options: { force?: boolean } = {}): Promise<MeshWorkspace> {
    const record = await this.get(id)
    if (record === undefined) {
      throw new MutiAgentError(ErrorCodes.worktreeNotFound, `no worktree with id ${id}`, { details: { id } })
    }
    const status = await this.git.status(record.path)
    const aheadBehind = await this.git.aheadBehind(record.path, record.baseCommit)
    if (options.force !== true) {
      if (status.length > 0) {
        throw new MutiAgentError(ErrorCodes.worktreeDirty, `${record.path} has uncommitted changes`, {
          details: { id, path: record.path, changedFiles: status.length },
          remediation: 'Commit or stash the work, or pass force to discard it.',
        })
      }
      if ((aheadBehind?.ahead ?? 0) > 0) {
        throw new MutiAgentError(
          ErrorCodes.worktreeUnmerged,
          `${record.branch} has ${String(aheadBehind?.ahead ?? 0)} unmerged commit(s)`,
          {
            details: { id, branch: record.branch, ahead: aheadBehind?.ahead ?? 0 },
            remediation: 'Merge the branch, or pass force to discard the work.',
          },
        )
      }
    }
    const removed = await this.git.removeWorktree(record.repoRoot, record.path, options.force === true)
    if (!removed.ok) {
      // A worktree whose directory was deleted by hand still has an administrative
      // entry; prune is the documented repair, not a force removal.
      await this.git.pruneWorktrees(record.repoRoot)
    }
    const updated: MeshWorkspace = { ...record, state: 'removed', reusable: false }
    await this.save(updated)
    this.state.appendJournal({
      at: new Date().toISOString(),
      kind: 'worktree.removed',
      id,
      detail: { path: record.path, forced: options.force === true },
    })
    return updated
  }

  /** Mark a worktree as integrated, so it stops appearing as outstanding work. */
  async markIntegrated(id: string): Promise<MeshWorkspace | undefined> {
    const record = await this.get(id)
    if (record === undefined) return undefined
    const updated: MeshWorkspace = { ...record, state: 'merged', reusable: false }
    await this.save(updated)
    return updated
  }

  /** Attach a live run to a worktree. */
  async bindRun(id: string, runId: string | undefined): Promise<void> {
    const record = await this.get(id)
    if (record === undefined) return
    const next: MeshWorkspace = { ...record, state: runId === undefined ? 'idle' : 'active' }
    if (runId === undefined) delete next.runId
    else next.runId = runId as NonNullable<MeshWorkspace['runId']>
    await this.save(next)
  }

  /**
   * Reconcile recorded worktrees with what git actually has.
   *
   * @returns Orphans (on disk, unrecorded) and stale records (recorded, gone).
   */
  async reconcile(repoRoot: string): Promise<{ orphans: readonly string[]; stale: readonly string[] }> {
    const canonical = await canonicalRepoRoot(this.git, repoRoot)
    const actual = await this.git.listWorktrees(canonical)
    const recorded = (await this.list()).filter(record => record.repoRoot === canonical)
    const recordedPaths = new Set(recorded.map(record => record.path))
    const actualPaths = new Set(actual.map(entry => entry.path))
    const orphans = actual
      .filter(entry => entry.path.includes(WORKTREE_DIR_NAME) && !recordedPaths.has(entry.path))
      .map(entry => entry.path)
    const stale: string[] = []
    for (const record of recorded) {
      if (record.state === 'removed') continue
      if (!actualPaths.has(record.path)) {
        stale.push(record.path)
        await this.save({ ...record, state: 'orphan', reusable: false })
      }
    }
    if (orphans.length > 0 || stale.length > 0) {
      this.log.warn('worktree records and git disagree', {
        repoRoot,
        orphans: orphans.length,
        stale: stale.length,
      })
      this.state.appendJournal({
        at: new Date().toISOString(),
        kind: 'worktree.reconciled',
        actor: 'orchestrator',
        detail: { repoRoot, orphans: orphans.length, stale: stale.length },
      })
    }
    return { orphans, stale }
  }
}

/**
 * The canonical absolute repository root.
 *
 * Every recorded worktree stores the canonical path, so a lookup must canonicalize the
 * query too: on macOS `/tmp` is a symlink to `/private/tmp`, and comparing the two
 * spellings silently returns no worktrees at all.
 *
 * @param git - Git helper.
 * @param path - A directory inside, or at the root of, the repository.
 * @returns The canonical repository root, or the input when it is not a repository.
 */
async function canonicalRepoRoot(git: Git, path: string): Promise<string> {
  const root = await git.repoRoot(path)
  if (root === undefined) return path
  try {
    const { realpath } = await import('node:fs/promises')
    return await realpath(root)
  } catch {
    return root
  }
}

function severityRank(severity: ConflictSeverity): number {
  if (severity === 'blocking') return 3
  if (severity === 'warning') return 2
  return 1
}

function hunksOverlap(
  left: readonly { start: number; lines: number }[],
  right: readonly { start: number; lines: number }[],
): boolean {
  for (const a of left) {
    const aEnd = a.start + Math.max(a.lines, 1) - 1
    for (const b of right) {
      const bEnd = b.start + Math.max(b.lines, 1) - 1
      if (a.start <= bEnd && b.start <= aEnd) return true
    }
  }
  return false
}

function boundaryOf(path: string, boundaries: readonly string[]): string | undefined {
  for (const boundary of boundaries) {
    if (boundary === '') continue
    if (boundary.endsWith('/')) {
      if (path.startsWith(boundary) || path.includes(`/${boundary}`)) return boundary
      continue
    }
    if (path === boundary || path.startsWith(`${boundary}/`) || path.includes(`/${boundary}/`)) return boundary
    if (path.includes(boundary)) return boundary
  }
  return undefined
}

/**
 * Propose an integration order: worktrees with no findings first, then those whose
 * only findings are informational, then the rest. A deterministic order that keeps
 * the biggest conflicts last is more useful than a perfect graph ordering, because
 * the human performs the merge.
 */
function suggestOrder(records: readonly MeshWorkspace[]): readonly MeshWorkspace['id'][] {
  const scored = records.map(record => ({
    id: record.id,
    score: (record.progress?.totals.files ?? 0) + (record.progress?.ahead ?? 0) * 2,
  }))
  scored.sort((a, b) => a.score - b.score)
  return scored.map(item => item.id)
}

function statusKind(code: string): FileChangeStat['status'] {
  if (code.includes('?')) return 'untracked'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  return 'modified'
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'work' : slug.slice(0, 40)
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10)
}
