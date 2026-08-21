import { useState, type ReactElement } from 'react'
import type { ToolCallView, ToolPresentationView } from '@dsh-vscode/domain'
import {
  decodeToolValue,
  formatToolText,
  toolPresentation,
  type PresentationTranslate,
  type ToolDetailBlock,
} from '../tool-presentation.js'

export type ToolRowVariant =
  'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'todo' | 'question' | 'web' | 'skill' | 'other'

export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

export interface ToolRowProps {
  readonly tool: ToolCallView
  /** Controlled when supplied; registry consumers may omit both for local disclosure state. */
  readonly expanded?: boolean
  readonly onToggle?: () => void
  /** Host-owned link opener for files and web sources; the UI never fetches. */
  readonly onOpenLink?: (href: string) => void
  /** Optional label translator supplied by the hosting surface. */
  readonly translate?: PresentationTranslate
}

export interface ToolRowModel {
  readonly variant: ToolRowVariant
  readonly state: ToolRowState
  readonly title: string
  readonly summary: string
  readonly sections: readonly ToolDetailBlock[]
  readonly errorSummary?: string
}

/**
 * Official DSH tool names are dispatch keys, not a capability inventory. This
 * classifier only selects a presentation family; an unrecognized tool always
 * remains on the generic ToolCard path.
 */
export function classifyTool(toolName: string): ToolRowVariant {
  switch (toolName.trim().toLocaleLowerCase()) {
    case 'web_search':
    case 'grep':
    case 'glob':
      return 'search'
    case 'read':
    case 'cordis_package_inspect':
    case 'cordis_runtime_inspect':
      return 'read'
    case 'bash':
    case 'pwsh':
      return 'bash'
    case 'write':
      return 'write'
    case 'edit':
      return 'edit'
    case 'run_code':
      return 'code'
    case 'todo_write':
      return 'todo'
    case 'ask_user_question':
      return 'question'
    case 'web_fetch':
      return 'web'
    case 'skill':
      return 'skill'
    default:
      return 'other'
  }
}

export function isSpecializedTool(tool: ToolCallView): boolean {
  const name = tool.name.trim().toLocaleLowerCase()
  return (
    classifyTool(name) !== 'other' ||
    name === 'cordis_run' ||
    name === 'cordis_stop' ||
    name === 'cordis_undefine'
  )
}

export function toolRowModel(tool: ToolCallView, translate?: PresentationTranslate): ToolRowModel {
  const variant = classifyTool(tool.name)
  const presentation = toolPresentation(tool, translate)
  const state = rowState(tool)
  const title = rowTitle(variant, tool, translate)
  const summary = rowSummary(variant, tool, translate)
  const structured = structuredSections(tool.presentation, translate)
  const sections =
    structured !== undefined
      ? structured
      : variant === 'skill'
        ? skillSections(tool, translate)
        : [...presentation.request, ...presentation.response]
  const errorText = tool.error ?? (state === 'error' ? sections[sections.length - 1]?.content : undefined)
  return {
    variant,
    state,
    title,
    summary,
    sections,
    ...(state === 'error' && errorText !== undefined ? { errorSummary: firstLine(errorText) } : {}),
  }
}

