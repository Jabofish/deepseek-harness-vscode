import { useState, type ReactElement } from 'react'
import type { ToolSearchRenderProps } from '@dsh-vscode/ui'
import { CopyButton } from './CopyButton.js'
import { useI18n } from '../../i18n.js'

type SearchView = ToolSearchRenderProps['view']

type SearchRow =
  | {
      readonly type: 'file'
      readonly path: string
      readonly count: number
      readonly index: number
      readonly collapsed: boolean
    }
  | {
      readonly type: 'match'
      readonly lineNumber: number
      readonly line: string
      readonly key: string
      readonly fileIndex: number
    }
  | { readonly type: 'path'; readonly path: string }

/**
 * Webview renderer for the two structured DSH search result shapes. It keeps
 * file attribution when the result fold cuts through a match group, and the
 * copy action always includes the complete retained result rather than only
 * the currently visible rows.
 */
export function ToolSearchPreview(props: ToolSearchRenderProps): ReactElement {
  const { t: defaultTranslate } = useI18n()
  const translate = props.translate ?? defaultTranslate
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())
  const rows = toRows(props.view, collapsed)
  const shown = shownCount(props.view)
  const empty = rows.length === 0
  const toggleFile = (index: number): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="dsh-tool-search-preview" data-search={props.view.shape}>
      <div className="dsh-tool-search-preview__header">
        <span className="dsh-tool-search-preview__summary">{summaryText(props.view, shown, translate)}</span>
        {empty ? null : (
          <CopyButton
            text={copyText(props.view)}
            className="dsh-tool-search-preview__copy"
            translate={translate}
          />
        )}
      </div>
      {empty ? (
        <div className="dsh-tool-search-preview__empty">{translate('toolrow.presentation.noResults')}</div>
      ) : (
        <div className="dsh-tool-search-preview__body" tabIndex={0}>
          {rows.map((row) => (
            <div key={rowKey(row)}>{renderRow(row, toggleFile)}</div>
          ))}
        </div>
      )}
      {props.recovery === undefined ? null : (
        <div className="dsh-tool-search-preview__recovery">{props.recovery}</div>
      )}
    </div>
  )
}

function renderRow(row: SearchRow, toggleFile: (index: number) => void): ReactElement {
  if (row.type === 'path') return <div className="dsh-tool-search-preview__line">{row.path}</div>
  if (row.type === 'match') {
    return (
      <div className="dsh-tool-search-preview__line">
        <span className="dsh-tool-search-preview__line-number">{row.lineNumber}: </span>
        {row.line}
      </div>
    )
  }
  return (
    <button
      type="button"
      className="dsh-tool-search-preview__file-header"
      aria-expanded={!row.collapsed}
      onClick={() => toggleFile(row.index)}
    >
      <span className="dsh-tool-search-preview__file-path">{row.path}</span>
      <span className="dsh-tool-search-preview__file-count">{row.count}</span>
    </button>
  )
}

function toRows(view: SearchView, collapsed: ReadonlySet<number>): SearchRow[] {
  if (view.shape === 'paths') return view.paths.map((path) => ({ type: 'path', path }))
  const rows: SearchRow[] = []
  view.files.forEach((file, fileIndex) => {
    const isCollapsed = collapsed.has(fileIndex)
    rows.push({
      type: 'file',
      path: file.path,
      count: file.matches.length,
      index: fileIndex,
      collapsed: isCollapsed,
    })
    if (isCollapsed) return
    file.matches.forEach((match, matchIndex) => {
      rows.push({
        type: 'match',
        lineNumber: match.lineNumber,
        line: match.line,
        key: `${fileIndex}:${match.lineNumber}:${matchIndex}`,
        fileIndex,
      })
    })
  })
  return rows
}

function shownCount(view: SearchView): number {
  return view.shape === 'paths'
    ? view.paths.length
    : view.files.reduce((sum, file) => sum + file.matches.length, 0)
}

function summaryText(
  view: SearchView,
  shown: number,
  translate: NonNullable<ToolSearchRenderProps['translate']>,
): string {
  if (view.shape === 'paths')
    return translate(
      view.truncated ? 'toolrow.presentation.searchPathsSummary' : 'toolrow.presentation.searchPathsCount',
      {
        shown,
        total: view.total,
      },
    )
  return translate(
    view.truncated ? 'toolrow.presentation.searchMatchesSummary' : 'toolrow.presentation.searchMatchesCount',
    {
      shown,
      total: view.total,
      files: view.files.length,
    },
  )
}

function copyText(view: SearchView): string {
  if (view.shape === 'paths') return view.paths.join('\n')
  return view.files
    .map((file) =>
      [file.path, ...file.matches.map((match) => `${match.lineNumber}: ${match.line}`)].join('\n'),
    )
    .join('\n\n')
}

function rowKey(row: SearchRow): string {
  if (row.type === 'match') return `match:${row.key}`
  if (row.type === 'file') return `file:${row.index}`
  return `path:${row.path}`
}
