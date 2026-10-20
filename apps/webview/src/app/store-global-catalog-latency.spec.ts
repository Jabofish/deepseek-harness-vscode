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
  it('refreshes session membership without rereading catalogs or retiring their pending startup read', async () => {
    let emit: Parameters<ProtocolClient['subscribe']>[0] = () => {}
    let finishModels!: (value: unknown) => void
    const pendingModels = new Promise<unknown>((resolve) => {
      finishModels = resolve
    })
    const requests: WebviewRequest[] = []
    const client = {
      subscribe: (listener: typeof emit) => {
        emit = listener
        return () => {}
      },
      dispose: () => {},
      request: (request: WebviewRequest) => {
        requests.push(request)
        return request.type === 'models.list' ? pendingModels : Promise.resolve(response(request))
      },
    }
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.refreshSessions()
      for (const [index, name] of ['session.added', 'workspace.changed', 'session.removed'].entries())
        emit({ type: 'event', name, sequence: index + 1, payload: { sessionId: 'new-session' } })
      await vi.waitFor(() =>
        expect(requests.filter((request) => request.type === 'session.list')).toHaveLength(4),
      )
      for (const type of catalogTypes)
        expect(requests.filter((request) => request.type === type)).toHaveLength(1)
      finishModels([model])
      await vi.waitFor(() => expect(store.models).toEqual([model]))
      emit({
        type: 'event',
        name: 'remote.event',
        sequence: 4,
        payload: { name: 'settings/document-updated' },
      })
      expect(requests.filter((request) => request.type === 'models.list')).toHaveLength(2)
      expect(requests.filter((request) => request.type === 'providers.list')).toHaveLength(2)
    } finally {
      finishModels([model])
      store.dispose()
    }
  })

  it('does not install a pending catalog from a disconnected backend after a directory-only refresh', async () => {
    let emit: Parameters<ProtocolClient['subscribe']>[0] = () => {}
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const client = {
      subscribe: (listener: typeof emit) => {
        emit = listener
        return () => {}
      },
      dispose: () => {},
      request: async (request: WebviewRequest) => {
        if (catalogTypes.some((type) => request.type === type)) await pending
        return response(request)
      },
    }
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.refreshSessions()
      emit({ type: 'event', name: 'workspace.changed', sequence: 1, payload: {} })
      emit({ type: 'event', name: 'connection.lost', sequence: 2, payload: {} })
      finish()
      // Flush the catalog continuations as well as the directory responses.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(store.models).toEqual([])
      expect(store.providers).toEqual([])
      expect(store.getState().newSessionPermissionPresets).toEqual([])
    } finally {
      finish()
      store.dispose()
    }
  })

  it('keeps catalogs loading across duplicate app.ready snapshots and refreshes a replacement identity', async () => {
    let emit: Parameters<ProtocolClient['subscribe']>[0] = () => {}
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const requests: WebviewRequest[] = []
    const client = {
      subscribe: (listener: typeof emit) => {
        emit = listener
        return () => {}
      },
      dispose: () => {},
      request: async (request: WebviewRequest) => {
        requests.push(request)
        if (catalogTypes.some((type) => request.type === type)) await pending
        return response(request)
      },
    }
    const store = createAppStore(client as unknown as ProtocolClient)
    const snapshot = (generation: number, sequence: number): void =>
      emit({
        type: 'event',
        name: 'connection.snapshot',
        sequence,
        payload: { kind: 'connected', backendInstanceId: 'backend', connectionGeneration: generation },
      })
    try {
      snapshot(1, 1)
      snapshot(1, 2)
      expect(requests.filter((request) => request.type === 'models.list')).toHaveLength(1)
      finish()
      await vi.waitFor(() => expect(store.models).toEqual([model]))
      expect(store.getState().newSessionPermissionPresets).toEqual(['default'])
      snapshot(2, 3)
      expect(requests.filter((request) => request.type === 'models.list')).toHaveLength(2)
    } finally {
      finish()
      store.dispose()
    }
  })

  it('retains the native default across the Host response and clears it on disconnect', async () => {
    let emit: Parameters<ProtocolClient['subscribe']>[0] = () => {}
    const client = {
      subscribe: (listener: typeof emit) => {
        emit = listener
        return () => {}
      },
      dispose: () => {},
      request: (request: WebviewRequest) =>
        Promise.resolve(
          request.type === 'permissions.presets.list'
            ? { items: ['organization-safe', 'read-only'], defaultPreset: 'read-only' }
            : response(request),
        ),
    }
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.refreshSessions()
      await vi.waitFor(() => expect(store.getState().newSessionPermissionDefault).toBe('read-only'))
      expect(store.getState().newSessionPermissionPresets).toEqual(['organization-safe', 'read-only'])
      emit({ type: 'event', name: 'connection.lost', sequence: 1, payload: {} })
      expect(store.getState().newSessionPermissionDefault).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

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
