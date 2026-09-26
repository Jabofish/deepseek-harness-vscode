import {
  isCanonicalWorkspaceRelativePath,
  type PresentedFileView,
  type SubagentCatalogEntryFact,
  type ToolAutoReviewDenialView,
  type ToolPresentationDiff,
  type ToolPresentationLine,
  type ToolPresentationSearchFile,
  type ToolPresentationSearchMatch,
  type ToolPresentationSource,
  type ToolPresentationView,
} from '@dsh-vscode/domain'
import { isRecord, object } from './unknown-record.js'

/** Keep the Webview boundary closed over the adapter-owned structured card. */
export function parseToolPresentation(value: unknown): ToolPresentationView | undefined {
  const view = object(value)
  if (view === undefined || (view.phase !== 'call' && view.phase !== 'result')) return undefined
  const phase = view.phase
  if (view.card === 'generic') {
    const title = presentationText(view.title)
    const kind = presentationText(view.kind)
    const content = presentationTextList(view.content)
    if (phase === 'call') {
      const rawInput = presentationText(view.rawInput)
      const locations = parseToolLocations(view.locations)
      return {
        phase,
        card: 'generic',
        ...(title === undefined ? {} : { title }),
        ...(kind === undefined ? {} : { kind }),
        ...(rawInput === undefined ? {} : { rawInput }),
        ...(content === undefined ? {} : { content }),
        ...(locations === undefined ? {} : { locations }),
      }
    }
    return {
      phase,
      card: 'generic',
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(content === undefined ? {} : { content }),
    }
  }
  if (view.card === 'terminal') {
    const title = presentationText(view.title)
    if (phase === 'call') {
      if (title === undefined) return undefined
      const description = presentationText(view.description)
      const cwd = presentationWorkingDirectory(view.cwd)
      return {
        phase,
        card: 'terminal',
        title,
        ...(description === undefined ? {} : { description }),
        ...(cwd === undefined ? {} : { cwd }),
      }
    }
    const output = presentationText(view.output)
    const exitCode = presentationExitCode(view.exitCode)
    const signal = presentationText(view.signal)
    if (title === undefined && output === undefined && exitCode === undefined && signal === undefined)
      return undefined
    return {
      phase,
      card: 'terminal',
      ...(title === undefined ? {} : { title }),
      ...(output === undefined ? {} : { output }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
    }
  }
  if (view.card === 'diff') {
    const title = presentationText(view.title)
    const diffs = parseToolDiffs(view.diffs)
    if (diffs.length === 0 || (phase === 'call' && title === undefined)) return undefined
    if (phase === 'call') {
      if (title === undefined) return undefined
      const locations = parseToolLocations(view.locations)
      return {
        phase,
        card: 'diff',
        title,
        diffs,
        ...(locations === undefined ? {} : { locations }),
      }
    }
    return {
      phase,
      card: 'diff',
      ...(title === undefined ? {} : { title }),
      diffs,
    }
  }
  if (phase !== 'result') return undefined
  if (view.card === 'search') return parseSearchPresentation(view)
  if (view.card === 'read') return parseReadPresentation(view)
  if (view.card === 'web') return parseWebPresentation(view)
  return undefined
}

export function parseToolLocations(
  value: unknown,
): readonly { readonly path: string; readonly line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const locations: { path: string; line?: number }[] = []
  for (const entry of value.slice(0, 32)) {
    const record = object(entry)
    const path = presentationPath(record?.path)
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    const line = nonNegativePresentationNumber(record?.line)
    locations.push({ path, ...(line === undefined ? {} : { line }) })
  }
  return locations.length === 0 ? undefined : locations
}

export function parseToolAutoReviewDenial(value: unknown): ToolAutoReviewDenialView | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'reason')) return undefined
  if (value.reason !== undefined && typeof value.reason !== 'string') return undefined
  return typeof value.reason === 'string' ? { reason: value.reason } : {}
}

