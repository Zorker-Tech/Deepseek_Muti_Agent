/**
 * The Agent Sessions browser (ADR-0007): one partition per agent, with the
 * canonical metadata of every session MutiAgent can see — including the sessions the
 * harness itself does not own.
 *
 * Every row action is one of the five the wire contract can actually serve:
 * transcript, native launch command, track, untrack, dispatch. There is no "open in
 * the harness conversation view", because a foreign session cannot be projected into
 * the harness's own session tree (ADR-0012).
 *
 * @module @zorker/muti-agent-plugin/client/views/SessionsView
 */

import * as React from 'react'
import type { AgentSession, AgentSessionPartition } from '@zorker/muti-agent-contracts'
import type { LaunchCommand, RpcClient, SessionIndexSummary, SessionSort } from '../api.ts'
import { meshRevisionStore } from '../api.ts'
import { copyToClipboard, relativeTime, sessionStatus, shortenPath } from '../format.ts'
import { createStore, toFailure, useAsync, useStore, useT, type FailureInfo, type Store } from '../store.ts'
import { ErrorNotice } from '../components/DataTable.tsx'
import { Partition } from '../components/Partition.tsx'
import { StatusPill } from '../components/StatusPill.tsx'
import { MoreGlyph, RefreshGlyph } from '../icons.tsx'
import { notifyError, notifyFailure, notifyInfo } from '../components/Toast.tsx'
import { DispatchForm, type DispatchAgentOption } from './DispatchForm.tsx'
import { TranscriptView } from './TranscriptView.tsx'

/** Rows rendered per partition; the wire payload is fetched with the same ceiling. */
export const RENDER_CAP = 300

/** Which partition bodies are expanded. Module-level so it survives a view switch. */
const openPartitions: Store<Readonly<Record<string, boolean>>> = createStore({})

/** Props for {@link SessionsView}. */
export interface SessionsViewProps {
  /** The wire client. */
  readonly api: RpcClient
}

/** One row action. */
type SessionAction = 'transcript' | 'resume' | 'track' | 'untrack' | 'dispatch'

/** One "…" menu entry. */
interface MenuItem {
  readonly id: string
  readonly label: string
  readonly danger?: boolean
  readonly onSelect: () => void
}

/**
 * @param summary - The index summary, when the read succeeded.
 * @returns The freshest scan time the summary knows, if any.
 */
function lastScanOf(summary: SessionIndexSummary | undefined): string | undefined {
  if (summary === undefined) return undefined
  if (summary.lastRefresh !== undefined) return summary.lastRefresh
  let newest: string | undefined
  for (const agent of summary.agents) {
    const scan = agent.lastScan
    if (scan === undefined) continue
    if (newest === undefined || Date.parse(scan) > Date.parse(newest)) newest = scan
  }
  return newest
}

/**
 * @param props - The wire client.
 * @returns The sessions browser, or the transcript sub-view it switched to.
 */
