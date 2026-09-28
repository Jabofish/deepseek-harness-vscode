import { Fragment, type ReactElement } from 'react'
import type {
  ToolPresentationDiff,
  ToolPresentationLine,
  ToolPresentationSource,
  ToolPresentationView,
} from '@dsh-vscode/domain'

import { formatToolText, type PresentationTranslate, type ToolDetailBlock } from './tool-presentation.js'
import { label, searchTotal } from './tool-row-text.js'

/** Host-surface renderer for a structured read window. The shared package
 * keeps a plaintext fallback; a Webview may add syntax highlighting and
 * bounded code controls without making this package depend on Shiki. */
export interface ToolCodeRenderProps {
  readonly lines: readonly ToolPresentationLine[]
  readonly language?: string
  readonly totalLines: number
  readonly translate?: PresentationTranslate
}

/** Host-surface renderer for a structured diff card. The shared package keeps
 * a bounded plaintext fallback; a Webview may add copy, folding, and the
 * upstream diff summary without making this package depend on browser APIs. */
export interface ToolDiffRenderProps {
  readonly diffs: readonly ToolPresentationDiff[]
  readonly translate?: PresentationTranslate
}

/** Host-surface renderer for a structured terminal result. ANSI/TUI parsing is
 * deliberately outside this shared boundary; a Webview may add safe output
 * controls while preserving the raw validated result text. */
export interface ToolTerminalRenderProps {
  readonly view: Extract<ToolPresentationView, { readonly card: 'terminal'; readonly phase: 'result' }>
  readonly translate?: PresentationTranslate
}

/** Host-surface renderer for a structured search result. Both upstream
 * matches-by-file and flat-path shapes remain available to the Webview; the
 * shared package keeps its existing bounded fallback. */
export interface ToolSearchRenderProps {
  readonly view: Extract<ToolPresentationView, { readonly card: 'search'; readonly phase: 'result' }>
  readonly translate?: PresentationTranslate
  /**
   * The settled raw result text, passed only when the host capped the search.
   * The card holds the retained matches or paths, so the `Full … stored at
   * <locator>` footer that is the one route to the dropped rows lives nowhere
   * else once a card replaces the raw result. Absent on an uncapped result,
   * whose card already holds every row.
   */
  readonly recovery?: string
}

/** Host-surface renderer for structured web search/fetch results. Link
 * navigation remains an explicit host callback; this package never creates a
 * browser navigation target itself. */
export interface ToolWebRenderProps {
  readonly view: Extract<ToolPresentationView, { readonly card: 'web'; readonly phase: 'result' }>
  readonly translate?: PresentationTranslate
  readonly onOpenLink?: (href: string) => void
}

/**
 * A host renderer is an enhancement only: when it is absent or throws on an
 * otherwise validated payload, the shared fallback view still renders.
 */
function tryHostRenderer<R>(render: (() => R) | undefined, fallback: () => R): R {
  if (render === undefined) return fallback()
  try {
    return render()
  } catch {
    return fallback()
  }
}

export function renderSections(sections: readonly ToolDetailBlock[]): ReactElement {
  return (
    <>
      {sections.map((section, index) => (
        <section className="dsh-tool-row__section" key={`${section.label}:${index}`}>
          <h4>{section.label}</h4>
          <pre>{section.content}</pre>
        </section>
      ))}
    </>
  )
}

export function renderStructuredDetails(
  view: ToolPresentationView | undefined,
  sections: readonly ToolDetailBlock[],
  t?: PresentationTranslate,
  onOpenLink?: (href: string) => void,
  renderCode?: (props: ToolCodeRenderProps) => ReactElement,
  renderDiff?: (props: ToolDiffRenderProps) => ReactElement,
  renderTerminal?: (props: ToolTerminalRenderProps) => ReactElement,
  renderSearch?: (props: ToolSearchRenderProps) => ReactElement,
  renderWeb?: (props: ToolWebRenderProps) => ReactElement,
  recovery?: string,
): ReactElement {
  return (
    <>
      {view === undefined
        ? renderSections(sections)
        : renderPresentationView(
            view,
            sections,
            t,
            onOpenLink,
            renderCode,
            renderDiff,
            renderTerminal,
            renderSearch,
            renderWeb,
            recovery,
          )}
    </>
  )
}

