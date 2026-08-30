// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'

import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class PluginClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly value: unknown) {}

  public request<T>(_request: WebviewRequest): Promise<T> {
    return Promise.resolve(this.value as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
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

  it('drops malformed groups while retaining valid groups at the Webview boundary', async () => {
    const store = createAppStore(
      new PluginClient({
        entries: [],
        agentPresets: [
          { id: 'bad', trust: 'system', isDefault: false, rows: [{ moduleName: 'missing-id' }] },
          { id: 'good', trust: 'user', isDefault: false, rows: [] },
        ],
      }) as unknown as ProtocolClient,
    )

    await expect(store.loadPluginInventory()).resolves.toMatchObject({
      agentPresets: [{ id: 'good', trust: 'user', isDefault: false, rows: [] }],
    })
    store.dispose()
  })
})
