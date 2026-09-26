// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class PresetBoundaryClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly respond: (request: WebviewRequest) => unknown) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    return Promise.resolve(this.respond(request) as T)
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

const preset = { id: 'legacy-default', trust: 'system', isDefault: true } as const

function connectionSnapshot(sequence: number, payload: unknown): HostMessage {
  return { type: 'event', name: 'connection.snapshot', sequence, payload }
}

function responseFor(roster: unknown, request: WebviewRequest): unknown {
  switch (request.type) {
    case 'preset.list':
      return roster
    case 'session.list':
    case 'workspace.list':
      return { items: [] }
    case 'providers.list':
    case 'models.list':
      return []
    default:
      return undefined
  }
}

describe('Webview preset boundaries', () => {
  it('preserves explicit preset location and removal capabilities from the Host', async () => {
    const client = new PresetBoundaryClient((request) =>
      responseFor(
        {
          presets: [preset],
          authorable: false,
          canOpenPresetLocation: false,
          canRemoveUserPresets: false,
          compositionReadable: true,
        },
        request,
      ),
    )
    const store = createAppStore(client as unknown as ProtocolClient)

    try {
      const roster = await store.loadPresetRoster()

      expect(roster).toMatchObject({
        canOpenPresetLocation: false,
        canRemoveUserPresets: false,
        compositionReadable: true,
      })
    } finally {
      store.dispose()
    }
  })

  it('clears the previous connection capability when the replacement roster omits it', async () => {
    let roster: unknown = {
      presets: [preset],
      authorable: false,
      hasDocument: false,
      modeSelectionEnabled: true,
    }
    const client = new PresetBoundaryClient((request) => responseFor(roster, request))
    const store = createAppStore(client as unknown as ProtocolClient)

    try {
      client.emit(connectionSnapshot(1, { kind: 'connected', dshVersion: '0.1.7-alpha.1' }))
      await store.loadPresetRoster()
      expect(store.presetSelectionEnabled).toBe(true)

      client.emit(connectionSnapshot(2, { kind: 'idle' }))
      expect(store.presetSelectionEnabled).toBeUndefined()

      roster = { presets: [{ ...preset, id: 'legacy' }], authorable: false, hasDocument: false }
      client.emit(connectionSnapshot(3, { kind: 'connected', dshVersion: '0.1.6-alpha.1' }))
      await store.loadPresetRoster()

      expect(store.presetSelectionEnabled).toBeUndefined()
      expect(store.presets).toEqual([{ ...preset, id: 'legacy' }])
    } finally {
      store.dispose()
    }
  })

  it('clears an earlier capability when a valid refreshed catalog omits it', async () => {
    let roster: unknown = {
      presets: [preset],
      authorable: false,
      hasDocument: false,
      modeSelectionEnabled: true,
    }
    const client = new PresetBoundaryClient((request) => responseFor(roster, request))
    const store = createAppStore(client as unknown as ProtocolClient)

    try {
      await store.loadPresetRoster()
      expect(store.presetSelectionEnabled).toBe(true)

      roster = { presets: [preset], authorable: false, hasDocument: false }
      await store.refreshSessions()

      expect(store.presetSelectionEnabled).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it.each([
    { field: 'name', value: 42 },
    { field: 'description', value: false },
    { field: 'broken', value: { reason: 'malformed' } },
  ] as const)(
    'rejects a preset with a non-string optional $field before it enters UI state',
    async ({ field, value }) => {
      const descriptor: Record<string, unknown> = { ...preset, [field]: value }
      const client = new PresetBoundaryClient((request) =>
        responseFor({ presets: [descriptor], authorable: false, hasDocument: false }, request),
      )
      const store = createAppStore(client as unknown as ProtocolClient)

      try {
        expect(await store.loadPresetRoster()).toBeUndefined()
        expect(store.presets).toEqual([])
      } finally {
        store.dispose()
      }
    },
  )

  it.each([
    { field: 'canOpenPresetLocation', value: 'no' },
    { field: 'canRemoveUserPresets', value: 1 },
  ] as const)('rejects a roster with a malformed optional $field capability', async ({ field, value }) => {
    const client = new PresetBoundaryClient((request) =>
      responseFor({ presets: [preset], authorable: false, [field]: value }, request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)

    try {
      expect(await store.loadPresetRoster()).toBeUndefined()
      expect(store.presets).toEqual([])
    } finally {
      store.dispose()
    }
  })
})