export function ToolRow(props: ToolRowProps): ReactElement {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = props.expanded ?? localExpanded
  const onToggle = props.onToggle ?? (() => setLocalExpanded((current) => !current))
  const model = toolRowModel(props.tool, props.translate)
  const hasDetails = model.sections.length > 0 || props.tool.error !== undefined
  const status = statusLabel(model.state, props.translate)
  const summary = model.errorSummary ?? model.summary
  const expand = label(props.translate, 'toolrow.expand', 'Expand')
  const collapse = label(props.translate, 'toolrow.collapse', 'Collapse')
  return (
    <article
      className={`dsh-tool-row dsh-tool-row--${model.state}`}
      data-tool={props.tool.name}
      data-variant={model.variant}
      data-state={model.state}
    >
      <button
        type="button"
        className="dsh-tool-row__summary"
        aria-expanded={expanded && hasDetails}
        aria-label={`${expanded ? collapse : expand} ${model.title} details`}
        title={`${expanded ? collapse : expand} ${model.title} details`}
        onClick={onToggle}
        disabled={!hasDetails}
      >
        <span className="dsh-tool-row__icon" aria-hidden="true">
          <ToolIcon variant={model.variant} state={model.state} />
        </span>
        <span className="dsh-tool-row__title">{model.title}</span>
        <span className="dsh-tool-row__separator" aria-hidden="true">
          ·
        </span>
        <span
          className={`dsh-tool-row__summary-text${model.errorSummary === undefined ? '' : ' dsh-tool-row__summary-text--error'}`}
        >
          {summary}
        </span>
        <span className="dsh-tool-row__status" aria-label={status}>
          {status}
        </span>
        {hasDetails ? (
          <span
            className={`dsh-tool-row__chevron${expanded ? ' dsh-tool-row__chevron--expanded' : ''}`}
            aria-hidden="true"
          >
            <svg viewBox="0 0 16 16" fill="none" focusable="false">
              <path d="m6 3 5 5-5 5" />
            </svg>
          </span>
        ) : null}
      </button>
      {expanded && hasDetails ? (
        <div className="dsh-tool-row__details">
          {renderStructuredDetails(props.tool, model.sections, props.translate, props.onOpenLink)}
          {props.onOpenLink === undefined ? null : (
            <div
              className="dsh-tool-row__targets"
              aria-label={label(props.translate, 'toolrow.presentation.open', 'Open')}
            >
              {presentationTargets(props.tool.presentation).map((target) => (
                <button
                  key={`${target.href}:${target.label}`}
                  type="button"
                  className="dsh-tool-row__target"
                  title={target.href}
                  onClick={() => props.onOpenLink?.(target.href)}
                >
                  <span>{target.label}</span>
                  <span className="dsh-tool-row__target-href">{target.href}</span>
                </button>
              ))}
            </div>
          )}
          {props.tool.error === undefined ? null : (
            <section className="dsh-tool-row__section dsh-tool-row__section--error" role="alert">
              <h4>{label(props.translate, 'toolrow.error', 'Error')}</h4>
              <pre>{formatToolText(props.tool.error, props.translate) ?? bounded(props.tool.error)}</pre>
            </section>
          )}
        </div>
      ) : null}
    </article>
  )
}

interface ToolPresentationTarget {
  readonly href: string
  readonly label: string
}

function presentationTargets(view: ToolPresentationView | undefined): readonly ToolPresentationTarget[] {
  if (view === undefined) return []
  const targets: ToolPresentationTarget[] = []
  const add = (href: string | undefined, labelText: string): void => {
    const value = href?.trim()
    if (value === undefined || value === '' || targets.some((target) => target.href === value)) return
    targets.push({ href: value, label: labelText })
  }
  switch (view.card) {
    case 'generic':
      if (view.phase === 'call')
        for (const location of view.locations ?? []) add(location.path, location.path)
      break
    case 'diff':
      for (const location of view.phase === 'call' ? (view.locations ?? []) : [])
        add(location.path, location.path)
      for (const diff of view.diffs) add(diff.path, diff.path)
      break
    case 'read':
      add(view.path, `${view.path}:${view.offset}`)
      break
    case 'web':
      if (view.kind === 'fetch') add(view.url, view.url)
      // Web search already renders each source, including its openable URL,
      // inside the specialized sources section. Adding the generic target
      // list here would render the same sources a second time.
      break
    default:
      break
  }
  return targets.slice(0, 16)
}

function renderStructuredDetails(
  tool: ToolCallView,
  sections: readonly ToolDetailBlock[],
  t?: PresentationTranslate,
  onOpenLink?: (href: string) => void,
): ReactElement {
  const view = tool.presentation
  return (
    <>
      {view === undefined ? renderSections(sections) : renderPresentationView(view, sections, t, onOpenLink)}
      {tool.error === undefined ? null : (
        <section className="dsh-tool-row__section dsh-tool-row__section--error" role="alert">
          <h4>{label(t, 'toolrow.error', 'Error')}</h4>
          <pre>{formatToolText(tool.error, t) ?? bounded(tool.error)}</pre>
        </section>
      )}
    </>
  )
}

