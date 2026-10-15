/**
 * The plugin's entire visual layer: one stylesheet, injected once per load as a
 * single `<style data-plugin="mutiagent">` element (ADR-0005 §6). There is no CSS
 * file and no bundler CSS pipeline.
 *
 * Every colour, radius, elevation and type role comes from the harness's `--dsw-*`
 * custom properties, so the plugin follows the user's light/dark choice and the
 * unified radius scale with no theme selector of its own. Fallbacks are inline in
 * the `var()` calls so the plugin still looks deliberate if a token is absent.
 *
 * @module @zorker/muti-agent-plugin/client/styles
 */

/** Page frame, headers and the scrolling body shared by both panels. */
export const LAYOUT_CSS = `
.ma-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-s-14, 14px/1.5 system-ui, sans-serif);
  background: var(--dsw-alias-bg-base, transparent);
}
.ma-head {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgb(128 128 128 / 0.25));
}
.ma-title { margin: 0; font: var(--dsw-font-m-18, 600 18px/1.4 system-ui, sans-serif); }
.ma-sub { color: var(--dsw-alias-label-tertiary, inherit); font: var(--dsw-font-xs-13, 13px/1.5 system-ui, sans-serif); }
.ma-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ma-inline { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ma-inline--wrap { flex-wrap: wrap; }
.ma-inline--start { align-items: flex-start; }
.ma-column { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ma-spacer { flex: 1 1 auto; }
.ma-muted { color: var(--dsw-alias-label-tertiary, inherit); }
/* The composer agent switcher. Metrics and tokens copied from the harness's own
   access-mode trigger so the tool row reads as one set of controls. */
.ma-agent-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 200px;
  height: 28px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
}

.ma-agent-trigger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.ma-agent-trigger:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}

.ma-agent-trigger:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}

.ma-agent-dot {
  display: inline-flex;
  flex: 0 0 auto;
}

.ma-agent-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ma-agent-chevron {
  display: inline-flex;
  flex: 0 0 auto;
  transition: transform 120ms ease;
}

.ma-agent-chevron--open {
  transform: rotate(180deg);
}

.ma-agent-option {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.ma-agent-option-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ma-agent-option-status {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-size: 11px;
}

.ma-run-status {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ma-run-reason {
  display: block;
  max-width: 32ch;
  overflow: hidden;
  color: var(--dsw-alias-text-secondary, #6b7280);
  font-size: var(--dsw-font-size-xs, 11px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ma-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.ma-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ma-link {
  color: var(--dsw-alias-link, var(--dsw-alias-brand-primary, currentColor));
  font-weight: 500;
  text-decoration: none;
}
.ma-link:hover, .ma-link:focus-visible {
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}
`

/** Buttons, inputs and the small inline controls. */
export const CONTROL_CSS = `
.ma-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgb(128 128 128 / 0.3));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-button-ghost-active-fill, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-xs-13, 13px/1.4 system-ui, sans-serif);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease;
}
.ma-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgb(128 128 128 / 0.12)); }
.ma-btn:disabled { opacity: 0.5; cursor: default; }
.ma-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, rgb(64 120 220)));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.ma-btn--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, rgb(64 120 220)));
}
.ma-btn--quiet { border-color: transparent; background: transparent; }
.ma-btn--icon { width: 28px; padding: 0; }
.ma-btn--danger { color: var(--dsw-alias-state-error-primary, #d0483a); }
.ma-input, .ma-select, .ma-textarea {
  height: 32px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgb(128 128 128 / 0.3));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-xs-13, 13px/1.4 system-ui, sans-serif);
  min-width: 0;
}
.ma-input { min-width: 180px; }
.ma-textarea {
  height: auto;
  min-height: 84px;
  padding: 8px 10px;
  resize: vertical;
  font: var(--dsw-font-s-14, 14px/1.5 system-ui, sans-serif);
}
.ma-input:focus-visible, .ma-select:focus-visible, .ma-textarea:focus-visible, .ma-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, currentColor);
  outline-offset: 1px;
}
.ma-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ma-field--wide { grid-column: 1 / -1; }
.ma-field-label { color: var(--dsw-alias-label-tertiary, inherit); font: var(--dsw-font-xxxs-11, 11px/1.4 system-ui, sans-serif); }
.ma-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.ma-form-actions { display: flex; gap: 8px; justify-content: flex-end; grid-column: 1 / -1; }
`

