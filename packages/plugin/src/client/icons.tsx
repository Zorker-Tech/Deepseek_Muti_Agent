/**
 * Inline SVG glyphs. Every mark is geometry only — no fills beyond `currentColor`,
 * no embedded artwork, no external asset — so the plugin inherits the host theme's
 * colour in both light and dark. The sidebar rows deliberately draw in a 36-unit
 * box so one definition scales from the rail to the panel.
 *
 * @module @zorker/muti-agent-plugin/client/icons
 */

import * as React from 'react'

/** Shared props for the sidebar row glyphs. */
export interface PanelGlyphProps {
  /** Requested square edge in pixels, supplied by the sidebar row. */
  readonly size: number
  /** Whether the addressed panel is selected; unused by geometry, kept for parity. */
  readonly active?: boolean
}

/** Props for the small inline marks. */
export interface IconProps {
  /** Square edge in pixels. */
  readonly size: number
}

/**
 * @param props - Mark props.
 * @returns The SVG root every glyph shares.
 */
function Glyph(props: {
  readonly size: number
  readonly filled?: boolean
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 36 36"
      width={props.size}
      height={props.size}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >
      <g
        fill={props.filled === true ? 'currentColor' : 'none'}
        stroke={props.filled === true ? 'none' : 'currentColor'}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {props.children}
      </g>
    </svg>
  )
}

/**
 * Sidebar row mark for the Agent Sessions browser: one session card behind two
 * others, the visible shorthand for "several agents' sessions in one place".
 *
 * @param props - Row geometry.
 * @returns The glyph.
 */
export function AgentsGlyph(props: PanelGlyphProps): React.ReactElement {
  return (
    <Glyph size={props.size}>
      <rect x="4" y="11" width="20" height="16" rx="4" />
      <path d="M11 11V8a4 4 0 0 1 4-4h13a4 4 0 0 1 4 4v13a4 4 0 0 1-4 4h-3" />
      <path d="M9 19h10" />
    </Glyph>
  )
}

/**
 * Sidebar row mark for the orchestration view: four worktrees wired into one
 * collaboration.
 *
 * @param props - Row geometry.
 * @returns The glyph.
 */
export function MeshGlyph(props: PanelGlyphProps): React.ReactElement {
  return (
    <Glyph size={props.size}>
      <path d="M10 10h16v16H10z" />
      <path d="M18 4v6M18 26v6M4 18h6M26 18h6" />
      <circle cx="18" cy="18" r="3.5" />
    </Glyph>
  )
}

/**
 * @param props - Mark size.
 * @returns A circular refresh arrow.
 */
export function RefreshGlyph(props: IconProps): React.ReactElement {
  return (
    <Glyph size={props.size}>
      <path d="M30 18a12 12 0 1 1-3.6-8.6" />
      <path d="M30 6v7h-7" />
    </Glyph>
  )
}

/**
 * @param props - Mark size.
 * @returns A disclosure chevron pointing right; callers rotate it for "open".
 */
export function ChevronGlyph(props: IconProps): React.ReactElement {
  return (
    <Glyph size={props.size}>
      <path d="M14 8l10 10-10 10" />
    </Glyph>
  )
}

/**
 * @param props - Mark size.
 * @returns A horizontal overflow mark.
 */
export function MoreGlyph(props: IconProps): React.ReactElement {
  return (
    <Glyph size={props.size} filled>
      <circle cx="10" cy="18" r="2.6" />
      <circle cx="18" cy="18" r="2.6" />
      <circle cx="26" cy="18" r="2.6" />
    </Glyph>
  )
}

/**
 * @param props - Mark size.
 * @returns Two stacked sheets, for a copy action.
 */
export function CopyGlyph(props: IconProps): React.ReactElement {
  return (
    <Glyph size={props.size}>
      <rect x="12" y="12" width="18" height="18" rx="4" />
      <path d="M22 12V8a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h4" />
    </Glyph>
  )
}

/**
 * @param props - Mark size.
 * @returns A cross, for dismissing a toast.
 */
export function CloseGlyph(props: IconProps): React.ReactElement {
  return (
    <Glyph size={props.size}>
      <path d="M10 10l16 16M26 10L10 26" />
    </Glyph>
  )
}

/**
 * The capabilities panel glyph: a layered stack, drawn with `currentColor` so the sidebar
 * tints it like the harness's own rows.
 *
 * @returns The glyph element.
 */
export function CapabilitiesGlyph(): React.ReactElement {
  return (
    <svg viewBox="0 0 36 36" width="18" height="18" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 13.5 18 8l9 5.5-9 5.5z" />
        <path d="M9 18.5 18 24l9-5.5" />
        <path d="M9 23.5 18 29l9-5.5" />
      </g>
    </svg>
  )
}
