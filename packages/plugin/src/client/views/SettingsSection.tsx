/**
 * The Agents settings section: credential state for every integrated agent and a
 * read-only diagnostic report.
 *
 * MutiAgent never stores a credential (ADR-0010): it asks each agent's own CLI to
 * sign in, passes an API key straight through on the child's stdin, and then re-reads
 * the state so what the user sees is what was **observed**, never what was intended.
 * When MutiAgent cannot manage a credential it says why instead of offering a button
 * that cannot work.
 *
 * @module @zorker/muti-agent-plugin/client/views/SettingsSection
 */

import * as React from 'react'
import type { AuthOperationResult, CredentialFlow } from '@zorker/muti-agent-contracts'
import type { CredentialRow, DiagnosticsReport, RpcClient } from '../api.ts'
import {
  authSource,
  authStatus,
  copyToClipboard,
  credentialFlow,
  relativeTime,
  shortenPath,
} from '../format.ts'
import { toFailure, useAsync, useT, type FailureInfo } from '../store.ts'
import { DataTable, ErrorNotice, type DataTableColumn } from '../components/DataTable.tsx'
import { StatusPill } from '../components/StatusPill.tsx'
import { notifyError, notifyInfo, notifyFailure } from '../components/Toast.tsx'
import { CopyGlyph } from '../icons.tsx'

/** Props for {@link SettingsSection}. */
export interface SettingsSectionProps {
  /** The wire client. */
  readonly api: RpcClient
}

/**
 * @param props - The wire client.
 * @returns The credentials and diagnostics sections.
 */
