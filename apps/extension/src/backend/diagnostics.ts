import type * as vscode from 'vscode'

export type DiagnosticLevel = 'error' | 'warn' | 'info' | 'debug'

export class RedactedDiagnostics implements vscode.Disposable {
  public constructor(private readonly channel: vscode.OutputChannel) {}

  public log(level: DiagnosticLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const safe = redact(fields)
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      event: /^[A-Za-z0-9._-]{1,128}$/.test(event) ? event : 'diagnostic',
      fields: safe,
    })
    this.channel.appendLine(line.length > 8_192 ? `${line.slice(0, 8_192)}…` : line)
  }

  public show(): void {
    this.channel.show(true)
  }

  public dispose(): void {
    this.channel.dispose()
  }
}

const SAFE_FIELD =
  /^(code|phase|candidateSource|latencyBucket|hostVersion|method|status|attempt|count|durationMs|ownership)$/

function redact(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!SAFE_FIELD.test(key)) continue
    if (typeof entry === 'string') result[key] = entry.slice(0, 128)
    else if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) result[key] = entry
  }
  return result
}
