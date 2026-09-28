import type { ToolCallView, ToolLocationView, ToolPresentationView } from '@dsh-vscode/domain'

import { formatToolText, type PresentationTranslate, type ToolDetailBlock } from './tool-presentation.js'
import { formatDiff, formatRawToolText, label, searchTotal, visibleText } from './tool-row-text.js'

export function removeDuplicateErrorSections(
  sections: readonly ToolDetailBlock[],
  error: string | undefined,
  t?: PresentationTranslate,
): readonly ToolDetailBlock[] {
  if (error === undefined) return sections
  return sections.filter((section) => !sameToolText(section.content, error, t))
}

export function removeDuplicateErrorPresentation(
  view: ToolPresentationView | undefined,
  error: string | undefined,
  t?: PresentationTranslate,
): ToolPresentationView | undefined {
  if (view === undefined || error === undefined) return view
  switch (view.card) {
    case 'generic':
      return view.phase === 'result' && view.content !== undefined
        ? { ...view, content: view.content.filter((content) => !sameToolText(content, error, t)) }
        : view
    case 'terminal':
      if (view.phase !== 'result' || !sameToolText(view.output, error, t)) return view
      {
        const withoutOutput = { ...view }
        delete withoutOutput.output
        return withoutOutput
      }
    case 'web':
      if (view.kind !== 'search' || !sameToolText(view.answer, error, t)) return view
      {
        const withoutAnswer = { ...view }
        delete withoutAnswer.answer
        return withoutAnswer
      }
    default:
      return view
  }
}

function sameToolText(
  first: string | undefined,
  second: string | undefined,
  t?: PresentationTranslate,
): boolean {
  if (first === undefined || second === undefined) return false
  const firstText = formatToolText(first, t) ?? first.trim()
  const secondText = formatToolText(second, t) ?? second.trim()
  return firstText === secondText
}

export function skillSections(tool: ToolCallView, t?: PresentationTranslate): readonly ToolDetailBlock[] {
  const output = visibleText(tool.outputSummary)
  return output === undefined
    ? []
    : [{ label: label(t, 'toolrow.instructions', 'Instructions'), content: output }]
}

/**
 * The stored hint is 0-based so it can drive an editor position; `path:line` is
 * read by people and by every other tool in the 1-based convention.
 */
function locationText(location: ToolLocationView): string {
  return location.line === undefined ? location.path : `${location.path}:${location.line + 1}`
}

export function structuredSections(
  view: ToolPresentationView | undefined,
  t?: PresentationTranslate,
): readonly ToolDetailBlock[] | undefined {
  if (view === undefined) return undefined
  const result: ToolDetailBlock[] = []
  const field = (key: string, fallback: string): string => label(t, `toolrow.presentation.${key}`, fallback)
  const add = (labelText: string, content: string | undefined): void => {
    if (content !== undefined && content.trim() !== '')
      result.push({ label: labelText, content: content.trim() })
  }
  const addLines = (labelText: string, lines: readonly string[]): void => {
    if (lines.length > 0) add(labelText, lines.map((line) => formatRawToolText(line, t)).join('\n'))
  }
  const addLocations = (labelText: string, locations: readonly ToolLocationView[]): void => {
    addLines(labelText, locations.map(locationText))
  }
  switch (view.card) {
    case 'generic':
      addLines(
        view.phase === 'result' ? label(t, 'presentation.result', 'Result') : field('content', 'Content'),
        view.content ?? [],
      )
      if (view.phase === 'call') {
        add(field('input', 'Input'), formatRawToolText(view.rawInput, t))
        if (view.locations !== undefined) addLocations(field('files', 'Files'), view.locations)
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
        addLocations(field('files', 'Files'), view.locations)
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
