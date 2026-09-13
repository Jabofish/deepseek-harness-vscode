import type {
  ToolPresentationDiff,
  ToolPresentationLine,
  ToolPresentationSearchFile,
  ToolPresentationSearchMatch,
  ToolPresentationSource,
  ToolPresentationView,
} from '@dsh-vscode/domain'

import { safePayload } from '../redaction.js'
import { recordOrUndefined } from '../repositories/shared/guards.js'

/** Project the official rc.8 presentation union without leaking upstream types. */
export function projectToolPresentation(
  envelope: Record<string, unknown> | undefined,
  fallbackPhase: 'call' | 'result',
  contentText: (content: readonly unknown[], reasoningOnly: boolean) => string,
): ToolPresentationView | undefined {
  if (envelope === undefined) return undefined
  const candidate = recordOrUndefined(envelope.view) ?? envelope
  if (typeof candidate.card !== 'string') return undefined
  const phase = envelope.for === 'call' || envelope.for === 'result' ? envelope.for : fallbackPhase
  const card = candidate.card
  if (card === 'generic') return genericPresentation(candidate, phase, contentText)
  if (card === 'terminal') return terminalPresentation(candidate, phase)
  if (card === 'diff') return diffPresentation(candidate, phase)
  if (card === 'search' && phase === 'result') return searchPresentation(candidate)
  if (card === 'read' && phase === 'result') return readPresentation(candidate, contentText)
  if (card === 'web' && phase === 'result') return webPresentation(candidate)
  return undefined
}