export function SessionsView(props: SessionsViewProps): React.ReactElement {
  const t = useT()
  const { api } = props
  const [filter, setFilter] = React.useState('')
  const [sort, setSort] = React.useState<SessionSort>('updated')
  const [includeUntracked, setIncludeUntracked] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [failure, setFailure] = React.useState<FailureInfo | undefined>(undefined)
  const [openMenu, setOpenMenu] = React.useState<string | undefined>(undefined)
  const [launch, setLaunch] = React.useState<{ readonly key: string; readonly command: LaunchCommand } | undefined>(undefined)
  const [dispatch, setDispatch] = React.useState<
    { readonly agentId: string; readonly cwd: string | undefined; readonly nativeSessionId: string | undefined } | undefined
  >(undefined)
  const [sub, setSub] = React.useState<{ readonly kind: 'list' } | { readonly kind: 'transcript'; readonly key: string; readonly title: string }>(
    { kind: 'list' },
  )
  const expanded = useStore(openPartitions)
  // The stream's invalidation revision: a new or changed session re-reads this page,
  // and the fallback poll bumps it while the stream is down.
  const revision = useStore(meshRevisionStore)

  const query = filter.trim()
  const data = useAsync(
    signal =>
      api.sessionsPartitions(
        {
          ...(query === '' ? {} : { query }),
          sort,
          includeUntracked,
          limit: RENDER_CAP,
        },
        { signal },
      ),
    `${query}|${sort}|${includeUntracked ? 'all' : 'tracked'}|${String(revision)}`,
  )

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    setFailure(undefined)
    void api
      .sessionsRefresh()
      .then(() => {
        data.reload()
      })
      .catch((cause: unknown) => {
        const info = toFailure(cause)
        setFailure(info)
        notifyFailure(info)
      })
      .finally(() => {
        setRefreshing(false)
      })
  }

  /**
   * @param session - The row's session.
   * @param action - The action chosen from the row menu.
   */
  const run = (session: AgentSession, action: SessionAction): void => {
    setOpenMenu(undefined)
    setFailure(undefined)
    const key = String(session.key)
    const agentId = String(session.agentId)
    const nativeId = String(session.nativeId)
    const title = session.title ?? nativeId
    switch (action) {
      case 'transcript':
        setSub({ kind: 'transcript', key, title })
        return
      case 'dispatch':
        setDispatch({
          agentId,
          cwd: session.cwd,
          nativeSessionId: nativeId,
        })
        return
      case 'resume':
        void api
          .agentsLaunchCommand({ agentId, nativeSessionId: nativeId })
          .then(command => {
            setLaunch({ key, command })
          })
          .catch((cause: unknown) => {
            const info = toFailure(cause)
            setFailure(info)
            notifyFailure(info)
          })
        return
      case 'track':
        void api
          .sessionsImport({ keys: [key], actor: 'gui' })
          .then(() => {
            data.reload()
          })
          .catch((cause: unknown) => {
            const info = toFailure(cause)
            setFailure(info)
            notifyFailure(info)
          })
        return
      case 'untrack':
        void api
          .sessionsUntrack({ keys: [key] })
          .then(() => {
            data.reload()
          })
          .catch((cause: unknown) => {
            const info = toFailure(cause)
            setFailure(info)
            notifyFailure(info)
          })
        return
    }
  }

  if (sub.kind === 'transcript') {
    return (
      <TranscriptView
        api={api}
        sessionKey={sub.key}
        title={sub.title}
        onBack={() => {
          setSub({ kind: 'list' })
        }}
      />
    )
  }

  const summary = data.state.status === 'ready' ? data.state.value.summary : undefined
  const partitions: readonly AgentSessionPartition[] =
    data.state.status === 'ready' ? data.state.value.partitions : []
  const scanned = (summary?.lastRefresh ?? lastScanOf(summary)) !== undefined
  const untrackedTotal = partitions.reduce((total, part) => total + part.untrackedCount, 0)
  const agents: readonly DispatchAgentOption[] = partitions.map(part => ({
    agentId: part.agentId,
    displayName: part.displayName,
    installed: part.installed,
  }))
  const dispatchProps =
    dispatch === undefined
      ? undefined
      : {
          ...(dispatch.cwd === undefined ? {} : { initialCwd: dispatch.cwd }),
          ...(dispatch.agentId === '' ? {} : { initialAgentId: dispatch.agentId }),
          ...(dispatch.nativeSessionId === undefined
            ? {}
            : { initialNativeSessionId: dispatch.nativeSessionId }),
        }

  return (
    <div className="ma-page">
      <header className="ma-head">
        <div className="ma-inline ma-inline--wrap">
          <h1 className="ma-title">{t('sessions.title')}</h1>
          <span className="ma-spacer" />
          <span className="ma-sub">{t('sessions.tracked', { count: summary?.totalTracked ?? 0 })}</span>
          <span className="ma-sub">
            {scanned ? t('sessions.lastScan', { time: relativeTime(lastScanOf(summary), t) }) : t('sessions.notScanned')}
          </span>
        </div>
        <div className="ma-inline ma-inline--wrap">
          <button type="button" className="ma-btn ma-btn--primary" onClick={refresh} disabled={refreshing}>
            <RefreshGlyph size={13} />
            {refreshing ? t('sessions.refreshing') : t('common.refresh')}
          </button>
          <input
            className="ma-input"
            type="search"
            value={filter}
            placeholder={t('sessions.filter')}
            aria-label={t('sessions.filter')}
            onChange={event => {
              setFilter(event.target.value)
            }}
          />
          <label className="ma-inline">
            <span className="ma-field-label">{t('sessions.sort')}</span>
            <select
              className="ma-select"
              value={sort}
              aria-label={t('sessions.sortLabel')}
              onChange={event => {
                const next = event.target.value
                setSort(next === 'created' || next === 'title' ? next : 'updated')
              }}
            >
              <option value="updated">{t('sessions.sort.updated')}</option>
              <option value="created">{t('sessions.sort.created')}</option>
              <option value="title">{t('sessions.sort.title')}</option>
            </select>
          </label>
          <span className="ma-spacer" />
          {includeUntracked ? (
            <>
              <span className="ma-muted">{t('sessions.showingUntracked')}</span>
              <button
                type="button"
                className="ma-btn"
                onClick={() => {
                  setIncludeUntracked(false)
                }}
              >
                {t('sessions.hideUntracked')}
              </button>
            </>
          ) : untrackedTotal > 0 ? (
            <button
              type="button"
              className="ma-btn"
              onClick={() => {
                setIncludeUntracked(true)
              }}
            >
              {t('sessions.untracked', { count: untrackedTotal })}
            </button>
          ) : null}
        </div>
      </header>
      <div className="ma-scroll">
        {failure === undefined ? null : <ErrorNotice failure={failure} />}
        {data.state.status === 'loading' ? <p className="ma-muted">{t('common.loading')}</p> : null}
        {data.state.status === 'error' ? (
          <>
            <ErrorNotice failure={data.state.error} />
            <div>
              <button type="button" className="ma-btn" onClick={data.reload}>
                {t('common.retry')}
              </button>
            </div>
          </>
        ) : null}
        {data.state.status === 'ready' && partitions.length === 0 ? (
          <p className="ma-muted">{scanned ? t('sessions.empty') : t('sessions.notScanned')}</p>
        ) : null}
        {data.state.status === 'ready'
          ? partitions.map(part => {
              const rows = part.sessions.slice(0, RENDER_CAP)
              return (
                <Partition
                  key={part.agentId}
                  title={part.displayName}
                  badge={
                    part.installed ? (
                      <StatusPill tone="ok" label={t('sessions.installed')} />
                    ) : (
                      <StatusPill tone="warn" label={t('sessions.notInstalledBadge')} />
                    )
                  }
                  count={t('sessions.count', { count: part.sessions.length })}
                  {...(part.note === undefined ? {} : { note: part.note })}
                  open={expanded[part.agentId] ?? true}
                  onToggle={() => {
                    openPartitions.update(state => ({
                      ...state,
                      [part.agentId]: !(state[part.agentId] ?? true),
                    }))
                  }}
                >
                  {rows.length === 0 ? (
                    <p className="ma-note">{part.note ?? t('sessions.empty')}</p>
                  ) : (
                    rows.map(session => (
                      <SessionRow
                        key={String(session.key)}
                        session={session}
                        menuOpen={openMenu === String(session.key)}
                        canTrack={includeUntracked}
                        launch={
                          launch !== undefined && launch.key === String(session.key)
                            ? launch.command
                            : undefined
                        }
                        onToggleMenu={() => {
                          setOpenMenu(current => (current === String(session.key) ? undefined : String(session.key)))
                        }}
                        onCloseMenu={() => {
                          setOpenMenu(undefined)
                        }}
                        onAction={action => {
                          run(session, action)
                        }}
                      />
                    ))
                  )}
                  {part.sessions.length > RENDER_CAP ? <p className="ma-note">{t('sessions.cap')}</p> : null}
                </Partition>
              )
            })
          : null}
      </div>
      {dispatchProps === undefined ? null : (
        <DispatchForm
          api={api}
          agents={agents}
          {...dispatchProps}
          onClose={() => {
            setDispatch(undefined)
          }}
          onDispatched={() => {
            setDispatch(undefined)
            data.reload()
          }}
        />
      )}
    </div>
  )
}