function parseToolDiffs(value: unknown): readonly ToolPresentationDiff[] {
  if (!Array.isArray(value)) return []
  // The pinned `write`/`edit` result carries one diff per applied hunk and the
  // host caps neither the hunk count nor the group count; a scattered
  // `replace_all` legitimately exceeds any small client-side clamp.
  return value.flatMap((entry): ToolPresentationDiff[] => {
    const diff = object(entry)
    const path = presentationPath(diff?.path)
    // Diff text is file content: a removal-only hunk has an empty `newText`,
    // and the "deleted" review state is derived from that empty text.
    const newText = presentationText(diff?.newText, true)
    const oldText = diff?.oldText === null ? null : presentationText(diff?.oldText, true)
    return path === undefined || newText === undefined || (diff?.oldText !== null && oldText === undefined)
      ? []
      : [{ path, oldText: oldText === undefined ? null : oldText, newText }]
  })
}

function parseSearchPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  if (typeof value.truncated !== 'boolean') return undefined
  const total = nonNegativePresentationNumber(value.total)
  if (total === undefined) return undefined
  const title = presentationText(value.title)
  if (value.shape === 'paths') {
    if (!Array.isArray(value.paths)) return undefined
    const paths = value.paths.slice(0, 256).flatMap((entry) => {
      const path = presentationPath(entry)
      return path === undefined ? [] : [path]
    })
    return {
      phase: 'result',
      card: 'search',
      shape: 'paths',
      ...(title === undefined ? {} : { title }),
      paths,
      truncated: value.truncated,
      total,
    }
  }
  if (value.shape !== 'matches' || !Array.isArray(value.files)) return undefined
  // The host groups every retained match by file (`GREP_MAX_MATCHES = 250`
  // in the pinned upstream grep tool, with the meta byte cap dropping
  // trailing groups and reporting `truncated`). Clipping here would hide the
  // matches the host did keep while the card still reports the host's total.
  const files = value.files.flatMap((entry): ToolPresentationSearchFile[] => {
    const file = object(entry)
    const path = presentationWorkspacePath(file?.path)
    if (file === undefined || path === undefined || !Array.isArray(file.matches)) return []
    const matches = file.matches.flatMap((matchValue): ToolPresentationSearchMatch[] => {
      const match = object(matchValue)
      const lineNumber = positivePresentationNumber(match?.lineNumber)
      const line = presentationText(match?.line, true)
      return lineNumber === undefined || line === undefined ? [] : [{ lineNumber, line }]
    })
    return [{ path, matches }]
  })
  return {
    phase: 'result',
    card: 'search',
    shape: 'matches',
    ...(title === undefined ? {} : { title }),
    files,
    truncated: value.truncated,
    total,
  }
}

function parseReadPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  const path = presentationPath(value.path)
  const offset = nonNegativePresentationNumber(value.offset)
  const totalLines = nonNegativePresentationNumber(value.totalLines)
  if (path === undefined || offset === undefined || totalLines === undefined || !Array.isArray(value.lines))
    return undefined
  // One pinned `read` call returns at most `READ_LIMIT = 2000` lines and the
  // adapter forwards the whole window; clipping it here would silently drop
  // file content the window total still accounts for.
  const lines = value.lines.flatMap((entry): ToolPresentationLine[] => {
    const line = object(entry)
    const number = positivePresentationNumber(line?.number)
    const text = presentationText(line?.text, true)
    return number === undefined || text === undefined ? [] : [{ number, text }]
  })
  const title = presentationText(value.title)
  const lang = presentationText(value.lang)
  const content = presentationTextList(value.content)
  return {
    phase: 'result',
    card: 'read',
    ...(title === undefined ? {} : { title }),
    path,
    offset,
    lines,
    totalLines,
    ...(lang === undefined ? {} : { lang }),
    ...(content === undefined ? {} : { content }),
  }
}

function parseWebPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  if (typeof value.truncated !== 'boolean') return undefined
  const title = presentationText(value.title)
  if (value.kind === 'fetch') {
    const url = presentationUrl(value.url)
    const statusCode = presentationStatusCode(value.statusCode)
    if (url === undefined || statusCode === undefined) return undefined
    return {
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      ...(title === undefined ? {} : { title }),
      url,
      statusCode,
      truncated: value.truncated,
    }
  }
  if (value.kind !== 'search' || !Array.isArray(value.sources)) return undefined
  const sources = value.sources.slice(0, 64).flatMap((entry): ToolPresentationSource[] => {
    const source = object(entry)
    const url = presentationUrl(source?.url)
    if (source === undefined || url === undefined) return []
    const sourceTitle = presentationText(source.title)
    const snippet = presentationText(source.snippet)
    const publishedAt = presentationText(source.publishedAt)
    return [
      {
        url,
        ...(sourceTitle === undefined ? {} : { title: sourceTitle }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      },
    ]
  })
  const answer = presentationText(value.answer)
  return {
    phase: 'result',
    card: 'web',
    kind: 'search',
    ...(title === undefined ? {} : { title }),
    sources,
    ...(answer === undefined ? {} : { answer }),
    truncated: value.truncated,
  }
}

