import type * as vscode from 'vscode'
import { redactText } from '@dsh-vscode/dsh-adapter'

export type DiagnosticLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_RANK: Record<DiagnosticLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

const MAX_RECENT_ENTRIES = 32

/** Normalize the `dsh.developer.logLevel` setting; anything unknown means `info`. */
export function diagnosticLevel(value: unknown): DiagnosticLevel {
  return value === 'error' || value === 'warn' || value === 'debug' ? value : 'info'
}

export class RedactedDiagnostics implements vscode.Disposable {
  private readonly recentLines: string[] = []

  public constructor(
    private readonly channel: Pick<vscode.OutputChannel, 'appendLine' | 'show' | 'dispose'>,
    /** Read on every event so a settings change applies without a reload. */
    private readonly level: () => DiagnosticLevel = () => 'info',
  ) {}

  public log(level: DiagnosticLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level()]) return
    const safe = redact(fields)
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      event: /^[A-Za-z0-9._-]{1,128}$/.test(event) ? event : 'diagnostic',
      fields: safe,
    })
    const boundedLine = line.length > 8_192 ? `${line.slice(0, 8_192)}…` : line
    this.channel.appendLine(boundedLine)
    this.recentLines.push(boundedLine)
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

  public dispose(): void {
    this.channel.dispose()
  }
}

const SAFE_FIELD =
  /^(code|phase|candidateSource|latencyBucket|hostVersion|method|status|attempt|count|durationMs|ownership|requestType|rpcMethod|name|state)$/
/** Free-text fields never pass through raw; they get the shared scrubber below. */
const REDACTED_TEXT_FIELD = /^(message|stack|detail)$/

function redact(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (REDACTED_TEXT_FIELD.test(key)) {
      if (typeof entry === 'string') result[key] = redactText(entry, 2_048)
      continue
    }
    if (!SAFE_FIELD.test(key)) continue
    if (typeof entry === 'string') result[key] = entry.slice(0, 128)
    else if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) result[key] = entry
  }
  return result
}
