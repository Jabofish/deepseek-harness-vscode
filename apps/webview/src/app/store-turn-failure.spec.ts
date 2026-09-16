// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'session-turn-failure'

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
          workspaceId: 'workspace-turn-failure',
          title: 'Turn failure fixture',
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
        return { models: [] }
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

function failureOf(store: ReturnType<typeof createAppStore>): { readonly message: string } | undefined {
  const node = store.timeline.nodes.find((entry) => entry.kind === 'turn-terminal')
  return node?.kind === 'turn-terminal' ? node.failure : undefined
}

describe('AppStore turn failure rows', () => {
  it('keeps a provider failure message longer than 320 characters', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The host persists the provider adapter's own failure message with no
    // length bound and the reference client renders it whole in its turn-error
    // row, so the clipped copy here would cut the user's only diagnosis with
    // nothing on screen to reveal the loss.
    const message = `DeepSeek API error (HTTP 400): ${'invalid request field '.repeat(20)}`.trim()
    expect(message.length).toBeGreaterThan(320)
    client.emit({
      type: 'event',
      name: 'turn.ended',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        turn: 1,
        reason: { kind: 'error', error: { code: 'PROVIDER_UNAVAILABLE', message } },
      },
    })
    await settle()

    expect(failureOf(store)).toEqual({ code: 'PROVIDER_UNAVAILABLE', message })
    store.dispose()
  })
})