function renderSections(sections: readonly ToolDetailBlock[]): ReactElement {
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

function renderPresentationView(
  view: ToolPresentationView,
  fallback: readonly ToolDetailBlock[],
  t?: PresentationTranslate,
  onOpenLink?: (href: string) => void,
): ReactElement {
  switch (view.card) {
    case 'terminal':
      return view.phase === 'result' ? renderTerminalResult(view, t) : renderSections(fallback)
    case 'diff':
      return renderDiffView(view, t)
    case 'search':
      return view.shape === 'matches' ? renderSearchMatches(view, t) : renderSections(fallback)
    case 'read':
      return renderReadView(view, t)
    case 'web':
      return view.kind === 'search' ? renderWebSearch(view, t, onOpenLink) : renderSections(fallback)
    default:
      return renderSections(fallback)
  }
}

function renderTerminalResult(
  view: Extract<ToolPresentationView, { readonly card: 'terminal'; readonly phase: 'result' }>,
  t?: PresentationTranslate,
): ReactElement {
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

function renderDiffView(
  view: Extract<ToolPresentationView, { readonly card: 'diff' }>,
  t?: PresentationTranslate,
): ReactElement {
  return (
    <>
      <section className="dsh-tool-row__section dsh-tool-row__diff-section">
        <h4>{label(t, 'toolrow.presentation.diff', 'Diff')}</h4>
        <div className="dsh-tool-row__diff-list">
          {view.diffs.map((diff) => (
            <div className="dsh-tool-row__diff-file" key={diff.path}>
              <div className="dsh-tool-row__diff-file-name">{diff.path}</div>
              <pre className="dsh-tool-row__diff-lines">
                {diffLines(diff.oldText, diff.newText).map((line, index) => (
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
            </div>
          ))}
        </div>
      </section>
      {view.diffs.length > 1 ? (
        <footer className="dsh-tool-row__diff-footer">
          {label(t, 'toolrow.presentation.fileCount', `${view.diffs.length} files`, {
            count: view.diffs.length,
          })}
        </footer>
      ) : null}
    </>
  )
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
): ReactElement {
  return (
    <section className="dsh-tool-row__section dsh-tool-row__read-window">
      <h4>
        {label(t, 'toolrow.presentation.file', 'File')}: {view.path}
      </h4>
      <pre className="dsh-tool-row__read-code" data-language={view.lang ?? 'text'}>
        {view.lines.map((line) => (
          <span className="dsh-tool-row__read-line" key={line.number}>
            <span className="dsh-sr-only">
              {line.number}: {line.text}
            </span>
            <span className="dsh-tool-row__line-number" aria-hidden="true">
              {line.number}:
            </span>{' '}
            <code>{line.text}</code>
          </span>
        ))}
      </pre>
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
            <article className="dsh-tool-row__source" key={source.url} role="listitem">
              {source.title === undefined ? null : <strong>{source.title}</strong>}
              {source.snippet === undefined ? null : <p>{source.snippet}</p>}
              {source.publishedAt === undefined ? null : <time>{source.publishedAt}</time>}
              {onOpenLink === undefined ? (
                <span className="dsh-tool-row__source-link" title={source.url}>
                  {source.url}
                </span>
              ) : (
                <button
                  className="dsh-tool-row__source-link"
                  type="button"
                  onClick={() => onOpenLink(source.url)}
                  title={source.url}
                >
                  {source.url}
                </button>
              )}
            </article>
          ))}
          {view.sources.length === 0 ? <span>{searchTotal(0, 0, view.truncated, t)}</span> : null}
        </div>
      </section>
    </>
  )
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

function rowState(tool: ToolCallView): ToolRowState {
  if (tool.status === 'queued' || tool.status === 'running') return 'running'
  if (tool.status === 'cancelled') return 'stopped'
  return tool.status === 'failed' || tool.error !== undefined ? 'error' : 'ok'
}

function rowTitle(variant: ToolRowVariant, tool: ToolCallView, t?: PresentationTranslate): string {
  const name = tool.name.trim().toLocaleLowerCase()
  if (name === 'pwsh') return label(t, 'toolrow.title.pwsh', 'Pwsh')
  if (name === 'web_search') return label(t, 'toolrow.title.search', 'Search')
  if (name === 'web_fetch') return label(t, 'toolrow.title.fetch', 'Fetch')
  if (name === 'cordis_package_inspect' || name === 'cordis_runtime_inspect')
    return label(t, 'toolrow.title.inspect', 'Inspect')
  if (name === 'cordis_run') return label(t, 'toolrow.title.cordisRun', 'Run Cordis Plugin')
  if (name === 'cordis_stop') return label(t, 'toolrow.title.cordisStop', 'Stop Cordis Plugin')
  if (name === 'cordis_undefine') return label(t, 'toolrow.title.cordisUndefine', 'Remove Cordis Plugin')
  const key = `toolrow.title.${variant}`
  const fallback: Record<ToolRowVariant, string> = {
    search: 'Search',
    read: 'Read',
    bash: 'Bash',
    write: 'Write',
    edit: 'Edit',
    code: 'Code',
    todo: 'To-do',
    question: 'Question',
    web: 'Web',
    skill: 'Skill',
    other: tool.title.trim() || 'Tool call',
  }
  return label(t, key, fallback[variant])
}

function rowSummary(variant: ToolRowVariant, tool: ToolCallView, t?: PresentationTranslate): string {
  const parsed = decodeToolValue(tool.inputSummary)
  if (variant === 'skill') {
    return firstLine(stringField(parsed, 'name') ?? formatToolText(tool.inputSummary, t) ?? tool.id)
  }
  if (variant === 'question') {
    if (tool.status === 'queued' || tool.status === 'running')
      return label(t, 'toolrow.question.waiting', 'Waiting for input')
    const answerSummary = summarizeAnswers(tool.outputSummary, t)
    if (answerSummary !== undefined) return answerSummary
    const questionCount = arrayCount(parsed, 'questions')
    if (questionCount !== undefined)
      return label(t, 'toolrow.question.count', `${questionCount} questions`, { count: questionCount })
  }
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (variant === 'search' && Array.isArray(record.queries)) {
      const queries = record.queries.filter(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      )
      if (queries.length > 0) return queries.map(firstLine).join(', ')
    }
    if (variant === 'todo') {
      const todoSummary = summarizeTodos(record.todos, t)
      if (todoSummary !== undefined) return todoSummary
    }
    const keys: Partial<Record<ToolRowVariant, readonly string[]>> = {
      bash: ['description', 'command'],
      read: ['path', 'file_path', 'url'],
      search: ['query', 'pattern', 'url'],
      write: ['path', 'file_path'],
      edit: ['path', 'file_path'],
      code: ['description'],
      todo: ['todos', 'items'],
      question: ['prompt', 'question'],
      web: ['url', 'query'],
    }
    for (const key of keys[variant] ?? []) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return firstLine(value)
      if (Array.isArray(value) && value.length > 0) return `${value.length} items`
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim() !== '') return firstLine(value)
    }
  }
  return firstLine(formatToolText(tool.inputSummary, t) ?? tool.id)
}

