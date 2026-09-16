import type { ToolPresentationView } from './tools.js'

/**
 * The settled facts of one tool row, as the durable log recorded them: the
 * call's own arguments and the result's own text. Nothing here is host
 * projection — a host without a session tool view states both halves raw.
 */
export interface SettledToolFacts {
  readonly name: string
  /** The raw call arguments this row recorded; DSH persists them as a JSON string. */
  readonly rawArguments: string | undefined
  /** The settled result text this row recorded. */
  readonly output: string | undefined
  readonly failed: boolean
  readonly settled: boolean
}

/**
 * Derive the card a settled tool row must carry, from the card its call phase
 * established.
 *
 * A host without a session tool view states a shell call as raw arguments and
 * its result as raw text; the cards are derived client-side (upstream
 * `terminal-card-model`). Deriving the call card is event-local, but settling
 * it is not: the durable `tool/result` payload carries no name and no
 * arguments, so only the merged row knows both halves. Without this the row
 * keeps its call card forever — the command's output never appears and a
 * non-zero exit reads as a success, since a failing command settles as a
 * completed call whose exit status is result data rather than an error.
 *
 * Returns `previous` when there is nothing to settle or nothing this client
 * understands; `undefined` when the settled row must fall back to its generic
 * request/result sections (the reference model's generic path: a persistent
 * shell, a failure, a spilled preview, and a background call have no single
 * process status, and a spill footer can hide the exit marker); and otherwise
 * the settled terminal card, with no title — a call card's title is the
 * command a user may be asked to authorize, and a settled row states none.
 */
export function settledToolPresentation(
  previous: ToolPresentationView | undefined,
  tool: SettledToolFacts,
): ToolPresentationView | undefined {
  // Only a call card this client derived from a shell call can be settled
  // here: a host envelope's own result card, and every non-shell row, keep
  // whatever they already carry.
  if (previous?.phase !== 'call' || previous.card !== 'terminal') return previous
  if (!tool.settled) return previous
  const args = callArguments(tool.rawArguments)
  if (args === undefined) return previous
  const call = shellCall(tool.name.trim().toLocaleLowerCase(), args) ?? terminalSendCall(tool.name, args)
  if (call === undefined) return previous
  const output = tool.output
  if (output === undefined) return previous
  // A background call is acknowledged with a job id and never an exit status;
  // a persistent shell reports resets and partial output without one; an
  // errored result may be a failure message rather than rendered output, so
  // parsing it would invent a status; and a retained preview's footer can hide
  // the marker entirely.
  const persistent = call.kind === 'shell' && call.persistent
  if (call.background || tool.failed || persistent || hasSpillNotice(output)) return undefined
  if (call.kind === 'terminal-send') return { phase: 'result', card: 'terminal', output }
  // A shell result with no text is not a rendered result: the renderer states
  // `(no output)` rather than nothing, so there is no marker to read and
  // claiming a clean exit would invent the status.
  if (output === '') return undefined
  const status = parseShellExitStatus(output)
  return {
    phase: 'result',
    card: 'terminal',
    ...(status.output === '' ? {} : { output: status.output }),
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(status.signal === undefined ? {} : { signal: status.signal }),
  }
}

export interface ShellExitStatus {
  readonly output: string
  readonly exitCode?: number
  readonly signal?: string
}

/**
 * True when a settled terminal card reports a failing exit: a non-zero code or
 * a terminating signal. The host settles a failing command as a completed call
 * (the exit status is result data, not an error), so this is the row's only
 * failure signal — without it a failed command is labelled completed.
 */
export function terminalPresentationFailed(view: ToolPresentationView | undefined): boolean {
  if (view?.phase !== 'result' || view.card !== 'terminal') return false
  return (view.exitCode !== undefined && view.exitCode !== 0) || view.signal !== undefined
}

/**
 * Parse the marker literals owned by the shell renderer without importing it.
 * The signal marker wins over the exit marker, and a result with no marker at
 * all is a command that exited zero — the renderer only appends a marker for a
 * non-zero code. Only a marker at the very end is one: the renderer keeps
 * mid-text occurrences, which are output the command produced.
 */