/** Props for one session row. */
interface SessionRowProps {
  readonly session: AgentSession
  readonly menuOpen: boolean
  /** Whether an untracked row may be tracked from here. */
  readonly canTrack: boolean
  /** The launch command, once resolved for this row. */
  readonly launch: LaunchCommand | undefined
  readonly onToggleMenu: () => void
  readonly onCloseMenu: () => void
  readonly onAction: (action: SessionAction) => void
}

/**
 * @param props - Session, menu state and the action sink.
 * @returns The row.
 */
function SessionRow(props: SessionRowProps): React.ReactElement {
  const t = useT()
  const { session, launch } = props
  const status = sessionStatus(session.status, t)
  const cwd = session.cwd
  const items: MenuItem[] = [
    { id: 'transcript', label: t('sessions.openTranscript'), onSelect: () => { props.onAction('transcript') } },
    { id: 'resume', label: t('sessions.resume'), onSelect: () => { props.onAction('resume') } },
    ...(props.canTrack
      ? [{ id: 'track', label: t('sessions.track'), onSelect: () => { props.onAction('track') } }]
      : []),
    { id: 'untrack', label: t('sessions.untrack'), onSelect: () => { props.onAction('untrack') } },
    { id: 'dispatch', label: t('sessions.dispatch'), onSelect: () => { props.onAction('dispatch') } },
  ]
  return (
    <div className="ma-column">
      <div className="ma-session">
        <div className="ma-session-main">
          <span className="ma-session-title ma-truncate" title={session.title ?? String(session.nativeId)}>
            {session.title ?? String(session.nativeId)}
          </span>
          <div className="ma-session-meta">
            {session.model === undefined ? null : (
              <StatusPill tone="idle" label={session.model} title={t('sessions.modelTitle', { model: session.model })} />
            )}
            {session.branch === undefined ? null : (
              <StatusPill tone="idle" label={session.branch} title={t('sessions.branchTitle', { branch: session.branch })} />
            )}
            {session.status === 'idle' || session.status === 'running' ? null : (
              <StatusPill tone={status.tone} label={status.label} />
            )}
            {cwd === undefined ? null : (
              <span className="ma-mono ma-truncate" title={t('sessions.cwdTitle', { path: cwd })}>
                {shortenPath(cwd)}
              </span>
            )}
            <span>{t('sessions.updated', { time: relativeTime(session.updatedAt, t) })}</span>
            {session.messageCount === undefined ? null : (
              <span>{t('sessions.messages', { count: session.messageCount })}</span>
            )}
          </div>
        </div>
        <RowMenu
          open={props.menuOpen}
          label={t('sessions.actions')}
          items={items}
          onToggle={props.onToggleMenu}
          onClose={props.onCloseMenu}
        />
      </div>
      {launch === undefined ? null : (
        <div className="ma-note">
          <div className="ma-inline ma-inline--wrap">
            <span className="ma-field-label">{t('sessions.launchTitle')}</span>
            <span className="ma-spacer" />
            <button
              type="button"
              className="ma-btn"
              onClick={() => {
                void copyToClipboard(launch.argv.join(' ')).then(copied => {
                  if (copied) notifyInfo(t('common.copied'))
                  else notifyError(t('common.copyFailed'))
                })
              }}
            >
              {t('common.copy')}
            </button>
          </div>
          <pre className="ma-pre ma-mono">{launch.argv.join(' ')}</pre>
          <p className="ma-muted">{launch.note}</p>
        </div>
      )}
    </div>
  )
}

/** Props for the row's overflow menu. */
interface RowMenuProps {
  readonly open: boolean
  /** Accessible name of the trigger. */
  readonly label: string
  readonly items: readonly MenuItem[]
  readonly onToggle: () => void
  readonly onClose: () => void
}

/**
 * A small overflow menu: one trigger, a list of actions, dismissal on outside click
 * and on Escape.
 *
 * @param props - Trigger name, items and visibility.
 * @returns The menu.
 */
function RowMenu(props: RowMenuProps): React.ReactElement {
  const container = React.useRef<HTMLDivElement | null>(null)
  const { open, onClose } = props
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && container.current?.contains(target) === true) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])
  return (
    <div className="ma-menu-wrap" ref={container}>
      <button
        type="button"
        className="ma-btn ma-btn--quiet ma-btn--icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label}
        title={props.label}
        onClick={props.onToggle}
      >
        <MoreGlyph size={14} />
      </button>
      {open ? (
        <div className="ma-menu" role="menu">
          {props.items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.danger === true ? 'ma-menu-item ma-menu-item--danger' : 'ma-menu-item'}
              onClick={item.onSelect}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