function summarizeTodos(value: unknown, t?: PresentationTranslate): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const items = value.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
  )
  if (items.length !== value.length) return undefined
  const completed = items.filter(
    (item) => item.status === 'completed' || item.status === 'done' || item.completed === true,
  ).length
  const active = items.find(
    (item) => item.status !== 'completed' && item.status !== 'done' && item.completed !== true,
  )
  const activeText =
    active === undefined
      ? undefined
      : (stringField(active, 'content') ?? stringField(active, 'title') ?? stringField(active, 'subject'))
  const progress = label(t, 'toolrow.todo.progress', `${completed}/${items.length} completed`, {
    completed,
    total: items.length,
  })
  return activeText === undefined ? progress : `${progress} · ${firstLine(activeText)}`
}

function summarizeAnswers(value: string | undefined, t?: PresentationTranslate): string | undefined {
  const parsed = decodeToolValue(value)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const answers = (parsed as Record<string, unknown>).answers
  if (!Array.isArray(answers)) return undefined
  const answered = answers.filter((answer) => {
    if (answer === null || typeof answer !== 'object') return false
    const record = answer as Record<string, unknown>
    return (
      (Array.isArray(record.selected) && record.selected.length > 0) ||
      (typeof record.custom === 'string' && record.custom.trim() !== '')
    )
  }).length
  return label(t, 'toolrow.question.answered', `${answered}/${answers.length} answered`, {
    answered,
    total: answers.length,
  })
}

