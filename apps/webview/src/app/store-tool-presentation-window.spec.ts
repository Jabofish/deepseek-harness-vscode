// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ToolCallView } from '@dsh-vscode/domain'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

const SESSION_ID = 'session-presentation-window'

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
          workspaceId: 'workspace-window',
          title: 'Presentation window fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
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

function toolOf(store: ReturnType<typeof createAppStore>, callId: string): ToolCallView | undefined {
  const node = store.timeline.nodes.find((entry) => entry.kind === 'tool' && entry.tool.id === callId)
  return node?.kind === 'tool' ? node.tool : undefined
}

describe('store tool presentation windows', () => {
  it('preserves a validated Auto review denial through the Webview event projection', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 3,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-auto-review-denied',
          name: 'future_tool',
          status: 'failed',
          error: 'ordinary raw error',
          autoReviewDenial: { reason: 'raw reviewer reason' },
          metadata: {},
        },
      },
    })
    await settle()

    expect(toolOf(store, 'call-auto-review-denied')?.autoReviewDenial).toEqual({
      reason: 'raw reviewer reason',
    })
  })

  it('rejects malformed Auto review denial payloads at the Webview projection boundary', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 4,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-malformed-auto-review-denial',
          name: 'future_tool',
          status: 'failed',
          autoReviewDenial: { reason: { unexpected: 'object' } },
          metadata: {},
        },
      },
    })
    await settle()

    expect(toolOf(store, 'call-malformed-auto-review-denial')).toBeUndefined()
  })
})
