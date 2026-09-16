import type {
  ToolPresentationDiff,
  ToolPresentationLine,
  ToolPresentationSearchFile,
  ToolPresentationSearchMatch,
  ToolPresentationSource,
  ToolPresentationView,
} from '@dsh-vscode/domain'

import { safePayload } from '../redaction.js'
import { recordOrUndefined, zeroBasedLine } from '../repositories/shared/guards.js'

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

/**
 * Derive the intended mutation card from a raw tool call.
 *
 * Hosts from 0.1.2-alpha.1 on carry no view envelope, so the call-phase card
 * the pinned host projected through its own tool definition (`presentCall`) has
 * to come from the call's arguments. The shipped renderers derive it the same
 * way (upstream `ui-tool` diff-card model), and it is deliberately limited to
 * the first-party file mutations: a `write` states the whole new file, an `edit`
 * states the replacement it will attempt, and `str_replace_editor` only has an
 * intent for `create` and `str_replace`. Everything else — including a call
 * whose arguments do not validate, a subagent/code-dispatch subcall, and every
 * third-party tool — stays on the generic row rather than receiving a card
 * this client guessed from a name or a partial argument set.
 */
export function projectToolCallIntent(
  name: string | undefined,
  rawArguments: unknown,
): ToolPresentationView | undefined {
  if (name === undefined) return undefined
  const args = callArguments(rawArguments)
  if (args === undefined) return undefined
  const diff = intendedDiff(name.trim().toLocaleLowerCase(), args)
  if (diff === undefined) return undefined
  const path = safePath(diff.path)
  if (path === undefined) return undefined
  return {
    phase: 'call',
    card: 'diff',
    // The row title is each surface's own label for the tool; the pinned call
    // view carried the host's sentence here, so the tool's own name is the
    // closest thing the durable log states.
    title: name.trim(),
    diffs: [{ path, oldText: diff.oldText, newText: diff.newText }],
  }
}

/**
 * Derive the running terminal card from a raw shell call.
 *
 * The retired envelope carried the pinned host's own `presentCall` for a
 * foreground shell call (`{card:'terminal', title: args.command, description,
 * cwd}`). On a host that sends none, the command lives in the raw arguments
 * alone: the row cannot state what it runs and an approval paired with the
 * call asks the user to authorize text no surface can read. The shipped
 * terminal-card model rebuilds the same card from the call's own arguments and
 * this mirrors it — including nested code-dispatch calls, whose flattened rows
 * keep the terminal card the reference model draws for them. Only a call whose
 * arguments validate states a command: a background call is acknowledged with
 * a job id and never an exit status, and a malformed flag, timeout, workdir or
 * escalation pair never reaches a tool.
 */
export function projectToolShellCall(
  name: string | undefined,
  rawArguments: unknown,
): ToolPresentationView | undefined {
  if (name === undefined) return undefined
  const args = callArguments(rawArguments)
  if (args === undefined) return undefined
  const intent = shellIntent(name.trim().toLocaleLowerCase(), args)
  if (intent === undefined) return undefined
  return {
    phase: 'call',
    card: 'terminal',
    title: intent.title,
    ...(intent.description === undefined ? {} : { description: intent.description }),
    ...(intent.cwd === undefined ? {} : { cwd: intent.cwd }),
  }
}

/** The command one running shell call states. */
interface ShellIntent {
  readonly title: string
  readonly description?: string
  readonly cwd?: string
}

/**
 * The shell one call asks to run, mirroring the shipped terminal-card model.
 * A foreground `bash`/`pwsh` command is the card; the standard tools always
 * state a `description` and the persistent providers omit it, and both run.
 * A `terminal_send` states the text it types into a named session, which the
 * pinned host labelled with the session it addressed.
 */