function skillSections(tool: ToolCallView, t?: PresentationTranslate): readonly ToolDetailBlock[] {
  const output = visibleText(tool.outputSummary)
  return output === undefined
    ? []
    : [{ label: label(t, 'toolrow.instructions', 'Instructions'), content: output }]
}

function structuredSections(
  view: ToolPresentationView | undefined,
  t?: PresentationTranslate,
): readonly ToolDetailBlock[] | undefined {
  if (view === undefined) return undefined
  const result: ToolDetailBlock[] = []
  const field = (key: string, fallback: string): string => label(t, `toolrow.presentation.${key}`, fallback)
  const add = (labelText: string, content: string | undefined): void => {
    if (content !== undefined && content.trim() !== '')
      result.push({ label: labelText, content: bounded(content) })
  }
  const addLines = (labelText: string, lines: readonly string[]): void => {
    if (lines.length > 0) add(labelText, lines.map((line) => formatRawToolText(line, t)).join('\n'))
  }
  switch (view.card) {
    case 'generic':
      addLines(
        view.phase === 'result' ? label(t, 'presentation.result', 'Result') : field('content', 'Content'),
        view.content ?? [],
      )
      if (view.phase === 'call') {
        add(field('input', 'Input'), formatRawToolText(view.rawInput, t))
        if (view.locations !== undefined)
          addLines(
            field('files', 'Files'),
            view.locations.map(
              (location) => `${location.path}${location.line === undefined ? '' : `:${location.line}`}`,
            ),
          )
      }
      break
    case 'terminal':
      if (view.phase === 'call') {
        add(field('description', 'Task'), view.description)
        add(field('cwd', 'Working directory'), view.cwd)
      } else {
        add(field('output', 'Output'), view.output)
        add(field('exit', 'Exit status'), view.exitCode === undefined ? view.signal : String(view.exitCode))
      }
      break
    case 'diff':
      addLines(
        field('diff', 'Diff'),
        view.diffs.map((diff) => formatDiff(diff.path, diff.oldText, diff.newText)),
      )
      if (view.phase === 'call' && view.locations !== undefined)
        addLines(
          field('files', 'Files'),
          view.locations.map(
            (location) => `${location.path}${location.line === undefined ? '' : `:${location.line}`}`,
          ),
        )
      break
    case 'search':
      if (view.shape === 'paths') {
        addLines(field('matches', 'Matches'), [
          ...view.paths.map((path) => `• ${path}`),
          searchTotal(view.paths.length, view.total, view.truncated, t),
        ])
      } else {
        for (const file of view.files)
          add(
            `${field('matches', 'Matches')} · ${file.path}`,
            file.matches.map((match) => `${match.lineNumber}: ${match.line}`).join('\n'),
          )
        if (view.files.length === 0)
          add(field('matches', 'Matches'), searchTotal(0, view.total, view.truncated, t))
        else
          add(
            field('total', 'Total'),
            searchTotal(
              view.files.reduce((sum, file) => sum + file.matches.length, 0),
              view.total,
              view.truncated,
              t,
            ),
          )
      }
      break
    case 'read':
      add(field('file', 'File'), view.path)
      addLines(
        field('lines', 'Lines'),
        view.lines.map((line) => `${line.number}: ${line.text}`),
      )
      add(
        field('total', 'Total'),
        view.lines.length === 0
          ? label(t, 'toolrow.presentation.emptyWindow', `No lines / ${view.totalLines}`, {
              total: view.totalLines,
            })
          : `${view.offset}–${view.offset + view.lines.length - 1} / ${view.totalLines}`,
      )
      if (view.content !== undefined) addLines(field('content', 'Content'), view.content)
      break
    case 'web':
      if (view.kind === 'search') {
        add(field('answer', 'Answer'), view.answer)
        addLines(
          field('sources', 'Sources'),
          view.sources.map((source) =>
            [source.title, source.url, source.snippet, source.publishedAt].filter(Boolean).join('\n'),
          ),
        )
        if (view.sources.length === 0) add(field('sources', 'Sources'), searchTotal(0, 0, view.truncated, t))
      } else {
        add(field('url', 'URL'), view.url)
        add(field('status', 'Status'), `${view.statusCode}${view.truncated ? ' · truncated' : ''}`)
      }
      break
  }
  return result
}

