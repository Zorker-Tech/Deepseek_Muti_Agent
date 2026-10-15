/**
 * The orchestration view (ADR-0007 second panel): what MutiAgent is running right
 * now, what it ran recently, the worktrees those runs occupy with their progress and
 * conflicts, and the shared plan/todo board of a collaboration (ADR-0008, ADR-0009).
 *
 * Nothing here drives a TUI: a run is a process MutiAgent launched, and its state is
 * reported by the run record, not scraped from a terminal.
 *
 * @module @zorker/muti-agent-plugin/client/views/MeshView
 */

import * as React from 'react'
import type {
  Collaboration,
  ConflictFinding,
  ConflictReport,
  ConflictSeverity,
  MeshWorkspace,
  RunRecord,
  SharedTodoDoc,
} from '@zorker/muti-agent-contracts'
import { meshFeedStore, meshRevisionStore, type RpcClient } from '../api.ts'
import {
  conflictSeverity,
  elapsedSince,
  formatCount,
  phaseStatus,
  relativeTime,
  runStatus,
  shortenPath,
  todoStatus,
  worktreeState,
} from '../format.ts'
import type { Translate } from '../locales.ts'
import { toFailure, useAsync, useStore, useT, type AsyncState, type FailureInfo } from '../store.ts'
import { DataTable, ErrorNotice, type DataTableColumn } from '../components/DataTable.tsx'
import { StatusPill } from '../components/StatusPill.tsx'
import { notifyFailure, notifyInfo } from '../components/Toast.tsx'
import { RefreshGlyph } from '../icons.tsx'

/** How many historical runs the panel shows. */
const RUN_PAGE = 30

/** The severity order findings are grouped in. */
const SEVERITY_ORDER: readonly ConflictSeverity[] = ['blocking', 'warning', 'info']

/** Props for {@link MeshView}. */
export interface MeshViewProps {
  /** The wire client. */
  readonly api: RpcClient
}

/**
 * @param record - A run record.
 * @returns Whether the run has not reached a terminal state.
 */
function isLive(record: RunRecord): boolean {
  return record.status === 'running' || record.status === 'preparing'
}

/**
 * @param state - A state from {@link useAsync}.
 * @param t - Translator.
 * @returns The value when the read succeeded.
 */
function valueOf<T>(state: AsyncState<T>): T | undefined {
  return state.status === 'ready' ? state.value : undefined
}

/**
 * @param state - A state from {@link useAsync}.
 * @returns The failure when the read failed.
 */
function failureOf<T>(state: AsyncState<T>): FailureInfo | undefined {
  return state.status === 'error' ? state.error : undefined
}

/**
 * @param t - Translator.
 * @returns The worktree table's columns.
 */
function worktreeColumns(t: Translate): readonly DataTableColumn<MeshWorkspace>[] {
  return [
    {
      id: 'path',
      label: t('mesh.column.path'),
      render: tree => (
        <span className="ma-mono ma-truncate" title={tree.path}>
          {shortenPath(tree.path)}
        </span>
      ),
    },
    { id: 'agent', label: t('mesh.column.agent'), render: tree => String(tree.agentId) },
    {
      id: 'branch',
      label: t('mesh.column.worktree'),
      render: tree => <span className="ma-mono">{tree.branch}</span>,
    },
    {
      id: 'state',
      label: t('mesh.column.status'),
      render: tree => <StatusPill {...worktreeState(tree.state, t)} />,
    },
    {
      id: 'totals',
      label: t('mesh.column.totals'),
      align: 'end',
      render: tree => (
        <span className="ma-mono">
          {`+${String(tree.progress?.totals.insertions ?? 0)}/-${String(tree.progress?.totals.deletions ?? 0)}/${String(tree.progress?.totals.files ?? 0)}`}
        </span>
      ),
    },
    {
      id: 'ahead',
      label: t('mesh.column.ahead'),
      align: 'end',
      render: tree => (tree.progress === undefined ? '—' : t('mesh.ahead', { count: tree.progress.ahead })),
    },
    {
      id: 'dirty',
      label: '',
      render: tree =>
        tree.progress?.dirty === true ? (
          <StatusPill tone="warn" label={t('mesh.dirty')} />
        ) : (
          <StatusPill tone="ok" label={t('mesh.clean')} />
        ),
    },
  ]
}

/**
 * @param props - The wire client.
 * @returns The orchestration page.
 */