export function SettingsSection(props: SettingsSectionProps): React.ReactElement {
  const t = useT()
  const { api } = props
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<FailureInfo | undefined>(undefined)
  const [secretFor, setSecretFor] = React.useState<string | undefined>(undefined)
  const [secret, setSecret] = React.useState('')
  const [outcome, setOutcome] = React.useState<AuthOperationResult | undefined>(undefined)
  const [outcomeAgent, setOutcomeAgent] = React.useState<string | undefined>(undefined)

  const credentials = useAsync(signal => api.credentialsList({ signal }), 'credentials')
  const diagnostics = useAsync(signal => api.agentsDiagnostics({ signal }), 'diagnostics')

  const rows = credentials.state.status === 'ready' ? credentials.state.value : []

  /**
   * @param agentId - Agent to act on.
   * @param work - The operation.
   */
  const perform = (agentId: string, work: () => Promise<AuthOperationResult>): void => {
    setBusy(true)
    setFailure(undefined)
    void work()
      .then(result => {
        setOutcome(result)
        setOutcomeAgent(agentId)
        setSecret('')
        setSecretFor(undefined)
        // The observed post-state is the point: re-read rather than trust the intent.
        credentials.reload()
      })
      .catch((cause: unknown) => {
        const info = toFailure(cause)
        setFailure(info)
        notifyFailure(info)
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const signIn = (row: CredentialRow, flow: CredentialFlow, key?: string): void => {
    perform(row.agentId, () =>
      api.credentialsLogin({
        agentId: row.agentId,
        flow,
        ...(key === undefined ? {} : { secret: key }),
      }),
    )
  }

  const signOut = (row: CredentialRow): void => {
    const confirmed =
      typeof window === 'undefined' ||
      window.confirm(t('settings.logoutConfirm', { agent: row.displayName }))
    if (!confirmed) return
    perform(row.agentId, () => api.credentialsLogout({ agentId: row.agentId }))
  }

  const columns: readonly DataTableColumn<CredentialRow>[] = [
    {
      id: 'agent',
      label: t('settings.column.agent'),
      render: row => (
        <div className="ma-column">
          <span>{row.displayName}</span>
          {row.installed ? null : (
            <span className="ma-muted">
              {t('sessions.notInstalled', { reason: row.unmanageableReason ?? t('common.unknown') })}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'state',
      label: t('settings.column.state'),
      render: row => (
        <div className="ma-column">
          <StatusPill {...authStatus(row.state.status, t)} />
          {row.state.detail === undefined ? null : (
            <span className="ma-muted ma-truncate" title={row.state.detail}>
              {row.state.detail}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'account',
      label: t('settings.column.account'),
      render: row => (
        <div className="ma-column">
          <span>{row.state.account ?? t('common.none')}</span>
          {row.state.plan === undefined ? null : <span className="ma-muted">{row.state.plan}</span>}
        </div>
      ),
    },
    {
      id: 'credential',
      label: t('settings.column.credential'),
      render: row => (
        <div className="ma-column">
          <span className="ma-muted">
            {authSource(row.state.source, t)}
            {row.state.method === undefined ? '' : ` · ${row.state.method}`}
          </span>
          {row.state.credentialPath === undefined ? null : (
            <span className="ma-mono ma-muted ma-truncate" title={row.state.credentialPath}>
              {shortenPath(row.state.credentialPath, 3)}
            </span>
          )}
          {row.state.expiresAt === undefined ? null : (
            <span className="ma-muted">{relativeTime(row.state.expiresAt, t)}</span>
          )}
        </div>
      ),
    },
    {
      id: 'actions',
      label: t('settings.column.actions'),
      render: row => (
        <div className="ma-column">
          {row.manageable ? (
            <div className="ma-inline ma-inline--wrap">
              {row.flows.map(flow => (
                <FlowControl
                  key={flow}
                  flow={flow}
                  busy={busy}
                  secretOpen={secretFor === row.agentId}
                  secret={secret}
                  onSecretChange={setSecret}
                  onSignIn={() => {
                    if (flow === 'api-key') {
                      setSecretFor(row.agentId)
                      return
                    }
                    signIn(row, flow)
                  }}
                  onSubmitKey={() => {
                    signIn(row, 'api-key', secret)
                  }}
                />
              ))}
              {row.canLogout ? (
                <button
                  type="button"
                  className="ma-btn ma-btn--danger"
                  disabled={busy}
                  onClick={() => {
                    signOut(row)
                  }}
                >
                  {t('settings.signOut')}
                </button>
              ) : null}
            </div>
          ) : (
            <span className="ma-muted">{row.unmanageableReason ?? t('common.unknown')}</span>
          )}
          {outcomeAgent === row.agentId && outcome !== undefined ? (
            <LoginOutcome result={outcome} />
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <div className="ma-column">
      <h2 className="ma-title">{t('settings.panel')}</h2>
      {failure === undefined ? null : <ErrorNotice failure={failure} />}

      <section className="ma-card">
        <div className="ma-card-head">
          <h3 className="ma-card-title">{t('settings.credentials')}</h3>
        </div>
        <div className="ma-card-body">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={row => row.agentId}
            empty={t('settings.credentials.empty')}
            {...(credentials.state.status === 'error' ? { failure: credentials.state.error } : {})}
          />
        </div>
      </section>

      <section className="ma-card">
        <div className="ma-card-head">
          <h3 className="ma-card-title">{t('settings.diagnostics')}</h3>
        </div>
        <div className="ma-card-body">
          {diagnostics.state.status === 'error' ? (
            <ErrorNotice failure={diagnostics.state.error} />
          ) : diagnostics.state.status === 'ready' ? (
            <Diagnostics report={diagnostics.state.value} />
          ) : (
            <p className="ma-muted">{t('common.loading')}</p>
          )}
        </div>
      </section>
    </div>
  )
}

/** Props for one credential-flow control. */
interface FlowControlProps {
  readonly flow: CredentialFlow
  readonly busy: boolean
  /** Whether this row's API-key field is revealed. */
  readonly secretOpen: boolean
  readonly secret: string
  readonly onSecretChange: (value: string) => void
  readonly onSignIn: () => void
  readonly onSubmitKey: () => void
}

/**
 * One declared flow, rendered as the control it can actually be: an interactive flow
 * is a disabled explanation, never a dead button.
 *
 * @param props - The flow and its handlers.
 * @returns The control.
 */
function FlowControl(props: FlowControlProps): React.ReactElement {
  const t = useT()
  if (props.flow === 'interactive') {
    return (
      <span className="ma-inline" title={t('settings.flow.interactiveHint')}>
        <button type="button" className="ma-btn" disabled>
          {t('settings.flow.interactive')}
        </button>
        <span className="ma-muted">{t('settings.flow.interactiveHint')}</span>
      </span>
    )
  }
  if (props.flow === 'api-key') {
    return props.secretOpen ? (
      <span className="ma-inline">
        <input
          className="ma-input"
          type="password"
          value={props.secret}
          placeholder={t('settings.apiKey')}
          aria-label={t('settings.apiKey')}
          onChange={event => {
            props.onSecretChange(event.target.value)
          }}
        />
        <button
          type="button"
          className="ma-btn ma-btn--primary"
          disabled={props.busy || props.secret === ''}
          onClick={props.onSubmitKey}
        >
          {t('settings.apiKeySubmit')}
        </button>
      </span>
    ) : (
      <button type="button" className="ma-btn" disabled={props.busy} onClick={props.onSignIn}>
        {credentialFlow('api-key', t)}
      </button>
    )
  }
  return (
    <button type="button" className="ma-btn" disabled={props.busy} onClick={props.onSignIn}>
      {credentialFlow(props.flow, t)}
    </button>
  )
}

/**
 * @param props - The login result as the host observed it.
 * @returns The interaction block, when the flow needs a human step, and the observed state.
 */
function LoginOutcome(props: { readonly result: AuthOperationResult }): React.ReactElement {
  const t = useT()
  const { result } = props
  const interaction = result.interaction
  return (
    <div className="ma-error">
      <span className="ma-error-message">
        {t('settings.observed', { status: authStatus(result.state.status, t).label })}
      </span>
      {interaction === undefined ? null : (
        <>
          {interaction.url === undefined ? null : (
            <a className="ma-link" href={interaction.url} target="_blank" rel="noreferrer noopener">
              {t('settings.login.link')}
            </a>
          )}
          {interaction.code === undefined ? null : (
            <span className="ma-inline">
              <span className="ma-field-label">{t('settings.login.code')}</span>
              <span className="ma-code">{interaction.code}</span>
              <button
                type="button"
                className="ma-btn ma-btn--icon"
                title={t('common.copy')}
                aria-label={t('common.copy')}
                onClick={() => {
                  void copyToClipboard(interaction.code ?? '').then(copied => {
                    if (copied) notifyInfo(t('common.copied'))
                    else notifyError(t('common.copyFailed'))
                  })
                }}
              >
                <CopyGlyph size={13} />
              </button>
            </span>
          )}
          {interaction.instructions === undefined ? null : (
            <span className="ma-error-message">
              {t('settings.login.instructions')}: {interaction.instructions}
            </span>
          )}
        </>
      )}
      {result.state.detail === undefined ? null : (
        <span className="ma-error-message ma-muted">{result.state.detail}</span>
      )}
    </div>
  )
}

/**
 * @param props - The diagnostics report.
 * @returns The read-only definition list and per-agent table.
 */
function Diagnostics(props: { readonly report: DiagnosticsReport }): React.ReactElement {
  const t = useT()
  const { report } = props
  return (
    <div className="ma-column">
      <dl className="ma-dl">
        <dt>{t('settings.stateDir')}</dt>
        <dd className="ma-mono">{report.stateDir}</dd>
        <dt>{t('settings.isolation')}</dt>
        <dd>
          {report.isolation === 'worktree'
            ? t('settings.isolation.worktree')
            : t('settings.isolation.shared-disabled')}
        </dd>
        <dt>{t('settings.pluginVersion')}</dt>
        <dd>{report.pluginVersion}</dd>
        <dt>{t('settings.harnessSeams')}</dt>
        <dd>{report.harness.services.length === 0 ? t('common.none') : report.harness.services.join(', ')}</dd>
        <dt>{t('settings.missingSeams')}</dt>
        <dd>
          {report.harness.missing.length === 0
            ? t('common.none')
            : report.harness.missing
                .map(missing => `${missing.service} — ${missing.disables}`)
                .join('; ')}
        </dd>
        <dt>{t('settings.warnings')}</dt>
        <dd>{report.warnings.length === 0 ? t('common.none') : report.warnings.join('; ')}</dd>
      </dl>
      <DataTable
        columns={[
          { id: 'agent', label: t('settings.column.agent'), render: agent => agent.displayName },
          {
            id: 'installed',
            label: t('settings.column.installed'),
            render: agent =>
              agent.installed ? (
                <StatusPill tone="ok" label={t('common.yes')} />
              ) : (
                <StatusPill tone="warn" label={t('common.no')} />
              ),
          },
          {
            id: 'version',
            label: t('settings.column.version'),
            render: agent => agent.version ?? t('common.unknown'),
          },
          {
            id: 'path',
            label: t('settings.column.path'),
            render: agent =>
              agent.binaryPath === undefined ? (
                <span className="ma-muted">{agent.reason ?? t('common.unknown')}</span>
              ) : (
                <span className="ma-mono ma-truncate" title={agent.binaryPath}>
                  {shortenPath(agent.binaryPath, 3)}
                </span>
              ),
          },
          {
            id: 'transports',
            label: t('settings.column.transports'),
            render: agent =>
              agent.transports
                .map(transport => `${transport.mode} (${transport.available ? '✓' : '×'})`)
                .join(', '),
          },
        ]}
        rows={report.agents}
        rowKey={agent => agent.agentId}
        empty={t('settings.credentials.empty')}
      />
    </div>
  )
}
