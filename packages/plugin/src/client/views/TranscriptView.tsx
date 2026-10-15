/**
 * One session's transcript: a bounded window of normalized messages, read through
 * `sessions.transcript`. This is MutiAgent's own reader, not the harness's
 * conversation view — MutiAgent reads other agents' stores and never rewrites them
 * (ADR-0012), so "open transcript" means exactly this page.
 *
 * @module @zorker/muti-agent-plugin/client/views/TranscriptView
 */

import * as React from 'react'
import type { AgentMessage, AgentTranscript } from '@zorker/muti-agent-contracts'
import type { RpcClient } from '../api.ts'
import { messageKind, relativeTime, shortenPath } from '../format.ts'
import { useAsync, useT } from '../store.ts'
import { ErrorNotice } from '../components/DataTable.tsx'
import { StatusPill } from '../components/StatusPill.tsx'
import { RefreshGlyph } from '../icons.tsx'

/** Default window size; the host rejects anything above 2000. */
const DEFAULT_WINDOW = 200

/** Upper bound the `sessions.transcript` schema accepts. */
const MAX_WINDOW = 2000

/** Props for {@link TranscriptView}. */
export interface TranscriptViewProps {
  /** The wire client. */
  readonly api: RpcClient
  /** Canonical session key being read. */
  readonly sessionKey: string
  /** Heading text: the session title, or its native id. */
  readonly title: string
  /** Return to the session list. */
  readonly onBack: () => void
}

/**
 * @param props - Session, client and the back action.
 * @returns The transcript page.
 */
export function TranscriptView(props: TranscriptViewProps): React.ReactElement {
  const t = useT()
  const { api, sessionKey } = props
  const [window, setWindow] = React.useState(DEFAULT_WINDOW)
  const read = useAsync<AgentTranscript>(
    signal => api.sessionsTranscript({ key: sessionKey, maxMessages: window }, { signal }),
    `${sessionKey}|${String(window)}`,
  )

  return (
    <div className="ma-page">
      <header className="ma-head">
        <div className="ma-inline ma-inline--wrap">
          <button type="button" className="ma-btn ma-btn--quiet" onClick={props.onBack}>
            ← {t('transcript.back')}
          </button>
          <span className="ma-spacer" />
          <button
            type="button"
            className="ma-btn ma-btn--icon"
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
            onClick={read.reload}
          >
            <RefreshGlyph size={14} />
          </button>
        </div>
        <h1 className="ma-title ma-truncate">{props.title}</h1>
        <div className="ma-sub ma-mono ma-truncate">{sessionKey}</div>
        {read.state.status === 'ready' ? (
          <div className="ma-inline ma-inline--wrap">
            <span className="ma-sub">
              {read.state.value.totalMessages === undefined
                ? t('transcript.windowUnknown', { shown: read.state.value.messages.length })
                : t('transcript.window', {
                    shown: read.state.value.messages.length,
                    total: read.state.value.totalMessages,
                  })}
            </span>
            {read.state.value.hasMore && window < MAX_WINDOW ? (
              <button
                type="button"
                className="ma-btn"
                onClick={() => {
                  setWindow(current => Math.min(MAX_WINDOW, current * 2))
                }}
              >
                {t('transcript.more')}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      <div className="ma-scroll">
        {read.state.status === 'loading' ? <p className="ma-muted">{t('common.loading')}</p> : null}
        {read.state.status === 'error' ? <ErrorNotice failure={read.state.error} /> : null}
        {read.state.status === 'ready' ? (
          <TranscriptBody transcript={read.state.value} />
        ) : null}
      </div>
    </div>
  )
}

/**
 * @param props - The transcript to render.
 * @returns The message list, its projection notes, or the empty state.
 */
function TranscriptBody(props: { readonly transcript: AgentTranscript }): React.ReactElement {
  const t = useT()
  const { transcript } = props
  if (transcript.messages.length === 0) {
    return <p className="ma-muted">{t('transcript.empty')}</p>
  }
  return (
    <>
      <section className="ma-card">
        {transcript.messages.map(message => (
          <TranscriptMessage key={String(message.index)} message={message} />
        ))}
      </section>
      {transcript.notes.length === 0 ? null : (
        <section className="ma-card">
          <div className="ma-card-head">
            <h2 className="ma-card-title">{t('transcript.project')}</h2>
          </div>
          <div className="ma-card-body">
            <dl className="ma-dl">
              {transcript.notes.map(note => (
                <React.Fragment key={`${note.field}:${note.reason}`}>
                  <dt>{note.field}</dt>
                  <dd>{note.reason}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        </section>
      )}
    </>
  )
}

/**
 * @param props - One normalized message.
 * @returns The message row.
 */
function TranscriptMessage(props: { readonly message: AgentMessage }): React.ReactElement {
  const t = useT()
  const { message } = props
  const tool = message.tool
  return (
    <article className="ma-msg">
      <div className="ma-inline ma-inline--wrap">
        <span className="ma-msg-kind">{messageKind(message.kind, t)}</span>
        {tool === undefined ? null : <span className="ma-msg-kind ma-mono">{tool.name}</span>}
        {tool?.failed === true ? (
          <StatusPill tone="error" label={t('transcript.failed')} />
        ) : null}
        {message.truncated === true ? (
          <StatusPill tone="warn" label={t('transcript.truncated')} />
        ) : null}
        <span className="ma-spacer" />
        <span className="ma-msg-kind">{relativeTime(message.timestamp, t)}</span>
      </div>
      {message.text === undefined || message.text === '' ? null : (
        <p className="ma-msg-text">{message.text}</p>
      )}
      {tool?.input === undefined || tool.input === '' ? null : (
        <>
          <span className="ma-msg-kind">{t('transcript.input')}</span>
          <pre className="ma-pre">{tool.input}</pre>
        </>
      )}
      {tool?.output === undefined || tool.output === '' ? null : (
        <>
          <span className="ma-msg-kind">{t('transcript.output')}</span>
          <pre className="ma-pre">{tool.output}</pre>
        </>
      )}
      {message.paths === undefined || message.paths.length === 0 ? null : (
        <div className="ma-inline ma-inline--wrap">
          <span className="ma-msg-kind">{t('transcript.paths')}</span>
          {message.paths.map(path => (
            <span key={path} className="ma-mono ma-muted" title={path}>
              {shortenPath(path)}
            </span>
          ))}
        </div>
      )}
    </article>
  )
}
