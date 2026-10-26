// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

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
