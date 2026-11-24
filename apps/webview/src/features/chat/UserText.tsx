import type { ReactNode } from 'react'

import { Icon } from '../../ui/Icon.js'

/** Actions are optional so an unavailable Host keeps the historical text read-only. */
export interface UserTextReferences {
  readonly openFile?: (path: string) => void
  readonly openSession?: (sessionId: string) => void
}

interface DecorationRange {
  readonly start: number
  readonly end: number
  readonly label: string
  readonly kind: 'session' | 'file'
  readonly display?: string
  readonly sessionId?: string
}

/** The wire form used by DSH when a session mention is serialized in text. */
const SESSION_WIRE_RE = /@\[([^\]\n]+)\]\(dsh-session:([^)\s]+)\)/gu

/** Punctuation belongs to the sentence, not to an unquoted file mention. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？]+$/u

const USER_REFERENCE_RE = /(^|\s)(@"[^"\n]+"|@[^\s]+)/gu
const CODE_SPAN_RE = /```[\s\S]*?```|`[^`\n]+`/gu
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$/u

function isFileMentionToken(label: string): boolean {
  if (label.startsWith('@"') && label.endsWith('"') && label.length > 3) return true
  const raw = label.slice(1)
  if (raw === '' || /[()<>`"']/u.test(raw)) return false
  if (raw.endsWith('/') || raw.endsWith('\\')) return true
  if (FILE_EXTENSION_RE.test(raw)) return true
  return raw.startsWith('./') || raw.startsWith('../')
}

function codeSpanIntervals(text: string): readonly (readonly [number, number])[] {
  const intervals: (readonly [number, number])[] = []
  CODE_SPAN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CODE_SPAN_RE.exec(text)) !== null) {
    intervals.push([match.index, match.index + match[0].length])
  }
  return intervals
}

function insideIntervals(index: number, intervals: readonly (readonly [number, number])[]): boolean {
  return intervals.some(([start, end]) => index >= start && index < end)
}

/**
 * Render user-authored reference syntax without trusting it as a native link.
 * The durable message remains the source of truth; this is presentation only.
 */
export function projectUserText(
  text: string,
  sessionLabels: readonly string[] = [],
  references?: UserTextReferences,
): ReactNode {
  const codeIntervals = codeSpanIntervals(text)
  const ranges: DecorationRange[] = []
  SESSION_WIRE_RE.lastIndex = 0
  let wire: RegExpExecArray | null
  while ((wire = SESSION_WIRE_RE.exec(text)) !== null) {
    if (insideIntervals(wire.index, codeIntervals)) continue
    const display = wire[1]
    const sessionId = wire[2]
    if (display === undefined) continue
    ranges.push({
      start: wire.index,
      end: wire.index + wire[0].length,
      label: wire[0],
      kind: 'session',
      display,
      ...(sessionId === undefined ? {} : { sessionId }),
    })
  }

  for (const rawLabel of [...new Set(sessionLabels)].sort((left, right) => right.length - left.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      if (!insideIntervals(start, codeIntervals))
        ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }

  USER_REFERENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = USER_REFERENCE_RE.exec(text)) !== null) {
    const prefix = match[1] ?? ''
    const rawLabel = match[2]
    if (rawLabel === undefined) continue
    const tokenStart = match.index + prefix.length
    if (insideIntervals(tokenStart, codeIntervals)) continue
    const label = rawLabel.startsWith('@"') ? rawLabel : rawLabel.replace(TRAILING_PUNCTUATION_RE, '')
    if (label.length <= 1 || !isFileMentionToken(label)) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'file' })
  }

  // Prefer the longest structured token when a short @word match overlaps a
  // session label or DSH wire reference beginning at the same character.
  ranges.sort((left, right) => left.start - right.start || right.end - left.end)
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    if (range.start > cursor)
      parts.push(<span key={`plain:${cursor}`}>{text.slice(cursor, range.start)}</span>)

    const path = range.kind === 'file' ? decodeFileMention(range.label) : undefined
    const display = range.display ?? (path === undefined ? range.label.slice(1) : fileName(path))
    const content = (
      <>
        <Icon
          name={range.kind === 'session' ? 'session' : path?.endsWith('/') === true ? 'folder' : 'file'}
        />
        <span>{display}</span>
      </>
    )
    const openFile = path === undefined || path.endsWith('/') ? undefined : references?.openFile
    const openSession =
      range.kind === 'session' && range.sessionId !== undefined ? references?.openSession : undefined

    if (openSession !== undefined && range.sessionId !== undefined) {
      const targetSessionId = range.sessionId
      parts.push(
        <button
          key={`reference:${range.start}`}
          className="dsh-user-reference"
          type="button"
          data-reference-kind={range.kind}
          title={display}
          aria-label={display}
          onClick={(event) => {
            if (
              event.detail > 1 ||
              (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)
            )
              return
            openSession(targetSessionId)
          }}
        >
          {content}
        </button>,
      )
    } else if (openFile === undefined || path === undefined) {
      parts.push(
        <span
          key={`reference:${range.start}`}
          className="dsh-user-reference"
          data-reference-kind={range.kind}
          title={range.label}
        >
          {content}
        </span>,
      )
    } else {
      parts.push(
        <button
          key={`reference:${range.start}`}
          className="dsh-user-reference"
          type="button"
          data-reference-kind={range.kind}
          title={range.label}
          aria-label={path}
          onClick={(event) => {
            if (
              event.detail > 1 ||
              (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)
            )
              return
            openFile(path)
          }}
        >
          {content}
        </button>,
      )
    }
    cursor = range.end
  }
  if (cursor < text.length) parts.push(<span key={`plain:${cursor}`}>{text.slice(cursor)}</span>)
  return parts.length === 0 ? <span>{text}</span> : <>{parts}</>
}

/** Keep Markdown for ordinary prose and switch to this projection only when a reference is present. */
export function containsUserTextReferences(text: string, sessionLabels: readonly string[] = []): boolean {
  if (sessionLabels.length > 0) return true
  const codeIntervals = codeSpanIntervals(text)
  SESSION_WIRE_RE.lastIndex = 0
  let wire: RegExpExecArray | null
  while ((wire = SESSION_WIRE_RE.exec(text)) !== null) {
    if (!insideIntervals(wire.index, codeIntervals)) return true
  }
  USER_REFERENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = USER_REFERENCE_RE.exec(text)) !== null) {
    const prefix = match[1] ?? ''
    const rawLabel = match[2]
    if (rawLabel === undefined) continue
    const tokenStart = match.index + prefix.length
    if (insideIntervals(tokenStart, codeIntervals)) continue
    const label = rawLabel.startsWith('@"') ? rawLabel : rawLabel.replace(TRAILING_PUNCTUATION_RE, '')
    if (label.length > 1 && isFileMentionToken(label)) return true
  }
  return false
}

function decodeFileMention(label: string): string | undefined {
  if (!label.startsWith('@')) return undefined
  const path = label.slice(1).replace(/^"|"$/gu, '')
  return path.trim() === '' ? undefined : path
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path
}
