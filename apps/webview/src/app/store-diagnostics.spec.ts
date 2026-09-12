// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class DiagnosticsClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly answer: (request: WebviewRequest) => unknown) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.answer(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }
}

const snapshot = {
  extensionVersion: '0.1.10',
  dshVersion: '0.1.9',
  state: 'failed',
  endpointKind: 'managed',
  canReconnect: true,
  recentEvents: ['{"level":"error","event":"connection-state"}'],
} as const

describe('AppStore diagnostics', () => {
  it('requests and strictly projects the host diagnostics snapshot', async () => {
    const client = new DiagnosticsClient((request) => {
      if (request.type !== 'diagnostics.snapshot') throw new Error(`unexpected ${request.type}`)
      return snapshot
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await expect(store.readDiagnostics()).resolves.toEqual(snapshot)
    expect(client.requests[0]?.type).toBe('diagnostics.snapshot')
    store.dispose()
  })

  it('fails closed on a malformed snapshot and keeps output opening host-only', async () => {
    const client = new DiagnosticsClient((request) => {
      if (request.type === 'diagnostics.snapshot')
        return { ...snapshot, recentEvents: ['too long'.repeat(2_000)] }
      if (request.type === 'diagnostics.show') return { shown: true }
      throw new Error(`unexpected ${request.type}`)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await expect(store.readDiagnostics()).resolves.toBeUndefined()
    await store.showDiagnostics()
    expect(client.requests.map((request) => request.type)).toEqual([
      'diagnostics.snapshot',
      'diagnostics.show',
    ])
    store.dispose()
  })
})
