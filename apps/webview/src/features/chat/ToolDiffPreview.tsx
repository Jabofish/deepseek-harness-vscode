import { useMemo, useState, type ReactElement } from 'react'
import type { ToolDiffRenderProps } from '@dsh-vscode/ui'
import { CopyButton } from './CopyButton.js'
import { useI18n } from '../../i18n.js'

const DEFAULT_MAX_LINES = 16

interface DiffRow {
  readonly kind: 'path' | 'del' | 'add' | 'gap'
  readonly text: string
}

interface DiffProjection {
  readonly rows: readonly DiffRow[]
  readonly added: number
  readonly removed: number
  readonly files: number
}

/**
 * Webview renderer for the shared structured diff contract. It follows DSH's
 * DiffBlock semantics: each hunk is kept in file order, a repeated path is
 * separated by a gap, and the body is capped by a head/tail fold while copy
 * still includes the complete projected diff.
 */
export function ToolDiffPreview(props: ToolDiffRenderProps): ReactElement {
  const { t: defaultTranslate } = useI18n()
  const translate = props.translate ?? defaultTranslate
  const projection = useMemo(() => projectDiffs(props.diffs), [props.diffs])
  const [expanded, setExpanded] = useState(false)

  if (projection.rows.length === 0) return <></>

  const hidden = Math.max(0, projection.rows.length - DEFAULT_MAX_LINES)
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(DEFAULT_MAX_LINES / 2)
  const tailLines = DEFAULT_MAX_LINES - headLines
  const head = capped ? projection.rows.slice(0, headLines) : projection.rows
  const tail = capped ? projection.rows.slice(projection.rows.length - tailLines) : []

  return (
    <div className="dsh-tool-diff-preview" data-diff="">
      <CopyButton
        text={copyText(projection.rows)}
        className="dsh-tool-diff-preview__copy"
        translate={translate}
      />
      <div className="dsh-tool-diff-preview__body">
        {head.map((row, index) => renderRow(row, index))}
        {hidden > 0 ? (
          <button
            type="button"
            className="dsh-tool-diff-preview__fold"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? translate('toolrow.presentation.collapseDiffLines')
                : translate('toolrow.presentation.expandDiffLines', { count: hidden })
            }
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? translate('toolrow.presentation.collapseDiffLines')
              : translate('toolrow.presentation.expandDiffLines', { count: hidden })}
          </button>
        ) : null}
        {tail.map((row, index) => renderRow(row, projection.rows.length - tailLines + index))}
      </div>
      <footer className="dsh-tool-diff-preview__footer">
        {translate('toolrow.presentation.diffSummary', {
          added: projection.added,
          removed: projection.removed,
          files: translate('toolrow.presentation.diffFiles', { count: projection.files }),
        })}
      </footer>
    </div>
  )
}

function renderRow(row: DiffRow, index: number): ReactElement {
  return (
    <div
      className={`dsh-tool-diff-preview__line dsh-tool-diff-preview__line--${row.kind}`}
      key={`${row.kind}:${index}:${row.text}`}
    >
      {row.kind === 'del' || row.kind === 'add' ? (
        <span className="dsh-tool-diff-preview__prefix" aria-hidden="true">
          {row.kind === 'del' ? '- ' : '+ '}
        </span>
      ) : null}
      <span>{row.text}</span>
    </div>
  )
}

function projectDiffs(diffs: ToolDiffRenderProps['diffs']): DiffProjection {
  const rows: DiffRow[] = []
  const paths = new Set<string>()
  let previousPath: string | undefined
  let added = 0
  let removed = 0

  for (const diff of diffs) {
    paths.add(diff.path)
    if (diff.path === previousPath) rows.push({ kind: 'gap', text: '⋯' })
    else rows.push({ kind: 'path', text: diff.path })
    previousPath = diff.path

    if (diff.oldText !== null) {
      const lines = contentLines(diff.oldText)
      removed += lines.length
      for (const text of lines) rows.push({ kind: 'del', text })
    }

    const lines = contentLines(diff.newText)
    added += lines.length
    for (const text of lines) rows.push({ kind: 'add', text })
  }

  return { rows, added, removed, files: paths.size }
}

function contentLines(text: string): readonly string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n?/gu, '\n')
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  return body.split('\n')
}

function copyText(rows: readonly DiffRow[]): string {
  return rows
    .map((row) => {
      if (row.kind === 'del') return `- ${row.text}`
      if (row.kind === 'add') return `+ ${row.text}`
      return row.text
    })
    .join('\n')
}
