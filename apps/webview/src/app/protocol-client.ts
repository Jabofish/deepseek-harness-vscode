import {
  hostEnvelopeSchema,
  PROTOCOL_VERSION,
  webviewRequestSchema,
  type HostMessage,
  type WebviewRequest,
} from '@dsh-vscode/webview-protocol'

import { translate } from '../i18n.js'
import type { VsCodeApi } from '../vscode-api.js'

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: number
}

export class ProtocolClient {
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private readonly sequences = new Map<string, number>()
  private disposed = false
  private readonly windowListener = (event: MessageEvent<unknown>): void => this.handle(event.data)

  public constructor(
    private readonly api: VsCodeApi,
    private readonly timeoutMs = 30_000,
  ) {
    window.addEventListener('message', this.windowListener)
  }

  public request<T>(request: WebviewRequest): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(translate('app.error.disposed')))
    const parsed = webviewRequestSchema.parse(request)
    if (this.pending.has(parsed.requestId))
      return Promise.reject(new Error(translate('app.error.duplicateRequest')))
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(parsed.requestId)
        reject(new Error(translate('app.error.timeout')))
      }, this.timeoutMs)
      this.pending.set(parsed.requestId, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.api.postMessage({ protocolVersion: PROTOCOL_VERSION, message: parsed })
      } catch (error) {
        window.clearTimeout(timer)
        this.pending.delete(parsed.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  public handle(rawMessage: unknown): void {
    const parsed = hostEnvelopeSchema.safeParse(rawMessage)
    if (!parsed.success) return
    const message = parsed.data.message
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId)
      if (pending === undefined) return
      this.pending.delete(message.requestId)
      window.clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.payload)
      else {
        const error = new Error(message.error?.message ?? translate('app.error.hostUnspecified'))
        if (message.error !== undefined) Object.assign(error, message.error)
        pending.reject(error)
      }
      return
    }
    const previous = this.sequences.get(message.name) ?? -1
    if (message.sequence <= previous) return
    this.sequences.set(message.name, message.sequence)
    for (const listener of this.listeners) listener(message)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.windowListener)
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(translate('app.error.webviewDisposed')))
    }
    this.pending.clear()
    this.listeners.clear()
  }
}