export function renderPresentationView(
  view: ToolPresentationView,
  fallback: readonly ToolDetailBlock[],
  t?: PresentationTranslate,
  onOpenLink?: (href: string) => void,
  renderCode?: (props: ToolCodeRenderProps) => ReactElement,
  renderDiff?: (props: ToolDiffRenderProps) => ReactElement,
  renderTerminal?: (props: ToolTerminalRenderProps) => ReactElement,
  renderSearch?: (props: ToolSearchRenderProps) => ReactElement,
  renderWeb?: (props: ToolWebRenderProps) => ReactElement,
  recovery?: string,
): ReactElement {
  switch (view.card) {
    case 'terminal':
      return view.phase === 'result'
        ? renderTerminalResult(view, t, renderTerminal)
        : renderSections(fallback)
    case 'diff':
      return renderDiffView(view, t, renderDiff)
    case 'search':
      return renderSearchView(view, t, renderSearch, fallback, recovery)
    case 'read':
      return renderReadView(view, t, renderCode)
    case 'web':
      return renderWebView(view, t, onOpenLink, renderWeb, fallback)
    default:
      return renderSections(fallback)
  }
}

function renderWebView(
  view: Extract<ToolPresentationView, { readonly card: 'web'; readonly phase: 'result' }>,
  t: PresentationTranslate | undefined,
  onOpenLink: ((href: string) => void) | undefined,
  renderWeb: ((props: ToolWebRenderProps) => ReactElement) | undefined,
  fallback: readonly ToolDetailBlock[],
): ReactElement {
  return tryHostRenderer(
    renderWeb === undefined
      ? undefined
      : () =>
          renderWeb({
            view,
            ...(t === undefined ? {} : { translate: t }),
            ...(onOpenLink === undefined ? {} : { onOpenLink }),
          }),
    () => (view.kind === 'search' ? renderWebSearch(view, t, onOpenLink) : renderSections(fallback)),
  )
}

function renderSearchView(
  view: Extract<ToolPresentationView, { readonly card: 'search'; readonly phase: 'result' }>,
  t: PresentationTranslate | undefined,
  renderSearch: ((props: ToolSearchRenderProps) => ReactElement) | undefined,
  fallback: readonly ToolDetailBlock[],
  recovery: string | undefined,
): ReactElement {
  const card = tryHostRenderer(
    renderSearch === undefined
      ? undefined
      : () =>
          renderSearch({
            view,
            ...(t === undefined ? {} : { translate: t }),
            ...(recovery === undefined ? {} : { recovery }),
          }),
    () => (view.shape === 'matches' ? renderSearchMatches(view, t) : renderSections(fallback)),
  )
  if (recovery === undefined) return card
  return (
    <>
      {card}
      <section className="dsh-tool-row__section">
        <h4>{label(t, 'toolrow.presentation.fullResult', 'Full result')}</h4>
        <pre>{recovery}</pre>
      </section>
    </>
  )
}

function renderTerminalResult(
  view: Extract<ToolPresentationView, { readonly card: 'terminal'; readonly phase: 'result' }>,
  t?: PresentationTranslate,
  renderTerminal?: (props: ToolTerminalRenderProps) => ReactElement,
): ReactElement {
  const shared = (): ReactElement => {
    const exit = view.exitCode === undefined ? view.signal : String(view.exitCode)
    const succeeded = view.exitCode === 0
    return (
      <>
        {view.output === undefined || view.output.trim() === '' ? null : (
          <section className="dsh-tool-row__section dsh-tool-row__terminal-output">
            <h4>{label(t, 'toolrow.presentation.output', 'Output')}</h4>
            <pre>{formatToolText(view.output, t)}</pre>
          </section>
        )}
        {exit === undefined || exit.trim() === '' ? null : (
          <section className="dsh-tool-row__section dsh-tool-row__terminal-status">
            <h4>{label(t, 'toolrow.presentation.exit', 'Exit status')}</h4>
            <span
              className={`dsh-tool-row__exit-pill dsh-tool-row__exit-pill--${succeeded ? 'ok' : 'error'}`}
              aria-label={`${label(t, succeeded ? 'toolrow.presentation.exitSuccess' : 'toolrow.presentation.exitFailure', succeeded ? 'Succeeded' : 'Failed')}: ${exit}`}
            >
              {exit}
            </span>
          </section>
        )}
      </>
    )
  }
  return tryHostRenderer(
    renderTerminal === undefined
      ? undefined
      : () =>
          renderTerminal({
            view,
            ...(t === undefined ? {} : { translate: t }),
          }),
    shared,
  )
}

