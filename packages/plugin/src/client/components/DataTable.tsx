/**
 * A small table primitive: ordered columns, explicit empty and failure states.
 *
 * A failed read always renders an inline error row carrying the code, the host's
 * message and the remediation, because a blank panel is indistinguishable from "no
 * data" and hides the one thing the user needs.
 *
 * @module @zorker/muti-agent-plugin/client/components/DataTable
 */

import * as React from 'react'
import type { FailureInfo } from '../store.ts'
import { useT } from '../store.ts'

/** One column of a {@link DataTable}. */
export interface DataTableColumn<T> {
  /** Stable column id, used as the React key. */
  readonly id: string
  /** Localized header text. */
  readonly label: string
  /** Alignment of the header and its cells. */
  readonly align?: 'start' | 'end'
  /**
   * @param row - The row to render.
   * @returns The cell content.
   */
  readonly render: (row: T) => React.ReactNode
}

/** Props for {@link DataTable}. */
export interface DataTableProps<T> {
  /** Columns, left to right. */
  readonly columns: readonly DataTableColumn<T>[]
  /** Rows to show; ignored when `failure` is set. */
  readonly rows: readonly T[]
  /**
   * @param row - A row.
   * @returns A stable key.
   */
  readonly rowKey: (row: T) => string
  /** Rendered in a full-width row when there is nothing to show. */
  readonly empty: React.ReactNode
  /** The read's failure, when it failed. */
  readonly failure?: FailureInfo
}

/**
 * @param props - The failure.
 * @returns The inline failure block.
 */
export function ErrorNotice(props: { readonly failure: FailureInfo }): React.ReactElement {
  const t = useT()
  return (
    <div className="ma-error" role="alert">
      <span className="ma-error-code">{t('common.errorCode', { code: props.failure.code })}</span>
      <span className="ma-error-message">{props.failure.message}</span>
      {props.failure.remediation === undefined ? null : (
        <span className="ma-error-message ma-muted">
          {t('common.remediation', { text: props.failure.remediation })}
        </span>
      )}
    </div>
  )
}

/**
 * @typeParam T - Row type.
 * @param props - Columns, rows, and the two terminal states.
 * @returns The table.
 */
export function DataTable<T>(props: DataTableProps<T>): React.ReactElement {
  const { columns, rows, rowKey, empty, failure } = props
  const span = columns.length
  return (
    <table className="ma-table">
      <thead>
        <tr>
          {columns.map(column => (
            <th
              key={column.id}
              scope="col"
              className={column.align === 'end' ? 'ma-align-end' : undefined}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {failure !== undefined ? (
          <tr>
            <td colSpan={span}>
              <ErrorNotice failure={failure} />
            </td>
          </tr>
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={span} className="ma-muted">
              {empty}
            </td>
          </tr>
        ) : (
          rows.map(row => (
            <tr key={rowKey(row)}>
              {columns.map(column => (
                <td key={column.id} className={column.align === 'end' ? 'ma-align-end' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}
