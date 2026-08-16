import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import { unimplemented } from '@dsh-vscode/domain'

import type { VsCodeApi } from '../vscode-api.js'

export class ProtocolClient {
  private readonly pending = new Map<
    string,
    { readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void }
  >()

  public constructor(private readonly api: VsCodeApi) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    return unimplemented<Promise<T>>('Webview typed request client', [
      'create collision-resistant request ids at call sites or via a request factory',
      'track one promise per request and enforce local UI timeout',
      'post only schema-valid WebviewRequest values',
      'reject outstanding promises when the page unloads',
      `request ${request.type}; pending ${this.pending.size}; API available ${String(this.api !== undefined)}`,
    ])
  }

  public handle(rawMessage: unknown): void {
    unimplemented<void>('handle Extension Host protocol messages', [
      'validate with hostMessageSchema before accessing fields',
      'resolve or reject response promises exactly once',
      'forward sequenced events to one subscribed store action',
      'ignore unknown protocol versions and show a reload-required state',
      `raw type ${typeof rawMessage}; pending ${this.pending.size}`,
    ])
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    return unimplemented<() => void>('subscribe to validated host messages', [
      'attach one window message listener for the client lifecycle',
      'multicast validated messages only',
      'return an idempotent unsubscribe function',
      `listener type ${typeof listener}`,
    ])
  }
}
