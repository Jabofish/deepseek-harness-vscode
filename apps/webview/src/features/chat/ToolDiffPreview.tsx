import { useMemo, type ReactElement } from 'react'
import type { ToolDiffRenderProps } from '@dsh-vscode/ui'
import { CopyButton } from './CopyButton.js'
import { useI18n } from '../../i18n.js'

interface DiffRow {
  readonly kind: 'path' | 'ctx' | 'del' | 'add' | 'gap'
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
 * separated by a gap, and every supplied diff line is shown when the tool
 * disclosure is open. Copy includes the same complete diff.
 */
export function ToolDiffPreview(props: ToolDiffRenderProps): ReactElement {
  const { t: defaultTranslate } = useI18n()
  const translate = props.translate ?? defaultTranslate
  const projection = useMemo(() => projectDiffs(props.diffs), [props.diffs])

  if (projection.rows.length === 0) return <></>

  return (
    <div className="dsh-tool-diff-preview" data-diff="">
      <div className="dsh-tool-diff-preview__header">
        <span>{translate('toolrow.presentation.diffFiles', { count: projection.files })}</span>
        <CopyButton
          text={copyText(projection.rows)}
          className="dsh-tool-diff-preview__copy"
          translate={translate}
        />
      </div>
      <div className="dsh-tool-diff-preview__body" tabIndex={0}>
        <div className="dsh-tool-diff-preview__content">
          {projection.rows.map((row, index) => renderRow(row, index))}
        </div>
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
      {row.kind === 'del' || row.kind === 'add' || row.kind === 'ctx' ? (
        <span className="dsh-tool-diff-preview__prefix" aria-hidden="true">
          {row.kind === 'del' ? '- ' : row.kind === 'add' ? '+ ' : '  '}
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

    const before = diff.oldText === null ? [] : contentLines(diff.oldText)
    const after = contentLines(diff.newText)
    for (const entry of computeLineDiff(before, after)) {
      rows.push(entry)
      if (entry.kind === 'add') added += 1
      else if (entry.kind === 'del') removed += 1
    }
  }

  return { rows, added, removed, files: paths.size }
}

const MAX_LCS_CELLS = 62_500

function computeLineDiff(before: readonly string[], after: readonly string[]): readonly DiffRow[] {
  if (before.length === 0) return after.map((text) => ({ kind: 'add', text }))
  if (after.length === 0) return before.map((text) => ({ kind: 'del', text }))

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1

  const midBefore = before.slice(prefix, before.length - suffix)
  const midAfter = after.slice(prefix, after.length - suffix)
  const middle: DiffRow[] = []

  if (midBefore.length === 0 || midAfter.length === 0 || midBefore.length * midAfter.length > MAX_LCS_CELLS) {
    for (const text of midBefore) middle.push({ kind: 'del', text })
    for (const text of midAfter) middle.push({ kind: 'add', text })
  } else {
    const rows = midBefore.length
    const cols = midAfter.length
    const dp = new Uint32Array((rows + 1) * (cols + 1))
    const stride = cols + 1
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = cols - 1; j >= 0; j -= 1) {
        dp[i * stride + j] =
          midBefore[i] === midAfter[j]
            ? dp[(i + 1) * stride + (j + 1)]! + 1
            : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + (j + 1)]!)
      }
    }
    let i = 0
    let j = 0
    while (i < rows && j < cols) {
      if (midBefore[i] === midAfter[j]) {
        middle.push({ kind: 'ctx', text: midBefore[i]! })
        i += 1
        j += 1
      } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + (j + 1)]!) {
        middle.push({ kind: 'del', text: midBefore[i]! })
        i += 1
      } else {
        middle.push({ kind: 'add', text: midAfter[j]! })
        j += 1
      }
    }
    while (i < rows) middle.push({ kind: 'del', text: midBefore[i++]! })
    while (j < cols) middle.push({ kind: 'add', text: midAfter[j++]! })
  }

  return [
    ...before.slice(0, prefix).map((text): DiffRow => ({ kind: 'ctx', text })),
    ...middle,
    ...before.slice(before.length - suffix).map((text): DiffRow => ({ kind: 'ctx', text })),
  ]
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
      if (row.kind === 'ctx') return `  ${row.text}`
      return row.text
    })
    .join('\n')
}