function shellIntent(name: string, args: Record<string, unknown>): ShellIntent | undefined {
  if (name === 'bash' || name === 'pwsh') {
    const command = args.command
    if (typeof command !== 'string' || command.trim() === '') return undefined
    if (args.run_in_background === true) return undefined
    if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') return undefined
    const timeout = args.timeoutMs
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0))
      return undefined
    if (args.workdir !== undefined && typeof args.workdir !== 'string') return undefined
    if (!validEscalationFields(args)) return undefined
    const description = args.description
    if (description !== undefined && (typeof description !== 'string' || description.trim() === ''))
      return undefined
    const cwd = safePath(args.workdir)
    return {
      title: command,
      ...(description === undefined ? {} : { description }),
      ...(cwd === undefined ? {} : { cwd }),
    }
  }
  if (name !== 'terminal_send') return undefined
  const sessionId = nonEmpty(args.sessionId)
  if (sessionId === undefined) return undefined
  const text = args.text
  // An Enter-only send is a real action, but the card's title is the command a
  // user may be asked to authorize: product copy written here would present
  // invented text as that command, so the call keeps its readable arguments.
  if (typeof text !== 'string' || text.trim() === '') return undefined
  if (args.submit !== undefined && typeof args.submit !== 'boolean') return undefined
  if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') return undefined
  if (args.run_in_background === true) return undefined
  return { title: text, description: `Terminal ${sessionId}` }
}

/** A tool call states one file the tool was asked to produce. */
interface IntendedDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

/**
 * The intended mutation of one call, mirroring the shipped diff-card model.
 * An `oldText` of `null` is a creation or a pure insertion, never a dropped
 * hunk: `write` writes `content` whether or not the file existed, an empty
 * `old_string` inserts, and `str_replace_editor` may omit the replaced text.
 */
function intendedDiff(name: string, args: Record<string, unknown>): IntendedDiff | undefined {
  if (name === 'str_replace_editor') {
    const path = nonEmpty(args.path)
    if (path === undefined) return undefined
    if (args.command === 'create') {
      const fileText = args.file_text
      if (fileText !== undefined && typeof fileText !== 'string') return undefined
      return { path, oldText: null, newText: fileText ?? '' }
    }
    if (args.command === 'str_replace') {
      const oldText = args.old_str
      const newText = args.new_str
      if (oldText !== undefined && typeof oldText !== 'string') return undefined
      if (newText !== undefined && typeof newText !== 'string') return undefined
      return { path, oldText: oldText ?? null, newText: newText ?? '' }
    }
    return undefined
  }
  const path = nonEmpty(args.file_path)
  if (path === undefined) return undefined
  // A call that declares escalation has to declare it correctly; a malformed
  // pair never reaches a tool, so no card claims otherwise.
  if (!validEscalationFields(args)) return undefined
  if (name === 'write') {
    const content = args.content
    return typeof content === 'string' ? { path, oldText: null, newText: content } : undefined
  }
  if (name !== 'edit') return undefined
  const oldText = args.old_string
  const newText = args.new_string
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  if (args.replace_all !== undefined && typeof args.replace_all !== 'boolean') return undefined
  return { path, oldText: oldText === '' ? null : oldText, newText }
}

/** The optional escalation pair shared by the shell and file-mutation tools. */
function validEscalationFields(args: Record<string, unknown>): boolean {
  const permission = args.sandbox_permissions
  const justification = args.justification
  if (permission === undefined && justification === undefined) return true
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') return false
  return typeof justification === 'string' && justification.trim() !== ''
}

/**
 * The model-produced argument object of one call. DSH persists the call's
 * arguments as a raw JSON string on every host this adapter pins, and a payload
 * that is not a JSON object states nothing about a file.
 */
function callArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Derive a settled card from the durable `tool/result` `meta` payload.
 *
 * Hosts from 0.1.2-alpha.1 on carry no session tool view: the tool's own
 * `presentationMeta` value is persisted on the result event instead and the
 * card is derived from it (upstream client-derived tool presentation). Each
 * shape is recognized by the keys the host's projectors own — a `diffs` array,
 * a search `shape`, web `sources`/`url`, read `lines` — never by a tool name,
 * so a presenter outside the shipped catalog still reaches its card as long as
 * it projects the same value. Malformed metadata yields no card, which leaves
 * the row on the generic path exactly as the reference card models do.
 */