/** Partitions, cards, tables and the pills that annotate them. */
export const SURFACE_CSS = `
.ma-partition {
  border: 0.5px solid var(--dsw-alias-border-l2, rgb(128 128 128 / 0.22));
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  overflow: hidden;
}
.ma-partition-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  font: var(--dsw-font-s-strong-14, 600 14px/1.5 system-ui, sans-serif);
  cursor: pointer;
}
.ma-partition-head:hover { background: var(--dsw-alias-interactive-bg-hover, rgb(128 128 128 / 0.12)); }
.ma-partition-body { display: flex; flex-direction: column; border-top: 0.5px solid var(--dsw-alias-border-l2, rgb(128 128 128 / 0.22)); }
.ma-chevron { color: var(--dsw-alias-label-tertiary, inherit); transition: transform 0.15s ease; }
.ma-chevron--open { transform: rotate(90deg); }
.ma-card {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3, rgb(128 128 128 / 0.3)));
  border-radius: var(--dsw-radius-xl, 20px);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent));
  overflow: hidden;
}
.ma-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgb(128 128 128 / 0.22));
}
.ma-card-title { margin: 0; font: var(--dsw-font-s-strong-14, 600 14px/1.5 system-ui, sans-serif); }
.ma-card-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.ma-table { width: 100%; border-collapse: collapse; font: var(--dsw-font-xs-13, 13px/1.5 system-ui, sans-serif); }
.ma-table th {
  padding: 6px 10px;
  text-align: left;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxxs-strong-11, 600 11px/1.5 system-ui, sans-serif);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgb(128 128 128 / 0.22));
}
.ma-table td {
  padding: 8px 10px;
  vertical-align: middle;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgb(128 128 128 / 0.16));
}
.ma-table tbody tr:last-child td { border-bottom: 0; }
.ma-align-end { text-align: right; }
.ma-pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgb(128 128 128 / 0.3));
  border-radius: 999px;
  corner-shape: round;
  font: var(--dsw-font-xxxs-11, 11px/1.4 system-ui, sans-serif);
  white-space: nowrap;
}
.ma-pill--ok { color: var(--dsw-alias-state-success-primary, #2f9e63); }
.ma-pill--warn { color: var(--dsw-alias-state-warn-primary, #c8871a); }
.ma-pill--error { color: var(--dsw-alias-state-error-primary, #d0483a); }
.ma-pill--accent { color: var(--dsw-alias-brand-primary, #4078dc); }
.ma-pill--idle { color: var(--dsw-alias-label-tertiary, inherit); }
.ma-error {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgb(128 128 128 / 0.22));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.ma-error-code { color: var(--dsw-alias-state-error-primary, #d0483a); font: var(--dsw-font-xxxs-strong-11, 600 11px/1.5 system-ui, sans-serif); }
.ma-error-message { color: var(--dsw-alias-label-secondary, inherit); }
.ma-dl {
  display: grid;
  grid-template-columns: minmax(140px, max-content) minmax(0, 1fr);
  gap: 6px 14px;
  align-items: start;
  margin: 0;
  font: var(--dsw-font-xs-13, 13px/1.5 system-ui, sans-serif);
}
.ma-dl dt { color: var(--dsw-alias-label-tertiary, inherit); }
.ma-dl dd { margin: 0; overflow-wrap: anywhere; }
.ma-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
`

/** Sessions and transcript rows. */
export const SESSION_CSS = `
.ma-session {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgb(128 128 128 / 0.16));
}
.ma-session:first-child { border-top: 0; }
.ma-session-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ma-session-title { font: var(--dsw-font-s-strong-14, 600 14px/1.5 system-ui, sans-serif); }
.ma-session-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxs-12, 12px/1.5 system-ui, sans-serif);
}
.ma-menu-wrap { position: relative; flex: none; }
.ma-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 30;
  min-width: 200px;
  padding: 4px;
  border: 0;
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-overlay, #fff));
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgb(0 0 0 / 0.18));
}
.ma-menu-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  text-align: left;
  font: var(--dsw-font-xs-13, 13px/1.5 system-ui, sans-serif);
  cursor: pointer;
}
.ma-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgb(128 128 128 / 0.12)); }
.ma-menu-item:disabled { opacity: 0.5; cursor: default; }
.ma-menu-item--danger { color: var(--dsw-alias-state-error-primary, #d0483a); }
.ma-note {
  padding: 8px 12px;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: var(--dsw-font-xxs-12, 12px/1.5 system-ui, sans-serif);
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgb(128 128 128 / 0.16));
}
.ma-msg {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgb(128 128 128 / 0.16));
}
.ma-msg:first-child { border-top: 0; }
.ma-msg-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--dsw-font-markdown-base, 14px/1.6 system-ui, sans-serif); }
.ma-msg-kind { font: var(--dsw-font-xxxs-strong-11, 600 11px/1.5 system-ui, sans-serif); color: var(--dsw-alias-label-tertiary, inherit); }
.ma-pre {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-1, rgb(128 128 128 / 0.08)));
  font: var(--dsw-font-markdown-code-block-small, 12px/1.5 monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 260px;
  overflow: auto;
}
.ma-code {
  font: var(--dsw-font-l-20, 500 20px/1.4 system-ui, sans-serif);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  letter-spacing: 0.08em;
}
.ma-sheet {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 0.32));
}
.ma-dialog {
  width: min(680px, 94vw);
  max-height: 86vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 0;
  border-radius: var(--dsw-radius-panel, 28px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #fff));
  box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgb(0 0 0 / 0.24));
}
`

/** The toast stack that keeps failed operations visible after a panel closes. */
export const TOAST_CSS = `
.ma-toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(420px, calc(100vw - 32px));
  pointer-events: none;
}
.ma-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-toast-bg, var(--dsw-alias-bg-layer-3, #fff));
  color: var(--dsw-alias-toast-label, var(--dsw-alias-label-primary, inherit));
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgb(0 0 0 / 0.2));
  font: var(--dsw-font-xs-13, 13px/1.5 system-ui, sans-serif);
}
.ma-toast--error { color: var(--dsw-alias-state-error-primary, #d0483a); }
.ma-toast-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) {
  .ma-btn, .ma-chevron, .ma-toast { transition: none; }
}
`

/** The complete sheet, in source order. */
export const SHEET = [LAYOUT_CSS, CONTROL_CSS, SURFACE_CSS, SESSION_CSS, TOAST_CSS].join('\n')

/** The attribute that marks the plugin's single stylesheet element. */
const STYLE_MARKER = 'mutiagent'

/**
 * Inject the stylesheet once per document.
 *
 * @returns A disposer that removes the element; a no-op when another instance of
 *   this plugin already owns the sheet (its own disposer removes it).
 */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin="${STYLE_MARKER}"]`) !== null) return () => {}
  const element = document.createElement('style')
  element.setAttribute('data-plugin', STYLE_MARKER)
  element.textContent = SHEET
  document.head.append(element)
  return () => {
    element.remove()
  }
}
