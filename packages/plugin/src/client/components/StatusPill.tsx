/**
 * A status pill: one tone, one localized label, no colour decisions at the call
 * site. Tones are the semantic `--dsw-alias-state-*` family, never literal colours.
 *
 * @module @zorker/muti-agent-plugin/client/components/StatusPill
 */

import * as React from 'react'
import type { Tone } from '../format.ts'

/** Props for {@link StatusPill}. */
export interface StatusPillProps {
  /** Which semantic tone to paint. */
  readonly tone: Tone
  /** Localized status text. */
  readonly label: string
  /** Optional explanation, shown as the native tooltip. */
  readonly title?: string
}

/**
 * @param props - Tone and label.
 * @returns The pill.
 */
export function StatusPill(props: StatusPillProps): React.ReactElement {
  return (
    <span
      className={`ma-pill ma-pill--${props.tone}`}
      {...(props.title === undefined ? {} : { title: props.title })}
    >
      {props.label}
    </span>
  )
}
