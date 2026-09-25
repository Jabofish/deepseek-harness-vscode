// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, FeatureHostEvent } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class TurnEventsClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private readonly featureListeners = new Set<(message: FeatureHostEvent) => void>()

  public request<T>(): Promise<T> {
    return Promise.reject(new Error('Unexpected request in turn event test.'))
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public subscribeFeature(listener: (message: FeatureHostEvent) => void): () => void {
    this.featureListeners.add(listener)
    return () => this.featureListeners.delete(listener)
  }

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
  }

  public listenerCount(): number {
    return this.listeners.size
  }

  public dispose(): void {
    this.listeners.clear()
    this.featureListeners.clear()
  }
}

function turnEvent(
  sequence: number,
  name: 'turn.started' | 'turn.ended',
  sessionId: string,
  turn: number,
  reason?: 'completed' | 'aborted',
): HostMessage {
  return {
    type: 'event',
    sequence,
    name,
    payload: {
      sessionId,
      turn,
      ...(reason === undefined ? {} : { reason: { kind: reason } }),
    },
  }
}

describe('AppStore Session turn watcher', () => {
  it('waits for the matching turn end in the created Session', async () => {
    const client = new TurnEventsClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    const watcher = store.watchSessionTurnEnd('session-new')
    let settled = false
    void watcher.completion.then(() => {
      settled = true
    })

    client.emit(turnEvent(1, 'turn.started', 'session-other', 1))
    client.emit(turnEvent(2, 'turn.ended', 'session-new', 1, 'completed'))
    client.emit(turnEvent(3, 'turn.started', 'session-new', 4))
    client.emit(turnEvent(4, 'turn.ended', 'session-new', 3, 'completed'))
    await Promise.resolve()
    expect(settled).toBe(false)

    client.emit(turnEvent(5, 'turn.ended', 'session-new', 4, 'completed'))
    await expect(watcher.completion).resolves.toBeUndefined()
    store.dispose()
  })

  it('settles a structured aborted turn and releases watcher resources on disposal', async () => {
    const client = new TurnEventsClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    const watcher = store.watchSessionTurnEnd('session-cancelled')
    client.emit(turnEvent(1, 'turn.started', 'session-cancelled', 2))
    client.emit(turnEvent(2, 'turn.ended', 'session-cancelled', 2, 'aborted'))
    await expect(watcher.completion).resolves.toBeUndefined()
    store.dispose()
    expect(client.listenerCount()).toBe(0)

    const disposedClient = new TurnEventsClient()
    const disposedStore = createAppStore(disposedClient as unknown as ProtocolClient)
    const pending = disposedStore.watchSessionTurnEnd('session-pending')
    disposedStore.dispose()
    await expect(pending.completion).rejects.toMatchObject({ name: 'SessionTurnWatchDisposedError' })
    expect(disposedClient.listenerCount()).toBe(0)
  })
})
