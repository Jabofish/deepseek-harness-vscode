// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'session-images'

class StreamClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    return Promise.resolve(this.response(request) as T)
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

  private response(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open':
        return {
          id: SESSION_ID,
          workspaceId: 'workspace-images',
          title: 'Image fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
          history: [],
          permissionPresets: ['workspace-write'],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        }
      case 'models.session.list':
        return {
          models: [],
          failures: [],
          current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          routable: true,
        }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }
}

function settle(milliseconds = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

describe('tool image transport and replay', () => {
  it('retains validated references through the store and rejects malformed references', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession(SESSION_ID)
      const image = { attachmentId: 'opaque-image', mediaType: 'image/png', bytes: 80, width: 2, height: 1 }
      client.emit({
        type: 'event',
        name: 'tool.updated',
        sequence: 1,
        payload: {
          sessionId: SESSION_ID,
          tool: { id: 'image-tool', name: 'read_image', status: 'completed', images: [image] },
        },
      })
      await settle()
      expect(store.timeline.nodes.find((node) => node.id === 'image-tool')).toMatchObject({
        tool: { images: [image] },
      })
      client.emit({
        type: 'event',
        name: 'tool.updated',
        sequence: 2,
        payload: {
          sessionId: SESSION_ID,
          tool: {
            id: 'invalid-tool',
            name: 'read_image',
            status: 'completed',
            images: [{ ...image, width: -1 }],
          },
        },
      })
      await settle()
      expect(store.timeline.nodes.some((node) => node.kind === 'tool' && node.id === 'invalid-tool')).toBe(
        false,
      )
    } finally {
      store.dispose()
    }
  })
})