function renderDiffView(
  view: Extract<ToolPresentationView, { readonly card: 'diff' }>,
  t?: PresentationTranslate,
  renderDiff?: (props: ToolDiffRenderProps) => ReactElement,
): ReactElement {
  return tryHostRenderer(
    renderDiff === undefined
      ? undefined
      : () =>
          renderDiff({
            diffs: view.diffs,
            ...(t === undefined ? {} : { translate: t }),
          }),
    () => sharedDiffView(view, t),
  )
}

function sharedDiffView(
  view: Extract<ToolPresentationView, { readonly card: 'diff' }>,
  t?: PresentationTranslate,
): ReactElement {
  const files = groupDiffFiles(view.diffs)
  return (
    <>
      <section className="dsh-tool-row__section dsh-tool-row__diff-section">
        <h4>{label(t, 'toolrow.presentation.diff', 'Diff')}</h4>
        <div className="dsh-tool-row__diff-list">
          {files.map((file) => (
            <div className="dsh-tool-row__diff-file" key={file.path}>
              <div className="dsh-tool-row__diff-file-name">{file.path}</div>
              {file.hunks.map((hunk, hunkIndex) => (
                <Fragment key={`${file.path}:${hunkIndex}`}>
                  {hunkIndex > 0 ? (
                    <div className="dsh-tool-row__diff-gap" aria-hidden="true">
                      ⋯
                    </div>
                  ) : null}
                  <pre className="dsh-tool-row__diff-lines">
                    {diffLines(hunk.oldText, hunk.newText).map((line, index) => (
                      <span
                        className={`dsh-tool-row__diff-line dsh-tool-row__diff-line--${line.kind}`}
                        key={`${index}:${line.text}`}
                      >
                        <span className="dsh-tool-row__diff-prefix" aria-hidden="true">
                          {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                        </span>
                        <span>{line.text}</span>
                      </span>
                    ))}
                  </pre>
                </Fragment>
              ))}
            </div>
          ))}
        </div>
      </section>
      {files.length > 1 ? (
        <footer className="dsh-tool-row__diff-footer">
          {label(t, 'toolrow.presentation.fileCount', `${files.length} files`, {
            count: files.length,
          })}
        </footer>
      ) : null}
    </>
  )
}

/**
 * The host states one diff per applied hunk, so one file arrives as a run of
 * entries under the same path. The card is a statement about files — a name per
 * file, and the hunks of one file told apart by the reference card's `⋯`
 * instead of a repeated header.
 */
function groupDiffFiles(
  diffs: readonly ToolPresentationDiff[],
): readonly { readonly path: string; readonly hunks: readonly ToolPresentationDiff[] }[] {
  const files = new Map<string, ToolPresentationDiff[]>()
  for (const diff of diffs) {
    const hunks = files.get(diff.path)
    if (hunks === undefined) files.set(diff.path, [diff])
    else hunks.push(diff)
  }
  return [...files].map(([path, hunks]) => ({ path, hunks }))
}

function renderSearchMatches(
  view: Extract<ToolPresentationView, { readonly card: 'search'; readonly shape: 'matches' }>,
  t?: PresentationTranslate,
): ReactElement {
  const total = view.files.reduce((sum, file) => sum + file.matches.length, 0)
  return (
    <>
      {view.files.length === 0 ? (
        <section className="dsh-tool-row__section">
          <h4>{label(t, 'toolrow.presentation.matches', 'Matches')}</h4>
          <pre>{searchTotal(0, view.total, view.truncated, t)}</pre>
        </section>
      ) : (
        <div className="dsh-tool-row__search-files">
          {view.files.map((file, index) => (
            <details className="dsh-tool-row__search-file" key={file.path} open={index === 0}>
              <summary>
                <span>{file.path}</span>
                <span className="dsh-tool-row__search-count">{file.matches.length}</span>
              </summary>
              <pre>{file.matches.map((match) => `${match.lineNumber}: ${match.line}`).join('\n')}</pre>
            </details>
          ))}
          <div className="dsh-tool-row__search-total">
            {searchTotal(total, view.total, view.truncated, t)}
          </div>
        </div>
      )}
    </>
  )
}

function renderReadView(
  view: Extract<ToolPresentationView, { readonly card: 'read' }>,
  t?: PresentationTranslate,
  renderCode?: (props: ToolCodeRenderProps) => ReactElement,
): ReactElement {
  const code = tryHostRenderer(
    renderCode === undefined
      ? undefined
      : () =>
          renderCode({
            lines: view.lines,
            ...(view.lang === undefined ? {} : { language: view.lang }),
            totalLines: view.totalLines,
            ...(t === undefined ? {} : { translate: t }),
          }),
    () => renderPlainReadCode(view),
  )
  return (
    <section className="dsh-tool-row__section dsh-tool-row__read-window">
      <h4>
        {label(t, 'toolrow.presentation.file', 'File')}: {view.path}
      </h4>
      {code}
      <span className="dsh-tool-row__read-total">
        {view.lines.length === 0
          ? label(t, 'toolrow.presentation.emptyWindow', `No lines / ${view.totalLines}`, {
              total: view.totalLines,
            })
          : `${view.offset}–${view.offset + view.lines.length - 1} / ${view.totalLines}`}
      </span>
    </section>
  )
}

function renderPlainReadCode(view: Extract<ToolPresentationView, { readonly card: 'read' }>): ReactElement {
  return (
    <pre className="dsh-tool-row__read-code" data-language={view.lang ?? 'text'}>
      {view.lines.map((line, index) => (
        <span className="dsh-tool-row__read-line" key={`${line.number}:${index}`}>
          <span className="dsh-sr-only">
            {line.number}: {line.text}
          </span>
          <span className="dsh-tool-row__line-number" aria-hidden="true">
            {line.number}:
          </span>{' '}
          <code aria-hidden="true">{line.text}</code>
        </span>
      ))}
    </pre>
  )
}

function renderWebSearch(
  view: Extract<ToolPresentationView, { readonly card: 'web'; readonly kind: 'search' }>,
  t?: PresentationTranslate,
  onOpenLink?: (href: string) => void,
): ReactElement {
  return (
    <>
      {view.answer === undefined || view.answer.trim() === '' ? null : (
        <section className="dsh-tool-row__section">
          <h4>{label(t, 'toolrow.presentation.answer', 'Answer')}</h4>
          <pre>{formatToolText(view.answer, t)}</pre>
        </section>
      )}
      <section className="dsh-tool-row__section dsh-tool-row__web-sources">
        <h4>{label(t, 'toolrow.presentation.sources', 'Sources')}</h4>
        <div className="dsh-tool-row__source-list" role="list">
          {view.sources.map((source) => (
            <WebSourceRow key={source.url} source={source} onOpenLink={onOpenLink} />
          ))}
          {view.sources.length === 0 ? (
            <span role="listitem">{searchTotal(0, 0, view.truncated, t)}</span>
          ) : null}
        </div>
      </section>
    </>
  )
}

function WebSourceRow({
  source,
  onOpenLink,
}: {
  readonly source: ToolPresentationSource
  readonly onOpenLink: ((href: string) => void) | undefined
}): ReactElement {
  const content = (
    <>
      {hasSourceText(source.title) ? <strong>{source.title}</strong> : null}
      {hasSourceText(source.snippet) ? (
        <span className="dsh-tool-row__source-snippet">{source.snippet}</span>
      ) : null}
      {hasSourceText(source.publishedAt) ? <time>{source.publishedAt}</time> : null}
      <span className="dsh-tool-row__source-url" title={source.url}>
        {source.url}
      </span>
    </>
  )

  return (
    <div className="dsh-tool-row__source-item" role="listitem">
      {onOpenLink === undefined ? (
        <article className="dsh-tool-row__source">{content}</article>
      ) : (
        <button
          className="dsh-tool-row__source dsh-tool-row__source--interactive"
          type="button"
          onClick={() => onOpenLink(source.url)}
          aria-label={source.url}
        >
          {content}
        </button>
      )}
    </div>
  )
}

function hasSourceText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

interface DiffLine {
  readonly kind: 'context' | 'add' | 'remove'
  readonly text: string
}

function diffLines(oldText: string | null, newText: string): readonly DiffLine[] {
  const before = oldText === null ? [] : splitDiffLines(oldText)
  const after = splitDiffLines(newText)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1
  return [
    ...before.slice(0, prefix).map((text) => ({ kind: 'context' as const, text })),
    ...before.slice(prefix, before.length - suffix).map((text) => ({ kind: 'remove' as const, text })),
    ...after.slice(prefix, after.length - suffix).map((text) => ({ kind: 'add' as const, text })),
    ...before.slice(before.length - suffix).map((text) => ({ kind: 'context' as const, text })),
  ]
}

function splitDiffLines(value: string): readonly string[] {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}