export function parseShellExitStatus(text: string): ShellExitStatus {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/u.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/u.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

const OPEN = '('
const CLOSE = ')'
const LOCATION = ' Full formatted result stored at: '
const GUIDANCE_SEPARATOR = '. '
const SEPARATOR = '\n\n'
const EXACT_OMISSION = 'Omitted 0 bytes.'
const COUNT_OFFSET = EXACT_OMISSION.indexOf('0')
const COUNT_SUFFIX = EXACT_OMISSION.slice(COUNT_OFFSET + 1)
const NO_OMISSION = ''
const UNKNOWN_OMISSION = 'More bytes were omitted.'

function isOmission(text: string): boolean {
  if (text === NO_OMISSION || text === UNKNOWN_OMISSION) return true
  const count = Number(text.slice(COUNT_OFFSET, text.length - COUNT_SUFFIX.length))
  return Number.isSafeInteger(count) && count >= 0 && text === `Omitted ${count} bytes.`
}

/**
 * Recognize a final spill-policy notice in persisted text, including
 * notice-only output: `(Omitted <n> bytes. Full formatted result stored at:
 * <locator>. <hint>)` appended to the retained preview. This identifies the
 * text convention, not authenticated tool-output origin, so it is used only to
 * refuse a card, never to build one. Ported from the pinned spill policy,
 * which is Host-only and cannot be imported here.
 */
export function hasSpillNotice(text: string): boolean {
  if (!text.endsWith(CLOSE)) return false
  let start = 0
  while (true) {
    const next = text.indexOf(`${SEPARATOR}${OPEN}`, start)
    const candidate = text.slice(start, next < 0 ? -CLOSE.length : next)
    const location = candidate.indexOf(LOCATION, OPEN.length)
    if (candidate.startsWith(OPEN) && location >= 0 && isOmission(candidate.slice(OPEN.length, location))) {
      return text.indexOf(GUIDANCE_SEPARATOR, start + location + LOCATION.length) >= 0
    }
    if (next < 0) return false
    start = next + SEPARATOR.length
  }
}

interface ShellCall {
  readonly kind: 'shell'
  /** Whether no process exit status describes this call (see upstream's shell-call model). */
  readonly persistent: boolean
  readonly background: boolean
}

interface TerminalSendCall {
  readonly kind: 'terminal-send'
  readonly background: boolean
}

function shellCall(name: string, args: Record<string, unknown>): ShellCall | undefined {
  if (name !== 'bash' && name !== 'pwsh') return undefined
  const { command, description, timeoutMs, workdir, run_in_background: background } = args
  if (typeof command !== 'string' || command.trim() === '') return undefined
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  )
    return undefined
  if (workdir !== undefined && typeof workdir !== 'string') return undefined
  if (background !== undefined && typeof background !== 'boolean') return undefined
  if (!validEscalationFields(args)) return undefined
  if (description === undefined) return { kind: 'shell', persistent: true, background: false }
  if (typeof description !== 'string' || description.trim() === '') return undefined
  return { kind: 'shell', persistent: false, background: background === true }
}

function terminalSendCall(name: string, args: Record<string, unknown>): TerminalSendCall | undefined {
  if (name !== 'terminal_send') return undefined
  const { sessionId, text, submit, run_in_background: background } = args
  if (typeof sessionId !== 'string' || sessionId === '' || typeof text !== 'string') return undefined
  if (submit !== undefined && typeof submit !== 'boolean') return undefined
  if (background !== undefined && typeof background !== 'boolean') return undefined
  return { kind: 'terminal-send', background: background === true }
}

/** The optional escalation pair shared by the shell and file-mutation tools. */
function validEscalationFields(args: Record<string, unknown>): boolean {
  const permission = args.sandbox_permissions
  const justification = args.justification
  if (permission === undefined && justification === undefined) return true
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') return false
  return typeof justification === 'string' && justification.trim() !== ''
}

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
