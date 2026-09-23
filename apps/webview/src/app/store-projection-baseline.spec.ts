// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class ProjectionClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(_request: WebviewRequest): Promise<T> {
    return Promise.resolve(undefined as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
  }
}

function event(sequence: number, name: string, payload: unknown): HostMessage {
  return { type: 'event', name, sequence, payload }
}

function settle(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 24))
}

describe('Webview projection control baselines', () => {
  it('replaces omitted keys on reconnect, applies empty baselines, and keeps deltas single-key', async () => {
    const client = new ProjectionClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit(
        event(1, 'session.projection.baseline', {
          projections: {
            's-1': { asOfSequence: 10, values: { keep: 'old', removed: 'old' } },
            's-2': { asOfSequence: 4, values: { stale: true } },
          },
        }),
      )
      await settle()
      expect(store.projections).toEqual({
        's-1': { keep: 'old', removed: 'old' },
        's-2': { stale: true },
      })

      // A new control generation is a whole-set baseline. Missing keys and
      // explicitly empty per-session values both remove the previous keys.
      client.emit(
        event(2, 'session.projection.baseline', {
          projections: {
            's-1': { asOfSequence: 11, values: { keep: 'new' } },
            's-2': { asOfSequence: 5, values: {} },
          },
        }),
      )
      await settle()
      expect(store.projections).toEqual({ 's-1': { keep: 'new' }, 's-2': {} })

      client.emit(
        event(3, 'session.projection', {
          sessionId: 's-1',
          key: 'delta',
          value: 'only this key',
          sequence: 12,
        }),
      )
      await settle()
      expect(store.projections).toEqual({ 's-1': { keep: 'new', delta: 'only this key' }, 's-2': {} })

      client.emit(event(4, 'session.projection.baseline', { projections: {} }))
      await settle()
      expect(store.projections).toEqual({})
    } finally {
      store.dispose()
    }
  })
})