function formatRawToolText(value: string | undefined, t?: PresentationTranslate): string {
  return formatToolText(value, t) ?? ''
}

function formatDiff(path: string, oldText: string | null, newText: string): string {
  return `${path}\n--- ${oldText === null ? '(new file)' : 'before'}\n+++ after\n${oldText ?? ''}${
    oldText === null || oldText.endsWith('\n') ? '' : '\n'
  }${newText}`
}

function searchTotal(retained: number, total: number, truncated: boolean, t?: PresentationTranslate): string {
  return label(
    t,
    truncated ? 'toolrow.presentation.totalSummary' : 'toolrow.presentation.totalCount',
    truncated ? `Showing ${retained} of ${total}` : `${total} total`,
    {
      retained,
      total,
    },
  )
}

function statusLabel(state: ToolRowState, t?: PresentationTranslate): string {
  switch (state) {
    case 'running':
      return label(t, 'toolrow.status.running', 'Running')
    case 'error':
      return label(t, 'toolrow.status.error', 'Failed')
    case 'stopped':
      return label(t, 'toolrow.status.stopped', 'Stopped')
    default:
      return label(t, 'toolrow.status.ok', 'Done')
  }
}

function label(
  t: PresentationTranslate | undefined,
  key: string,
  fallback: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  return t === undefined ? fallback : t(key, params)
}

function visibleText(value: string | undefined): string | undefined {
  if (value !== undefined && decodeToolValue(value) === value) return formatToolText(value)
  const decoded = decodeToolValue(value)
  const parts = visibleParts(decoded)
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function visibleParts(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    const decoded = decodeToolValue(value)
    if (decoded !== value) return visibleParts(decoded)
    return value.trim() === '' ? [] : [bounded(value)]
  }
  if (Array.isArray(value)) return value.flatMap(visibleParts)
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return visibleParts(record.text)
  for (const key of ['content', 'message', 'result', 'output']) {
    const parts = visibleParts(record[key])
    if (parts.length > 0) return parts
  }
  return []
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/u, 1)[0] ?? value
  return line.length > 240 ? `${line.slice(0, 239)}…` : line
}

function bounded(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 4_096 ? `${trimmed.slice(0, 4_095)}…` : trimmed
}

function arrayCount(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return Array.isArray(candidate) && candidate.length > 0 ? candidate.length : undefined
}

function ToolIcon(props: { readonly variant: ToolRowVariant; readonly state: ToolRowState }): ReactElement {
  const path =
    props.variant === 'skill'
      ? 'M5 4.5h6l3 3v8H5zM11 4.5v3h3M8 11h3M8 13.5h3'
      : props.variant === 'bash' || props.variant === 'code'
        ? 'm5 7 4 4-4 4m5 0h5'
        : props.variant === 'search' || props.variant === 'web'
          ? 'm10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12m4.3 10.3 4 4'
          : props.variant === 'question'
            ? 'M8.5 8a3.5 3.5 0 1 1 5.8 2.7c-1.1.8-1.8 1.3-1.8 2.8M12.5 16h.01'
            : 'M5 5h14v14H5zM8 9h8M8 12h8M8 15h5'
  return (
    <svg viewBox="0 0 24 24" fill="none" focusable="false">
      <path d={path} />
      {props.state === 'running' ? <path d="M18 4v3m-1.5-1.5h3" /> : null}
    </svg>
  )
}
