// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AccountLifecycleSnapshotDto,
  FeatureHostEvent,
  FeatureRequest,
  HostMessage,
} from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const attemptId = 'd80ff092-0cdd-4a34-b5fb-05503d8574d8'
const snapshot = {
  status: 'signed-out' as const,
  attempt: { id: attemptId, phase: 'waiting-browser' as const },
}

class AccountStoreClient {
  public readonly accountRequests: FeatureRequest[] = []
  private readonly hostListeners = new Set<(message: HostMessage) => void>()
  private readonly featureListeners = new Set<(message: FeatureHostEvent) => void>()

  public request<T>(_request: never): Promise<T> {
    return Promise.resolve(undefined as T)
  }

  public featureRequest<T>(request: FeatureRequest): Promise<T> {
    this.accountRequests.push(request)
    const payload =
      request.type === 'account.signOutImpact'
        ? { kind: 'account.impact', impact: 'unknown' }
        : { kind: 'account.lifecycle', snapshot }
    return Promise.resolve(payload as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.hostListeners.add(listener)
    return () => this.hostListeners.delete(listener)
  }

  public subscribeFeature(listener: (message: FeatureHostEvent) => void): () => void {
    this.featureListeners.add(listener)
    return () => this.featureListeners.delete(listener)
  }

  public dispose(): void {
    this.hostListeners.clear()
    this.featureListeners.clear()
  }

  public connected(generation: number, accountLifecycleAvailable: boolean): void {
    const message: HostMessage = {
      type: 'event',
      name: 'connection.snapshot',
      sequence: generation,
      payload: {
        kind: 'connected',
        backendInstanceId: 'backend-instance',
        connectionGeneration: generation,
        dshVersion: generation === 1 ? '0.1.7-rc.2' : '0.1.2-alpha.1',
        accountLifecycleAvailable,
      },
    }
    for (const listener of this.hostListeners) listener(message)
  }

  public update(snapshotValue: AccountLifecycleSnapshotDto): void {
    const message: FeatureHostEvent = {
      type: 'feature.event',
      name: 'account.lifecycle.updated',
      identity: {
        backendInstanceId: 'backend-instance',
        connectionGeneration: 1,
        stream: 'host',
        localSeq: 1,
      },
      snapshot: snapshotValue,
    }
    for (const listener of this.featureListeners) listener(message)
  }
}

describe('account lifecycle store', () => {
  afterEach(() => document.body.replaceChildren())

  it('uses only capability-gated account requests and applies safe state events', async () => {
    const client = new AccountStoreClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    client.connected(1, true)

    expect(store.getState().accountLifecycleAvailable).toBe(true)
    await store.loadAccountLifecycle()
    await store.startAccountSignIn()
    await store.cancelAccountSignIn(attemptId)
    await store.checkAccountSignOutImpact()
    await store.signOutAccount()

    expect(client.accountRequests.map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: 'account.state', payload: {} },
      { type: 'account.signIn', payload: {} },
      { type: 'account.cancelSignIn', payload: { attemptId } },
      { type: 'account.signOutImpact', payload: {} },
      { type: 'account.signOut', payload: {} },
    ])
    expect(JSON.stringify(client.accountRequests)).not.toMatch(
      /authorizeUrl|code_challenge|token|callbackOrigin/u,
    )
    expect(store.getState().accountLifecycleImpact).toBe('unknown')

    const liveSnapshot = { status: 'credential-stored' as const, attempt: null }
    client.update(liveSnapshot)
    expect(store.getState().accountLifecycle).toEqual(liveSnapshot)
    store.dispose()
  })

  it('hides account controls without the selected adapter capability', async () => {
    const client = new AccountStoreClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    client.connected(1, false)

    expect(store.getState().accountLifecycleAvailable).toBe(false)
    await store.loadAccountLifecycle()
    await store.startAccountSignIn()
    expect(client.accountRequests).toEqual([])
    store.dispose()
  })
})