export function MeshView(props: MeshViewProps): React.ReactElement {
  const t = useT()
  const { api } = props
  const revision = useStore(meshRevisionStore)
  const feed = useStore(meshFeedStore)
  const [now, setNow] = React.useState(() => Date.now())
  const [busyRun, setBusyRun] = React.useState<string | undefined>(undefined)
  const [failure, setFailure] = React.useState<FailureInfo | undefined>(undefined)
  const [repoRoot, setRepoRoot] = React.useState<string | undefined>(undefined)
  const [report, setReport] = React.useState<ConflictReport | undefined>(undefined)
  const [reportBusy, setReportBusy] = React.useState(false)
  const [collaborationId, setCollaborationId] = React.useState<string | undefined>(undefined)

  const keySuffix = String(revision)
  const runs = useAsync(signal => api.runsList({ limit: RUN_PAGE + 20 }, { signal }), `runs|${keySuffix}`)
  const worktrees = useAsync(signal => api.worktreesList({}, { signal }), `worktrees|${keySuffix}`)
  const collaborations = useAsync(
    signal => api.collaborationsList({ signal }),
    `collaborations|${keySuffix}`,
  )

  const runList = valueOf(runs.state)?.runs ?? []
  const liveRuns = runList.filter(isLive)
  const worktreeList = valueOf(worktrees.state) ?? []
  const collaborationList = valueOf(collaborations.state) ?? []
  const selectedCollaborationId =
    collaborationId ??
    (collaborationList[0] === undefined ? undefined : String(collaborationList[0].id))
  const selectedCollaboration = collaborationList.find(
    entry => String(entry.id) === selectedCollaborationId,
  )

  const board = useAsync(
    async signal => {
      if (selectedCollaborationId === undefined) return undefined
      return await api.todosGet({ collaborationId: selectedCollaborationId }, { signal })
    },
    `todos|${selectedCollaborationId ?? 'none'}|${keySuffix}`,
  )

  // A live run's elapsed time is the one value that must tick without new data.
  React.useEffect(() => {
    if (liveRuns.length === 0) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [liveRuns.length])

  const repos = [...new Set(worktreeList.map(tree => tree.repoRoot))]
  const selectedRepo = repoRoot ?? repos[0]
  const branches = new Map(worktreeList.map(tree => [String(tree.id), tree.branch]))

  const runsFailure = failureOf(runs.state)
  const worktreesFailure = failureOf(worktrees.state)
  const collaborationsFailure = failureOf(collaborations.state)
  const boardFailure = failureOf(board.state)
  const boardValue = valueOf(board.state)

  /**
   * Ask a human, then terminate the run's process group.
   *
   * @param record - The live run to cancel.
   */
  const cancelRun = (record: RunRecord): void => {
    const id = String(record.id)
    if (typeof window !== 'undefined' && !window.confirm(t('mesh.cancelConfirm', { id }))) return
    setBusyRun(id)
    setFailure(undefined)
    void api
      .runsCancel({ runId: id, reason: 'cancelled from the MutiAgent mesh panel' })
      .then(result => {
        if (result.cancelled) notifyInfo(t('mesh.cancelRequested', { id }))
        runs.reload()
      })
      .catch((cause: unknown) => {
        const info = toFailure(cause)
        setFailure(info)
        notifyFailure(info)
      })
      .finally(() => {
        setBusyRun(undefined)
      })
  }

  /**
   * @param root - The repository to analyse.
   */
  const checkConflicts = (root: string | undefined): void => {
    if (root === undefined || reportBusy) return
    setReportBusy(true)
    setFailure(undefined)
    setReport(undefined)
    void api
      .worktreesConflicts({ repoRoot: root })
      .then(result => {
        setReport(result)
      })
      .catch((cause: unknown) => {
        const info = toFailure(cause)
        setFailure(info)
        notifyFailure(info)
      })
      .finally(() => {
        setReportBusy(false)
      })
  }

  const activeColumns: readonly DataTableColumn<RunRecord>[] = [
    { id: 'agent', label: t('mesh.column.agent'), render: record => String(record.agentId) },
    {
      id: 'status',
      label: t('mesh.column.status'),
      render: record => <StatusPill {...runStatus(record.status, t)} />,
    },
    {
      id: 'elapsed',
      label: t('mesh.column.elapsed'),
      render: record => <span className="ma-mono">{elapsedSince(record.startedAt, now)}</span>,
    },
    {
      id: 'worktree',
      label: t('mesh.column.worktree'),
      render: record =>
        record.worktreeId === undefined ? (
          <span className="ma-muted">{t('common.none')}</span>
        ) : (
          <span className="ma-mono">{branches.get(String(record.worktreeId)) ?? String(record.worktreeId)}</span>
        ),
    },
    {
      id: 'actions',
      label: t('mesh.column.actions'),
      align: 'end',
      render: record => (
        <button
          type="button"
          className="ma-btn ma-btn--danger"
          disabled={busyRun === String(record.id)}
          onClick={() => {
            cancelRun(record)
          }}
        >
          {t('mesh.cancel')}
        </button>
      ),
    },
  ]

  const historyColumns: readonly DataTableColumn<RunRecord>[] = [
    { id: 'agent', label: t('mesh.column.agent'), render: record => String(record.agentId) },
    {
      id: 'status',
      label: t('mesh.column.status'),
      render: record => <StatusPill {...runStatus(record.status, t)} />,
    },
    {
      id: 'prompt',
      label: t('dispatch.prompt'),
      render: record => (
        <span className="ma-truncate" title={record.prompt}>
          {record.prompt}
        </span>
      ),
    },
    {
      id: 'started',
      label: t('mesh.column.started'),
      render: record => relativeTime(record.startedAt, t),
    },
    {
      id: 'files',
      label: t('mesh.column.counters'),
      align: 'end',
      render: record => `${formatCount(record.counters.filesChanged)} / ${formatCount(record.counters.toolCalls)}`,
    },
  ]

  return (
    <div className="ma-page">
      <header className="ma-head">
        <div className="ma-inline ma-inline--wrap">
          <h1 className="ma-title">{t('mesh.title')}</h1>
          <span className="ma-spacer" />
          <span className="ma-sub">
            {feed.status === 'open'
              ? t('mesh.stream.open')
              : feed.status === 'down'
                ? t('mesh.stream.down')
                : t('mesh.stream.connecting')}
          </span>
          <button
            type="button"
            className="ma-btn ma-btn--icon"
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
            onClick={() => {
              runs.reload()
              worktrees.reload()
              collaborations.reload()
              board.reload()
            }}
          >
            <RefreshGlyph size={14} />
          </button>
        </div>
      </header>
      <div className="ma-scroll">
        {failure === undefined ? null : <ErrorNotice failure={failure} />}

        <section className="ma-card">
          <div className="ma-card-head">
            <h2 className="ma-card-title">{t('mesh.active')}</h2>
            <span className="ma-spacer" />
            <span className="ma-sub">{formatCount(liveRuns.length)}</span>
          </div>
          <div className="ma-card-body">
            <DataTable
              columns={activeColumns}
              rows={liveRuns}
              rowKey={record => String(record.id)}
              empty={t('mesh.active.empty')}
              {...(runsFailure === undefined ? {} : { failure: runsFailure })}
            />
          </div>
        </section>

        <section className="ma-card">
          <div className="ma-card-head">
            <h2 className="ma-card-title">{t('mesh.runs')}</h2>
            <span className="ma-spacer" />
            <span className="ma-sub">{t('mesh.runs.recent', { count: RUN_PAGE })}</span>
          </div>
          <div className="ma-card-body">
            <DataTable
              columns={historyColumns}
              rows={runList.slice(0, RUN_PAGE)}
              rowKey={record => String(record.id)}
              empty={t('mesh.runs.empty')}
            />
          </div>
        </section>

        <section className="ma-card">
          <div className="ma-card-head">
            <h2 className="ma-card-title">{t('mesh.worktrees')}</h2>
            <span className="ma-spacer" />
            {repos.length === 0 ? null : (
              <select
                className="ma-select"
                value={selectedRepo ?? ''}
                aria-label={t('mesh.repository')}
                onChange={event => {
                  setRepoRoot(event.target.value)
                }}
              >
                {repos.map(root => (
                  <option key={root} value={root}>
                    {shortenPath(root, 2)}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="ma-btn"
              disabled={selectedRepo === undefined || reportBusy}
              title={selectedRepo === undefined ? t('mesh.noRepo') : undefined}
              onClick={() => {
                checkConflicts(selectedRepo)
              }}
            >
              {t('mesh.conflicts')}
            </button>
          </div>
          <div className="ma-card-body">
            <DataTable
              columns={worktreeColumns(t)}
              rows={worktreeList}
              rowKey={tree => String(tree.id)}
              empty={t('mesh.worktrees.empty')}
              {...(worktreesFailure === undefined ? {} : { failure: worktreesFailure })}
            />
          </div>
          {report === undefined ? null : <ConflictSection report={report} />}
        </section>

        <section className="ma-card">
          <div className="ma-card-head">
            <h2 className="ma-card-title">{t('mesh.board')}</h2>
            <span className="ma-spacer" />
            {collaborationList.length === 0 ? null : (
              <select
                className="ma-select"
                value={selectedCollaborationId ?? ''}
                aria-label={t('mesh.board.select')}
                onChange={event => {
                  setCollaborationId(event.target.value)
                }}
              >
                {collaborationList.map(entry => (
                  <option key={String(entry.id)} value={String(entry.id)}>
                    {entry.title}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="ma-card-body">
            {collaborationsFailure === undefined ? null : (
              <ErrorNotice failure={collaborationsFailure} />
            )}
            {collaborationList.length === 0 && collaborationsFailure === undefined ? (
              <p className="ma-muted">{t('mesh.board.none')}</p>
            ) : null}
            {selectedCollaboration === undefined ? null : (
              <PlanSection collaboration={selectedCollaboration} />
            )}
            {boardFailure === undefined ? null : <ErrorNotice failure={boardFailure} />}
            {boardValue === undefined ? null : <TodoSection board={boardValue} />}
          </div>
        </section>
      </div>
    </div>
  )
}

/**
 * @param props - The report to group.
 * @returns Findings grouped by severity, most severe first, plus notes and order.
 */
function ConflictSection(props: { readonly report: ConflictReport }): React.ReactElement {
  const t = useT()
  const { report } = props
  return (
    <div className="ma-card-body">
      {report.findings.length === 0 ? <p className="ma-muted">{t('mesh.conflicts.empty')}</p> : null}
      {SEVERITY_ORDER.map(severity => {
        const findings = report.findings.filter(finding => finding.severity === severity)
        if (findings.length === 0) return null
        const presentation = conflictSeverity(severity, t)
        return (
          <div className="ma-column" key={severity}>
            <StatusPill tone={presentation.tone} label={presentation.label} />
            <ul className="ma-list">
              {findings.map(finding => (
                <FindingRow
                  key={`${finding.kind}:${String(finding.left)}:${String(finding.right)}:${finding.paths.join(',')}`}
                  finding={finding}
                />
              ))}
            </ul>
          </div>
        )
      })}
      {report.suggestedOrder === undefined ? null : (
        <p className="ma-sub">
          {t('mesh.conflicts.order')}: {report.suggestedOrder.map(String).join(' → ')}
        </p>
      )}
      {report.notes.length === 0 ? null : (
        <div className="ma-column">
          <span className="ma-field-label">{t('mesh.conflicts.notes')}</span>
          <ul className="ma-list">
            {report.notes.map(note => (
              <li key={note} className="ma-muted">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * @param props - One finding.
 * @returns The finding's row.
 */
function FindingRow(props: { readonly finding: ConflictFinding }): React.ReactElement {
  const t = useT()
  const { finding } = props
  return (
    <li className="ma-column">
      <span>{finding.detail}</span>
      <span className="ma-mono ma-muted">
        {String(finding.left)} ⇄ {String(finding.right)}
      </span>
      {finding.paths.length === 0 ? null : (
        <span className="ma-mono ma-muted">
          {t('transcript.paths')}: {finding.paths.map(path => shortenPath(path)).join(', ')}
        </span>
      )}
    </li>
  )
}

/**
 * @param props - The collaboration whose plan to render.
 * @returns The plan's objective, decisions and phases.
 */
function PlanSection(props: { readonly collaboration: Collaboration }): React.ReactElement {
  const t = useT()
  const { plan } = props.collaboration
  return (
    <div className="ma-column">
      <h3 className="ma-card-title">{t('mesh.plan')}</h3>
      <dl className="ma-dl">
        <dt>{t('mesh.plan.objective')}</dt>
        <dd>{plan.objective}</dd>
        <dt>{t('mesh.plan.decisions')}</dt>
        <dd>{plan.decisions.length === 0 ? t('common.none') : plan.decisions.join('; ')}</dd>
      </dl>
      <DataTable
        columns={[
          { id: 'phase', label: t('mesh.plan.phases'), render: phase => phase.title },
          {
            id: 'status',
            label: t('mesh.column.status'),
            render: phase => <StatusPill {...phaseStatus(phase.status, t)} />,
          },
          {
            id: 'owner',
            label: t('mesh.todo.owner'),
            render: phase => (phase.owner === undefined ? t('common.none') : String(phase.owner)),
          },
          {
            id: 'criteria',
            label: t('mesh.plan.exitCriteria'),
            render: phase => <span className="ma-muted">{phase.exitCriteria ?? ''}</span>,
          },
        ]}
        rows={plan.phases}
        rowKey={phase => phase.id}
        empty={t('mesh.plan.noPhases')}
      />
    </div>
  )
}

/**
 * @param props - The board to render.
 * @returns The shared todo table.
 */
function TodoSection(props: { readonly board: SharedTodoDoc }): React.ReactElement {
  const t = useT()
  return (
    <div className="ma-column">
      <h3 className="ma-card-title">{t('mesh.todos')}</h3>
      <DataTable
        columns={[
          { id: 'content', label: t('mesh.todos'), render: todo => todo.content },
          { id: 'owner', label: t('mesh.todo.owner'), render: todo => String(todo.owner) },
          {
            id: 'status',
            label: t('mesh.todo.status'),
            render: todo => <StatusPill {...todoStatus(todo.status, t)} />,
          },
        ]}
        rows={props.board.todos}
        rowKey={todo => String(todo.id)}
        empty={t('mesh.todos.empty')}
      />
    </div>
  )
}
