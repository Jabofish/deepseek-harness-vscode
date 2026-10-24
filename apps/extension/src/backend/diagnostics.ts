import type * as vscode from 'vscode'
import { redactText } from '@dsh-vscode/dsh-adapter'
import type { ConnectionLogEntry, ConnectionProgress } from '@dsh-vscode/domain'
import { connectionLogEntrySchema } from '@dsh-vscode/webview-protocol'

export type DiagnosticLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_RANK: Record<DiagnosticLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

const MAX_RECENT_ENTRIES = 32

/** Normalize the `dsh.developer.logLevel` setting; anything unknown means `info`. */
export function diagnosticLevel(value: unknown): DiagnosticLevel {
  return value === 'error' || value === 'warn' || value === 'debug' ? value : 'info'
}

export class RedactedDiagnostics implements vscode.Disposable {
  private readonly recentLines: string[] = []
  private connectionLines: readonly ConnectionLogEntry[] = []
  private readonly connectionListeners = new Set<(entries: readonly ConnectionLogEntry[]) => void>()
  private connectionSequence = 0
  private connectionStartedAt = Date.now()
  private disposed = false

  public constructor(
    private readonly channel: Pick<vscode.OutputChannel, 'appendLine' | 'show' | 'dispose'>,
    /** Read on every event so a settings change applies without a reload. */
    private readonly level: () => DiagnosticLevel = () => 'info',
  ) {}

  public log(level: DiagnosticLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (this.disposed) return
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level()]) return
    const safe = redact(fields)
    const entry = {
      time: new Date().toISOString(),
      level,
      event: DIAGNOSTIC_EVENTS.has(event) ? event : 'diagnostic',
      fields: safe,
    }
    const line = JSON.stringify(entry)
    const boundedLine = line.length > 8_192 ? `${line.slice(0, 8_192)}…` : line
    this.channel.appendLine(boundedLine)

    // Recent events cross the Host/Webview boundary as opaque JSON strings.
    // Keep their structured metadata and a simple error class name, but never
    // include free text or an arbitrary error name that may contain paths,
    // prompts, or stack details. The local Output channel retains the redacted
    // details for users who choose to open it.
    const snapshotFields = publicRecentEventFields(safe)
    const snapshotLine = JSON.stringify({ ...entry, fields: snapshotFields })
    this.recentLines.push(snapshotLine.length > 8_192 ? `${snapshotLine.slice(0, 8_192)}…` : snapshotLine)
    if (this.recentLines.length > MAX_RECENT_ENTRIES) this.recentLines.splice(0, 1)
  }

  public recentEvents(limit = MAX_RECENT_ENTRIES): readonly string[] {
    const boundedLimit = Math.min(MAX_RECENT_ENTRIES, Math.max(0, Math.floor(limit)))
    if (boundedLimit === 0) return []
    return this.recentLines.slice(-boundedLimit)
  }

  public show(): void {
    this.channel.show(true)
  }

  public connectionProgress(progress: ConnectionProgress): void {
    if (this.disposed) return
    const parsed = connectionLogEntrySchema.safeParse({
      ...progress,
      id: ++this.connectionSequence,
      time: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - this.connectionStartedAt),
    })
    if (!parsed.success) return
    if (progress.phase === 'connect' && progress.status === 'started') {
      this.connectionStartedAt = Date.now()
      this.connectionLines = []
    }
    const entry = {
      ...parsed.data,
      elapsedMs:
        progress.phase === 'connect' && progress.status === 'started'
          ? 0
          : Math.max(0, Date.now() - this.connectionStartedAt),
    }
    this.connectionLines = [...this.connectionLines.slice(-63), entry]
    this.channel.appendLine(JSON.stringify({ event: 'connection-progress', ...entry }))
    for (const listener of this.connectionListeners) listener(this.connectionLines)
  }

  public connectionOutput(): readonly ConnectionLogEntry[] {
    return this.connectionLines
  }

  public subscribeConnectionOutput(listener: (entries: readonly ConnectionLogEntry[]) => void): () => void {
    if (this.disposed) return () => undefined
    this.connectionListeners.add(listener)
    listener(this.connectionLines)
    return () => this.connectionListeners.delete(listener)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.connectionListeners.clear()
    this.connectionLines = []
    this.channel.dispose()
  }
}

const SAFE_FIELD =
  /^(code|phase|candidateSource|latencyBucket|hostVersion|method|status|attempt|count|durationMs|ownership|requestType|rpcMethod|state|eventLoopLagMs)$/
/** Free-text fields never pass through raw; they get the shared scrubber below. */
const REDACTED_TEXT_FIELD = /^(message|stack|detail|name|reason)$/
const RECENT_EVENT_FIELDS = new Set([
  'candidateSource',
  'latencyBucket',
  'hostVersion',
  'phase',
  'code',
  'status',
  'attempt',
  'count',
  'durationMs',
  'ownership',
  'requestType',
  'state',
  'eventLoopLagMs',
])
const RECENT_EVENT_VALUE = /^[A-Za-z0-9_.+-]{1,128}$/u
const DIAGNOSTIC_EVENTS = new Set([
  'runtime-probe-failed',
  'host-message-rejected',
  'checkpoint-storage-unreadable',
  'connection-state',
  'connection-recovery-failed',
  'connection-lost',
  'account-default-model-initialization-failed',
  'job-follow-failed',
  'assistant-preview',
  'request-unexpected',
  'webview-message-unhandled',
  'transcript-delivery-failed',
])
const ERROR_CATEGORIES = new Set([
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AbortError',
  'TimeoutError',
])

function publicRecentEventFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'name') {
      if (typeof value === 'string') result.errorKind = ERROR_CATEGORIES.has(value) ? value : 'Error'
      continue
    }
    if (!RECENT_EVENT_FIELDS.has(key)) continue
    if (typeof value === 'string') {
      if (RECENT_EVENT_VALUE.test(value)) result[key] = value
    } else if (typeof value === 'number') {
      if (Number.isFinite(value) && value >= 0) result[key] = value
    } else if (typeof value === 'boolean' || value === null) result[key] = value
  }
  return result
}

function redact(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (REDACTED_TEXT_FIELD.test(key)) {
      if (typeof entry === 'string') result[key] = redactText(entry, key === 'name' ? 128 : 2_048)
      continue
    }
    if (!SAFE_FIELD.test(key)) continue
    if (typeof entry === 'string') result[key] = entry.slice(0, 128)
    else if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) result[key] = entry
  }
  return result
}
