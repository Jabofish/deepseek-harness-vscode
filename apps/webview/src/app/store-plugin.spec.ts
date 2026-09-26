// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { FeatureHostEvent, HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'

import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

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

  it('retains the optional alpha.2 agent-preset composition groups', async () => {
    const store = createAppStore(
      new PluginClient({
        entries: [],
        agentPresets: [
          {
            id: 'standard',
            trust: 'system',
            name: 'Standard',
            isDefault: true,
            rows: [
              {
                entryId: null,
                moduleName: '@deepseek-ai/dsh-host-web',
                enabled: 'conditional',
                condition: 'settings.web.enabled',
                fiberPhase: null,
              },
            ],
          },
        ],
      }) as unknown as ProtocolClient,
    )

    await expect(store.loadPluginInventory()).resolves.toMatchObject({
      entries: [],
      agentPresets: [
        {
          id: 'standard',
          trust: 'system',
          name: 'Standard',
          isDefault: true,
          rows: [
            {
              entryId: null,
              enabled: 'conditional',
              condition: 'settings.web.enabled',
              fiberPhase: null,
            },
          ],
        },
      ],
    })
    store.dispose()
  })

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

  it('rejects a plugin snapshot containing a malformed group', async () => {
    const store = createAppStore(
      new PluginClient({
        entries: [],
        agentPresets: [
          { id: 'bad', trust: 'system', isDefault: false, rows: [{ moduleName: 'missing-id' }] },
          { id: 'good', trust: 'user', isDefault: false, rows: [] },
        ],
      }) as unknown as ProtocolClient,
    )

    await expect(store.loadPluginInventory()).resolves.toBeUndefined()
    store.dispose()
  })

  it('rejects an ownership value outside the fields supported by the inventory DTO', async () => {
    const store = createAppStore(
      new PluginClient({
        entries: [],
        agentPresets: [{ id: 'mode', trust: 'deployment', isDefault: false, rows: [] }],
      }) as unknown as ProtocolClient,
    )

    await expect(store.loadPluginInventory()).resolves.toBeUndefined()
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