/**
 * The host bounds no presentation string: `write` presents the whole written
 * file as a diff's `newText` and `bash` presents its executor's collected
 * output (default `maxOutputBytes` 64_000 per stream). Every card that shows
 * one of these bodies folds it for display and copies it whole, so clipping
 * here would truncate the copy with no fold or notice to reveal it.
 */
function presentationText(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) return undefined
  return value
}

function presentationTextList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.slice(0, 32).flatMap((entry) => {
    const text = presentationText(entry)
    return text === undefined ? [] : [text]
  })
  return items.length === 0 ? undefined : items
}

function presentationPath(value: unknown): string | undefined {
  const path = presentationText(value)
  return path === undefined || hasPresentationControlCharacter(path) ? undefined : path
}

function presentationWorkspacePath(value: unknown): string | undefined {
  const path = presentationPath(value)
  return path !== undefined && isCanonicalWorkspaceRelativePath(path) ? path : undefined
}

export function parsePresentedFiles(value: unknown): readonly PresentedFileView[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return undefined
  const files: PresentedFileView[] = []
  for (const entry of value) {
    const file = object(entry)
    const path = presentationPath(file?.path)
    const hasDescription = file !== undefined && Object.hasOwn(file, 'description')
    const description = hasDescription ? presentationDisplayText(file?.description) : undefined
    if (path === undefined || (hasDescription && typeof file?.description !== 'string')) return undefined
    files.push({ path, ...(description === undefined ? {} : { description }) })
  }
  return files
}

export function presentationIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 512 ||
    hasPresentationControlCharacter(value)
  )
    return undefined
  return value
}

export function parseSubagentCatalogEntryFact(value: unknown): SubagentCatalogEntryFact | undefined {
  const entry = object(value)
  const id = presentationIdentifier(entry?.id)
  const createdAt = nonNegativePresentationNumber(entry?.createdAt)
  const hasLabel = entry !== undefined && Object.hasOwn(entry, 'label')
  const label = hasLabel ? presentationDisplayText(entry?.label) : undefined
  if (
    id === undefined ||
    createdAt === undefined ||
    (entry?.mode !== 'one-shot' && entry?.mode !== 'continuable') ||
    (hasLabel && typeof entry?.label !== 'string')
  )
    return undefined
  return {
    id,
    createdAt,
    mode: entry.mode,
    ...(label === undefined ? {} : { label }),
  }
}

function presentationWorkingDirectory(value: unknown): string | undefined {
  const directory = presentationPath(value)
  return directory === undefined || isAbsolutePresentationPath(directory) ? undefined : directory
}

function presentationUrl(value: unknown): string | undefined {
  const url = presentationText(value)
  return url === undefined || hasPresentationControlCharacter(url) ? undefined : url
}

function hasPresentationControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

/**
 * Display-only text such as a delivered file's description or a child label.
 *
 * DSH types both as plain strings and they render on a single line, so a
 * control character is normalized rather than refused: refusing it would drop
 * the whole durable record, deleting the deliverable card or the child entry.
 */
function presentationDisplayText(value: unknown): string | undefined {
  const text = presentationText(value, true)
  if (text === undefined) return undefined
  let line = ''
  let pendingSpace = false
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      pendingSpace = line !== ''
      continue
    }
    if (pendingSpace) {
      line += ' '
      pendingSpace = false
    }
    line += character
  }
  const trimmed = line.trim()
  return trimmed === '' ? undefined : trimmed
}

function isAbsolutePresentationPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(value)
}

function nonNegativePresentationNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function positivePresentationNumber(value: unknown): number | undefined {
  const number = nonNegativePresentationNumber(value)
  return number === undefined || number === 0 ? undefined : number
}

function presentationExitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function presentationStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}