function genericPresentation(
  value: Record<string, unknown>,
  phase: 'call' | 'result',
  contentText: (content: readonly unknown[], reasoningOnly: boolean) => string,
): ToolPresentationView {
  const title = optionalText(value.title)
  const kind = optionalText(value.kind)
  const content = presentationContent(value.content, contentText)
  const locations = toolLocations(value.locations)
  if (phase === 'call') {
    const rawInput = presentationValue(value.rawInput)
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

function terminalPresentation(
  value: Record<string, unknown>,
  phase: 'call' | 'result',
): ToolPresentationView | undefined {
  if (phase === 'call') {
    const title = requiredText(value.title)
    if (title === undefined) return undefined
    const description = optionalText(value.description)
    const cwd = safePath(value.cwd)
    return {
      phase,
      card: 'terminal',
      title,
      ...(description === undefined ? {} : { description }),
      ...(cwd === undefined ? {} : { cwd }),
    }
  }
  const title = optionalText(value.title)
  const output = optionalText(value.output)
  const exitCode = presentationExitCode(value.exitCode)
  const signal = optionalText(value.signal)
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

function diffPresentation(
  value: Record<string, unknown>,
  phase: 'call' | 'result',
): ToolPresentationView | undefined {
  const title = requiredText(value.title)
  if (phase === 'call' && title === undefined) return undefined
  const diffs = array(value.diffs).flatMap((entry) => {
    const diff = recordOrUndefined(entry)
    if (diff === undefined) return []
    const path = safePath(diff.path)
    // Diff text is file content, not a label. The pinned DSH emits an empty
    // `newText` for a hunk that only removes lines (and for a file written
    // with empty content), and an empty `oldText` for a pure insertion; those
    // diffs carry the change, so only a non-string may drop them.
    const newText = lineText(diff.newText)
    const oldText = diff.oldText === null ? null : lineText(diff.oldText)
    if (path === undefined || newText === undefined || (diff.oldText !== null && oldText === undefined))
      return []
    const normalizedOldText: string | null = oldText === undefined ? null : oldText
    return [{ path, oldText: normalizedOldText, newText } satisfies ToolPresentationDiff]
  })
  if (diffs.length === 0) return undefined
  if (phase === 'call') {
    if (title === undefined) return undefined
    const locations = toolLocations(value.locations)
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

function searchPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  const shape = value.shape
  const title = optionalText(value.title)
  const truncated = value.truncated
  const total = nonNegativeCount(value.total)
  if (typeof truncated !== 'boolean' || total === undefined) return undefined
  if (shape === 'paths') {
    const paths = array(value.paths).flatMap((entry) => {
      const path = safePath(entry)
      return path === undefined ? [] : [path]
    })
    return {
      phase: 'result',
      card: 'search',
      shape: 'paths',
      ...(title === undefined ? {} : { title }),
      paths,
      truncated,
      total,
    }
  }
  if (shape !== 'matches') return undefined
  const files = array(value.files).flatMap((entry) => {
    const file = recordOrUndefined(entry)
    const path = safePath(file?.path)
    if (file === undefined || path === undefined) return []
    const matches = array(file.matches).flatMap((matchValue) => {
      const match = recordOrUndefined(matchValue)
      const lineNumber = positiveCount(match?.lineNumber)
      const line = lineText(match?.line)
      return lineNumber === undefined || line === undefined
        ? []
        : [{ lineNumber, line } satisfies ToolPresentationSearchMatch]
    })
    return [{ path, matches } satisfies ToolPresentationSearchFile]
  })
  return {
    phase: 'result',
    card: 'search',
    shape: 'matches',
    ...(title === undefined ? {} : { title }),
    files,
    truncated,
    total,
  }
}

function readPresentation(
  value: Record<string, unknown>,
  contentText: (content: readonly unknown[], reasoningOnly: boolean) => string,
): ToolPresentationView | undefined {
  const path = safePath(value.path)
  const offset = nonNegativeCount(value.offset)
  const totalLines = nonNegativeCount(value.totalLines)
  if (path === undefined || offset === undefined || totalLines === undefined) return undefined
  const lines = array(value.lines).flatMap((entry) => {
    const line = recordOrUndefined(entry)
    const number = positiveCount(line?.number)
    const text = lineText(line?.text)
    return number === undefined || text === undefined ? [] : [{ number, text } satisfies ToolPresentationLine]
  })
  const title = optionalText(value.title)
  const lang = optionalText(value.lang)
  const content = presentationContent(value.content, contentText)
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

function webPresentation(value: Record<string, unknown>): ToolPresentationView | undefined {
  const kind = value.kind
  const title = optionalText(value.title)
  const truncated = value.truncated
  if (typeof truncated !== 'boolean') return undefined
  if (kind === 'fetch') {
    const url = safeUrl(value.url)
    const statusCode = httpStatus(value.statusCode)
    if (url === undefined || statusCode === undefined) return undefined
    return {
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      ...(title === undefined ? {} : { title }),
      url,
      statusCode,
      truncated,
    }
  }
  if (kind !== 'search') return undefined
  const sources = array(value.sources).flatMap((entry) => {
    const source = recordOrUndefined(entry)
    const url = safeUrl(source?.url)
    if (source === undefined || url === undefined) return []
    const sourceTitle = optionalText(source.title)
    const snippet = optionalText(source.snippet)
    const publishedAt = optionalText(source.publishedAt)
    return [
      {
        url,
        ...(sourceTitle === undefined ? {} : { title: sourceTitle }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      } satisfies ToolPresentationSource,
    ]
  })
  const answer = optionalText(value.answer)
  return {
    phase: 'result',
    card: 'web',
    kind: 'search',
    ...(title === undefined ? {} : { title }),
    sources,
    ...(answer === undefined ? {} : { answer }),
    truncated,
  }
}

function presentationContent(
  value: unknown,
  contentText: (content: readonly unknown[], reasoningOnly: boolean) => string,
): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const text = contentText(value, false)
  return text === '' ? undefined : [bounded(text)]
}

function presentationValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return bounded(value)
  const sanitized = safePresentationValue(value)
  if (sanitized === undefined) return undefined
  const text = JSON.stringify(sanitized)
  return text === undefined ? undefined : text.slice(0, 4_096)
}

function safePresentationValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => safePresentationValue(entry, depth + 1))
  const record = recordOrUndefined(value)
  if (record === undefined) return undefined
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (isSensitivePresentationField(key)) continue
    const safe = safePresentationValue(entry, depth + 1)
    if (safe !== undefined) output[key] = safe
  }
  return output
}

const SENSITIVE_PRESENTATION_FIELDS = new Set([
  'authorization',
  'token',
  'secret',
  'password',
  'apikey',
  'accessToken',
  'refreshToken',
  'privateKey',
  'body',
  'response',
])

function isSensitivePresentationField(key: string): boolean {
  const normalized = key.replace(/[_-]/gu, '').toLocaleLowerCase()
  return [...SENSITIVE_PRESENTATION_FIELDS].some(
    (field) => field.replace(/[_-]/gu, '').toLocaleLowerCase() === normalized,
  )
}

function requiredText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? bounded(value) : undefined
}

function lineText(value: unknown): string | undefined {
  return typeof value === 'string' ? bounded(value) : undefined
}

function optionalText(value: unknown): string | undefined {
  return requiredText(value)
}

function safePath(value: unknown): string | undefined {
  const path = requiredText(value)
  return path === undefined || hasUnsafePathCharacters(path) ? undefined : path
}

function safeUrl(value: unknown): string | undefined {
  const url = requiredText(value)
  return url === undefined || hasUnsafePathCharacters(url) ? undefined : url
}

function nonNegativeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveCount(value: unknown): number | undefined {
  const count = nonNegativeCount(value)
  return count === undefined || count === 0 ? undefined : count
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

function presentationExitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function toolLocations(
  value: unknown,
): readonly { readonly path: string; readonly line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const locations: { path: string; line?: number }[] = []
  for (const entry of value) {
    const record = recordOrUndefined(entry)
    const path = record?.path
    if (
      typeof path !== 'string' ||
      path.trim() === '' ||
      path.length > 4_096 ||
      hasUnsafePathCharacters(path) ||
      seen.has(path)
    )
      continue
    seen.add(path)
    const line = eventIndex(record?.line)
    locations.push({ path, ...(line === undefined ? {} : { line }) })
    if (locations.length >= 32) break
  }
  return locations.length === 0 ? undefined : locations
}

function hasUnsafePathCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function eventIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function bounded(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(safePayload(value))
  return (text ?? '').slice(0, 4_096)
}
