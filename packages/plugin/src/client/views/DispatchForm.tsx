/**
 * The dispatch form: hand one task to one agent. It is opened from a session row
 * (pre-filled with that session's working directory and, on request, its native id
 * so the agent continues the same conversation) and from the mesh view.
 *
 * Dispatching goes through `runs.start`; MutiAgent launches the agent as a process
 * it manages, which is a different act from opening the agent's own TUI.
 *
 * @module @zorker/muti-agent-plugin/client/views/DispatchForm
 */

import * as React from 'react'
import type { RunRecord } from '@zorker/muti-agent-contracts'
import type { RpcClient } from '../api.ts'
import { toFailure, useT, type FailureInfo } from '../store.ts'
import { ErrorNotice } from '../components/DataTable.tsx'
import { notifyFailure, notifyInfo } from '../components/Toast.tsx'

/** One selectable agent. */
export interface DispatchAgentOption {
  /** Canonical agent id. */
  readonly agentId: string
  /** Human name. */
  readonly displayName: string
  /** Whether the agent is installed and usable here. */
  readonly installed: boolean
}

/** Props for {@link DispatchForm}. */
export interface DispatchFormProps {
  /** The wire client. */
  readonly api: RpcClient
  /** Agents that may receive the task. */
  readonly agents: readonly DispatchAgentOption[]
  /** Pre-filled working directory, usually the session's own. */
  readonly initialCwd?: string
  /** Pre-selected agent. */
  readonly initialAgentId?: string
  /** Pre-filled native session id, so the run resumes that conversation. */
  readonly initialNativeSessionId?: string
  /** Close the form without dispatching. */
  readonly onClose: () => void
  /**
   * @param run - The recorded run.
   */
  readonly onDispatched: (run: RunRecord) => void
}

/**
 * @param props - Agent list, pre-fill values and outcome handlers.
 * @returns The form, wrapped in a modal sheet.
 */
export function DispatchForm(props: DispatchFormProps): React.ReactElement {
  const t = useT()
  const { api, agents, initialCwd, initialAgentId, initialNativeSessionId } = props
  const usable = agents.filter(agent => agent.installed)
  const [agentId, setAgentId] = React.useState(
    initialAgentId ?? usable[0]?.agentId ?? agents[0]?.agentId ?? '',
  )
  const [prompt, setPrompt] = React.useState('')
  const [cwd, setCwd] = React.useState(initialCwd ?? '')
  const [resume, setResume] = React.useState(initialNativeSessionId ?? '')
  // Resuming a conversation in a fresh worktree would start the agent in a
  // directory that conversation never saw, so the defaults differ by intent.
  const [isolation, setIsolation] = React.useState<'worktree' | 'shared-cwd'>(
    initialNativeSessionId === undefined ? 'worktree' : 'shared-cwd',
  )
  const [model, setModel] = React.useState('')
  const [timeoutSeconds, setTimeoutSeconds] = React.useState('')
  const [failure, setFailure] = React.useState<FailureInfo | undefined>(undefined)
  const [hint, setHint] = React.useState<string | undefined>(undefined)
  const [busy, setBusy] = React.useState(false)

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    if (prompt.trim() === '') {
      // The submit stays live and explains itself; a disabled button with no reason
      // is the one interaction the UI never uses.
      setHint(t('dispatch.required'))
      return
    }
    setHint(undefined)
    setBusy(true)
    setFailure(undefined)
    const timeoutMs = Number.parseInt(timeoutSeconds, 10)
    void api
      .runsStart({
        agentId,
        prompt,
        ...(cwd.trim() === '' ? {} : { cwd: cwd.trim() }),
        ...(resume.trim() === '' ? {} : { resumeNativeId: resume.trim() }),
        isolation,
        ...(model.trim() === '' ? {} : { model: model.trim() }),
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: timeoutMs * 1000 } : {}),
      })
      .then(run => {
        notifyInfo(t('dispatch.dispatched', { id: String(run.id) }))
        props.onDispatched(run)
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

  return (
    <div className="ma-sheet" role="presentation">
      <form
        className="ma-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('dispatch.title')}
        onSubmit={submit}
      >
        <h2 className="ma-title">{t('dispatch.title')}</h2>
        {agents.length === 0 ? <p className="ma-muted">{t('dispatch.noAgents')}</p> : null}
        <div className="ma-form">
          <label className="ma-field">
            <span className="ma-field-label">{t('dispatch.agent')}</span>
            <select
              className="ma-select"
              value={agentId}
              onChange={event => {
                setAgentId(event.target.value)
              }}
            >
              {(usable.length === 0 ? agents : usable).map(agent => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="ma-field">
            <span className="ma-field-label">{t('dispatch.isolation')}</span>
            <select
              className="ma-select"
              value={isolation}
              onChange={event => {
                setIsolation(event.target.value === 'shared-cwd' ? 'shared-cwd' : 'worktree')
              }}
            >
              <option value="worktree">{t('dispatch.isolation.worktree')}</option>
              <option value="shared-cwd">{t('dispatch.isolation.shared')}</option>
            </select>
          </label>
          <label className="ma-field">
            <span className="ma-field-label">{t('dispatch.cwd')}</span>
            <input
              className="ma-input"
              type="text"
              value={cwd}
              spellCheck={false}
              onChange={event => {
                setCwd(event.target.value)
              }}
            />
          </label>
          <label className="ma-field">
            <span className="ma-field-label">{t('dispatch.resume')}</span>
            <input
              className="ma-input"
              type="text"
              value={resume}
              spellCheck={false}
              placeholder={t('dispatch.resumePlaceholder')}
              onChange={event => {
                setResume(event.target.value)
              }}
            />
          </label>
          <label className="ma-field">
            <span className="ma-field-label">{t('dispatch.model')}</span>
            <input
              className="ma-input"
              type="text"
              value={model}
              spellCheck={false}
              placeholder={t('dispatch.modelPlaceholder')}
              onChange={event => {
                setModel(event.target.value)
              }}
            />
          </label>
          <label className="ma-field">
            <span className="ma-field-label">{t('dispatch.timeout')}</span>
            <input
              className="ma-input"
              type="number"
              min={1}
              value={timeoutSeconds}
              onChange={event => {
                setTimeoutSeconds(event.target.value)
              }}
            />
          </label>
          <label className="ma-field ma-field--wide">
            <span className="ma-field-label">{t('dispatch.prompt')}</span>
            <textarea
              className="ma-textarea"
              value={prompt}
              placeholder={t('dispatch.promptPlaceholder')}
              onChange={event => {
                setPrompt(event.target.value)
                setHint(undefined)
              }}
            />
          </label>
        </div>
        {hint === undefined ? null : <p className="ma-muted">{hint}</p>}
        {failure === undefined ? null : <ErrorNotice failure={failure} />}
        <div className="ma-form-actions">
          <button type="button" className="ma-btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="ma-btn ma-btn--primary" disabled={busy || agentId === ''}>
            {t('dispatch.submit')}
          </button>
        </div>
      </form>
    </div>
  )
}
