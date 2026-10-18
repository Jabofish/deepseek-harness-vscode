// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const provider = { id: 'provider', name: 'Provider', kind: 'builtin', configurable: false, fields: [] }
const model = { id: 'model', providerId: provider.id, label: 'Model', supportsReasoning: false }
const roster = { presets: [], authorable: false, modeSelectionEnabled: true }

function response(request: WebviewRequest): unknown {
  switch (request.type) {
    case 'providers.list':
      return [provider]
    case 'models.list':
      return [model]
    case 'preset.list':
      return roster
    case 'permissions.presets.list':
      return ['default']
    case 'session.list':
      return { items: [] }
    case 'workspace.list':
      return { items: [], archivedSessionIds: [] }
    default:
      return []
  }
}

const catalogTypes = ['providers.list', 'models.list', 'preset.list', 'permissions.presets.list'] as const

describe('Global catalog response latency', () => {
  it.each(catalogTypes)('publishes healthy directories while %s remains pending', async (slow) => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const client = {
      subscribe: () => () => {},
      dispose: () => {},
      request: async (request: WebviewRequest) => {
        if (request.type === slow) await pending
        return response(request)
      },
    }
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.refreshSessions()
      await vi.waitFor(() => {
        if (slow !== 'providers.list') expect(store.providers).toEqual([provider])
        if (slow !== 'models.list') expect(store.models).toEqual([model])
        if (slow !== 'preset.list') expect(store.getState().presetSelectionEnabled).toBe(true)
        if (slow !== 'permissions.presets.list')
          expect(store.getState().newSessionPermissionPresets).toEqual(['default'])
      })
      finish()
      await vi.waitFor(() => {
        expect(store.providers).toEqual([provider])
        expect(store.models).toEqual([model])
        expect(store.getState().presetSelectionEnabled).toBe(true)
        expect(store.getState().newSessionPermissionPresets).toEqual(['default'])
      })
    } finally {
      finish()
      store.dispose()
    }
  })

  it.each(['providers.list', 'models.list'] as const)(
    'publishes the other model directory before a settings refresh of %s finishes',
    async (slow) => {
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const client = {
        subscribe: () => () => {},
        dispose: () => {},
        request: async (request: WebviewRequest) => {
          if (request.type === slow) await pending
          return response(request)
        },
      }
      const store = createAppStore(client as unknown as ProtocolClient)
      const refresh = store.refreshModelCatalog()
      try {
        await vi.waitFor(() => {
          if (slow === 'providers.list') expect(store.models).toEqual([model])
          else expect(store.providers).toEqual([provider])
        })
      } finally {
        finish()
        await refresh
        store.dispose()
      }
    },
  )
})
