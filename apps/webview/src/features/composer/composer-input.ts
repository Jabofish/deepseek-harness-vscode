import type { OpenFileCandidate, ReferenceCandidate } from '../../app/store.js'
import { formatPermissionLabel } from './SessionControls.js'
import type { CommandArgumentOption } from '../commands/CommandPalette.js'
import type { DynamicCommand, RunningInputMode } from '@dsh-vscode/domain'

export const COMPOSER_MIN_HEIGHT = 42
export const COMPOSER_MAX_HEIGHT = 132

export function formatByteSize(value: number): string {
  if (value >= 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(value % (1024 * 1024) === 0 ? 0 : 1)} MiB`
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`
  return `${value} B`
}

export function fitComposerTextarea(element: HTMLTextAreaElement): void {
  element.style.height = 'auto'
  const contentHeight = Math.max(COMPOSER_MIN_HEIGHT, element.scrollHeight)
  const nextHeight = Math.min(contentHeight, COMPOSER_MAX_HEIGHT)
  element.style.height = `${nextHeight}px`
  element.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
}

export function pageAttachmentRail(element: HTMLUListElement | null, direction: -1 | 1): void {
  if (element === null) return
  const distance = Math.max(160, Math.floor(element.clientWidth * 0.8))
  element.scrollBy({ left: direction * distance, behavior: 'smooth' })
}

interface EmbeddedReferenceRange {
  readonly start: number
  readonly end: number
}

export function embeddedReferenceRange(
  value: string,
  cursor: number,
  backwards: boolean,
): EmbeddedReferenceRange | undefined {
  const references = /@\[[^\]\r\n]{1,512}\]\(dsh-session:[A-Za-z0-9_-]{1,512}\)/gu
  for (const match of value.matchAll(references)) {
    const start = match.index
    const end = start + match[0].length
    if ((backwards && cursor === end) || (!backwards && cursor === start)) return { start, end }
  }
  return undefined
}

export function orderOpenFileCandidates(
  candidates: readonly OpenFileCandidate[],
  preferredId: string | undefined,
): readonly OpenFileCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftRank = left.id === preferredId ? 0 : left.active ? 1 : 2
    const rightRank = right.id === preferredId ? 0 : right.active ? 1 : 2
    return leftRank - rightRank
  })
}

interface ReferenceQueryToken {
  readonly start: number
  readonly end: number
  readonly query: string
  readonly quoted: boolean
}

/** Find the unfinished `@path`/`@"path with spaces` token at the caret. */
export function referenceQueryToken(value: string, cursor: number): ReferenceQueryToken | undefined {
  const boundedCursor = Math.max(0, Math.min(cursor, value.length))
  const at = value.slice(0, boundedCursor).lastIndexOf('@')
  if (at < 0) return undefined
  const before = at === 0 ? '' : value.charAt(at - 1)
  if (before !== '' && !/\s/u.test(before)) return undefined
  const tail = value.slice(at + 1, boundedCursor)
  if (tail.startsWith('[')) return undefined
  if (tail.startsWith('"')) {
    const query = tail.slice(1)
    if (query.includes('"') || /\r|\n/u.test(query)) return undefined
    return { start: at, end: boundedCursor, query, quoted: true }
  }
  if (tail.includes('"') || /\s/u.test(tail)) return undefined
  return { start: at, end: boundedCursor, query: tail, quoted: false }
}

export function referenceMention(candidate: ReferenceCandidate): string {
  if (candidate.kind === 'session') return candidate.mention
  const path =
    candidate.kind === 'directory' && !candidate.path.endsWith('/') ? `${candidate.path}/` : candidate.path
  return `@${/[\s"]/u.test(path) ? `"${path}"` : path}`
}

export function slashCommandQuery(value: string): string | undefined {
  // Multi-line drafts are ordinary prompts and never claim (`leadingSlashCommandLine`
  // documents this). The command menu must agree: if the query kept reading
  // the first line while the draft holds a body, Tab or a row pick would
  // replace the whole draft with the command line and silently destroy the
  // lines below it.
  if (value.includes('\n')) return undefined
  const firstLine = value.split('\n', 1)[0] ?? ''
  return /^\/(?:[a-z][a-z0-9_-]*(?:[ \t]+[^\n]*)?)?$/u.test(firstLine) ? firstLine : undefined
}

/** Official enter adjudication parses the full trimmed draft — exactly one
 * line shaped `/<name>` or `/<name> <args>`; multi-line drafts are ordinary
 * prompts and never claim. */
export function leadingSlashCommandLine(
  value: string,
): { readonly name: string; readonly args: string } | undefined {
  if (value.includes('\n')) return undefined
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+(.*))?$/u.exec(value.trim())
  if (match === null || match[1] === undefined) return undefined
  return { name: match[1], args: match[2] === undefined ? '' : match[2].trim() }
}

export function commandInputOptions(
  query: string | undefined,
  commands: readonly DynamicCommand[],
  permissionPresets: readonly string[],
): readonly CommandArgumentOption[] {
  if (query === undefined) return []
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+.*)?$/u.exec(query)
  const commandName = match?.[1]
  if (commandName === undefined) return []
  const command = commands.find((entry) => entry.name === commandName)
  if (command === undefined || command.input === undefined) return []

  // Permission ids come from DSH's session detail/projection. They are the
  // only argument values this client may complete because they are dynamic
  // host data rather than a locally maintained command allowlist.
  if (/^<preset>$/iu.test(command.input.hint.trim())) {
    return uniqueArgumentOptions(permissionPresets, formatPermissionLabel)
  }

  // The rc.6 built-in plan descriptor advertises the optional literal `off`.
  // Only complete a single literal hint; arbitrary free-form command input
  // must remain under the command registry's own parser.
  const literal = /^\[([a-z][a-z0-9_-]*)\]$/u.exec(command.input.hint.trim())
  if (literal?.[1] === 'off') return [{ value: 'off', label: 'off' }]
  return []
}

function uniqueArgumentOptions(
  values: readonly string[],
  label = formatArgumentLabel,
): readonly CommandArgumentOption[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].map((value) => ({
    value,
    label: label(value),
  }))
}

function formatArgumentLabel(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/**
 * Official submission policy (ComposerSubmissionPolicy.resolve): an idle
 * agent always receives `queue`; while running, plain Enter resolves to the
 * busy-Enter preference and the Cmd/Ctrl-accelerated chord to its opposite.
 * Direct `steer` is intentionally best-effort — a closed delivery window
 * turns the submission into the next waking Queue item.
 */
export function resolveSubmitMode(
  running: boolean,
  accelerated: boolean,
  busyEnter: RunningInputMode,
): RunningInputMode {
  if (!running) return 'queue'
  if (accelerated) return busyEnter === 'queue' ? 'steer' : 'queue'
  return busyEnter
}
