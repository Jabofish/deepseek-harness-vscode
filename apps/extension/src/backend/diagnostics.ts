import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

export type DiagnosticLevel = 'error' | 'warn' | 'info' | 'debug'

export class RedactedDiagnostics implements vscode.Disposable {
  public constructor(private readonly channel: vscode.OutputChannel) {}

  public log(level: DiagnosticLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    unimplemented<void>('structured redacted diagnostics', [
      'serialize timestamp, level, stable event name, and allowlisted metadata',
      'redact key, token, authorization, secret, password, prompt, request body, and response body recursively',
      'bound field and line size',
      'honor configured log level',
      `level ${level}; event ${event}; field count ${Object.keys(fields).length}; channel ${this.channel.name}`,
    ])
  }

  public show(): void {
    this.channel.show(true)
  }

  public dispose(): void {
    this.channel.dispose()
  }
}
