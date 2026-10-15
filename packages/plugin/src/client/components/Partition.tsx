/**
 * A collapsible section: the partition header for one agent's sessions. Its own
 * open state lives with the caller, so the state survives a view switch.
 *
 * @module @zorker/muti-agent-plugin/client/components/Partition
 */

import * as React from 'react'
import { ChevronGlyph } from '../icons.tsx'

/** Props for {@link Partition}. */
export interface PartitionProps {
  /** Section heading, e.g. the agent's display name. */
  readonly title: string
  /** Optional badge rendered beside the heading (installed / not installed). */
  readonly badge?: React.ReactNode
  /** Pre-formatted count, e.g. `12 sessions`. */
  readonly count: string
  /** Why the partition is empty, when it is. Host-supplied text. */
  readonly note?: string
  /** Whether the body is expanded. */
  readonly open: boolean
  /** Toggle the body. */
  readonly onToggle: () => void
  /** The partition's rows. */
  readonly children: React.ReactNode
}

/**
 * @param props - Heading, count, open state and rows.
 * @returns The section.
 */
export function Partition(props: PartitionProps): React.ReactElement {
  const bodyId = React.useId()
  return (
    <section className="ma-partition">
      <button
        type="button"
        className="ma-partition-head"
        aria-expanded={props.open}
        aria-controls={bodyId}
        onClick={props.onToggle}
      >
        <span className={props.open ? 'ma-chevron ma-chevron--open' : 'ma-chevron'}>
          <ChevronGlyph size={12} />
        </span>
        <span className="ma-truncate">{props.title}</span>
        {props.badge}
        <span className="ma-spacer" />
        <span className="ma-muted ma-truncate">{props.count}</span>
      </button>
      {props.open ? (
        <div className="ma-partition-body" id={bodyId}>
          {props.note === undefined ? null : <p className="ma-note">{props.note}</p>}
          {props.children}
        </div>
      ) : null}
    </section>
  )
}
