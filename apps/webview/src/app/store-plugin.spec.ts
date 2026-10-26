// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { FeatureHostEvent, HostMessage } from '@dsh-vscode/webview-protocol'

import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

class PluginClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private readonly featureListeners = new Set<(message: FeatureHostEvent) => void>()

  public constructor(private readonly value: unknown) {}

  public request<T>(_request: WebviewRequest): Promise<T> {
    return Promise.resolve(this.value as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public subscribeFeature(listener: (message: FeatureHostEvent) => void): () => void {
    this.featureListeners.add(listener)
    return () => this.featureListeners.delete(listener)
  }

  public emitFeature(message: FeatureHostEvent): void {
    for (const listener of this.featureListeners) listener(message)
  }

  public dispose(): void {
    this.listeners.clear()
    this.featureListeners.clear()
  }
}

describe('AppStore plugin inventory projection', () => {
  afterEach(() => document.body.replaceChildren())

  it('retains RC2 inventory groups without inventing preset ownership', async () => {
    const remoteGroup = {
      id: 'standard',
      name: 'Standard mode',
      isDefault: true,
      rows: [],
    }
    const store = createAppStore(
      new PluginClient({ entries: [], agentPresets: [remoteGroup] }) as unknown as ProtocolClient,
    )

    await expect(store.loadPluginInventory()).resolves.toEqual({
      entries: [],
      agentPresets: [remoteGroup],
    })
    store.dispose()
  })

  it('rejects a plugin snapshot containing a malformed entry', async () => {
    const store = createAppStore(
      new PluginClient({
        entries: [
          { entryId: 'valid', moduleName: '@dsh/valid', enabled: true, fiberPhase: null },
          { entryId: 'broken', moduleName: '@dsh/broken', enabled: 'yes', fiberPhase: null },
        ],
      }) as unknown as ProtocolClient,
    )

    await expect(store.loadPluginInventory()).resolves.toBeUndefined()
    store.dispose()
  })

  it('tracks only the safe install phase and refreshes inventories on manager changes', () => {
    const client = new PluginClient(undefined)
    const store = createAppStore(client as unknown as ProtocolClient)
    const identity = {
      backendInstanceId: 'backend-1',
      connectionGeneration: 1,
      stream: 'local' as const,
      localSeq: 1,
    }

    client.emitFeature({
      type: 'feature.event',
      name: 'plugin.install.progress',
      identity,
      requestId: 'plugin-manager-install-1',
      phase: 'installing',
      attemptIndex: 2,
      attemptTotal: 3,
    })
    expect(store.pluginInstallProgress).toEqual({
      requestId: 'plugin-manager-install-1',
      phase: 'installing',
      attemptIndex: 2,
      attemptTotal: 3,
    })

    client.emitFeature({
      type: 'feature.event',
      name: 'plugin.manager.changed',
      identity: { ...identity, localSeq: 2 },
    })
    expect(store.pluginInventoryRevision).toBe(1)
    expect(store.pluginInstallProgress).toBeUndefined()
    store.dispose()
  })
})