export function projectToolResultMeta(
  meta: unknown,
  contentText: (content: readonly unknown[], reasoningOnly: boolean) => string,
): ToolPresentationView | undefined {
  const value = recordOrUndefined(meta)
  if (value === undefined) return undefined
  if (Array.isArray(value.diffs)) return diffPresentation(value, 'result')
  if (value.shape === 'paths' && Array.isArray(value.paths)) return searchPresentation(value)
  if (value.shape === 'matches' && Array.isArray(value.files)) return searchPresentation(value)
  if (Array.isArray(value.sources)) return webPresentation({ ...value, kind: 'search' })
  if (typeof value.url === 'string') return webPresentation({ ...value, kind: 'fetch' })
  if (Array.isArray(value.lines)) return readPresentation(value, contentText)
  return undefined
}

/**
 * The files a settled diff card names. The retired call view carried
 * `locations` for the produced-file chips and the change review; an applied
 * diff makes the same statement about the same paths, so a derived card owns
 * them where no host envelope exists.
 */
export function presentationDiffLocations(
  presentation: ToolPresentationView | undefined,
): readonly { readonly path: string }[] | undefined {
  if (presentation?.phase !== 'result' || presentation.card !== 'diff') return undefined
  const seen = new Set<string>()
  const locations: { path: string }[] = []
  for (const diff of presentation.diffs) {
    if (seen.has(diff.path)) continue
    seen.add(diff.path)
    locations.push({ path: diff.path })
    if (locations.length >= 32) break
  }
  return locations.length === 0 ? undefined : locations
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
    if (!Array.isArray(value.paths)) return undefined
    const paths = value.paths.flatMap((entry) => {
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
  if (shape !== 'matches' || !Array.isArray(value.files)) return undefined
  const files = value.files.flatMap((entry) => {
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
  // `offset` is the 1-based first line of the returned window and `lines` is
  // that window in order: a window that starts below line 1, repeats a line, or
  // names a line past the file is malformed, and a card built from part of it
  // would present a clipped window as the read the model got.
  const offset = positiveCount(value.offset)
  const totalLines = nonNegativeCount(value.totalLines)
  if (path === undefined || offset === undefined || totalLines === undefined) return undefined
  const lines: ToolPresentationLine[] = []
  let previous = offset - 1
  for (const entry of Array.isArray(value.lines) ? value.lines : []) {
    const line = recordOrUndefined(entry)
    const number = positiveCount(line?.number)
    const text = lineText(line?.text)
    if (number === undefined || number <= previous || number > totalLines || text === undefined)
      return undefined
    previous = number
    lines.push({ number, text })
  }
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
  if (kind !== 'search' || !Array.isArray(value.sources)) return undefined
  const sources = value.sources.flatMap((entry) => {
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
  return text === '' ? undefined : [projectedText(text)]
}

function presentationValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return projectedText(value)
  const sanitized = safePresentationValue(value)
  if (sanitized === undefined) return undefined
  return JSON.stringify(sanitized)
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
  return typeof value === 'string' && value.trim() !== '' ? projectedText(value) : undefined
}

function lineText(value: unknown): string | undefined {
  return typeof value === 'string' ? projectedText(value) : undefined
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
    const line = zeroBasedLine(record?.line)
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

/**
 * Project a presentation value as display text. DSH's card vocabulary bounds
 * nothing here: `write` presents the whole written file as a diff's `newText`,
 * `bash` presents the executor's collected output (default `maxOutputBytes`
 * 64_000 per stream), and the reference client renders both whole. Clipping to
 * any fixed length would drop the tail of a legal card silently, since the
 * Webview folds and copies these bodies as if they were complete.
 */
function projectedText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(safePayload(value))
  return text ?? ''
}
