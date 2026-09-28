import { decodeToolValue, formatToolText, type PresentationTranslate } from './tool-presentation.js'

export function label(
  t: PresentationTranslate | undefined,
  key: string,
  fallback: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  return t === undefined ? fallback : t(key, params)
}

export function visibleText(value: string | undefined): string | undefined {
  if (value !== undefined && decodeToolValue(value) === value) return formatToolText(value)
  const decoded = decodeToolValue(value)
  const parts = visibleParts(decoded)
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function visibleParts(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    const decoded = decodeToolValue(value)
    if (decoded !== value) return visibleParts(decoded)
    return value.trim() === '' ? [] : [value.trim()]
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

export function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined
}

export function firstLine(value: string): string {
  const line = value.split(/\r?\n/u, 1)[0] ?? value
  return line.length > 240 ? `${line.slice(0, 239)}…` : line
}

export function arrayCount(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return Array.isArray(candidate) && candidate.length > 0 ? candidate.length : undefined
}

export function formatRawToolText(value: string | undefined, t?: PresentationTranslate): string {
  return formatToolText(value, t) ?? ''
}

export function formatDiff(path: string, oldText: string | null, newText: string): string {
  return `${path}\n--- ${oldText === null ? '(new file)' : 'before'}\n+++ after\n${oldText ?? ''}${
    oldText === null || oldText.endsWith('\n') ? '' : '\n'
  }${newText}`
}

export function searchTotal(
  retained: number,
  total: number,
  truncated: boolean,
  t?: PresentationTranslate,
): string {
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
