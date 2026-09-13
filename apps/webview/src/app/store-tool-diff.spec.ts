// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'session-diff'

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
          workspaceId: 'workspace-diff',
          title: 'Diff fixture',
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

function presentationOf(store: ReturnType<typeof createAppStore>, callId: string): unknown {
  const node = store.timeline.nodes.find((entry) => entry.kind === 'tool' && entry.tool.id === callId)
  return node?.kind === 'tool' ? node.tool.presentation : undefined
}

describe('store tool diff presentations', () => {
  it('keeps a removal-only hunk whose new text is legitimately empty', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The pinned DSH `edit` result carries `newText: ''` for a hunk that only
    // removes lines, and the `write` call view does the same for a file written
    // with empty content. The webview parse is the last gate before the card.
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-removal',
          name: 'edit',
          status: 'completed',
          title: 'Edit src/feature.ts',
          category: 'diff',
          turn: 0,
          step: 0,
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Edit src/feature.ts',
            diffs: [{ path: 'src/feature.ts', oldText: 'const removed = 1', newText: '' }],
          },
        },
      },
    })
    await settle()

    expect(presentationOf(store, 'call-removal')).toMatchObject({
      card: 'diff',
      diffs: [{ path: 'src/feature.ts', oldText: 'const removed = 1', newText: '' }],
    })

    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 2,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-cleared',
          name: 'write',
          status: 'running',
          title: 'Write notes.md',
          category: 'diff',
          presentation: {
            phase: 'call',
            card: 'diff',
            title: 'Write notes.md',
            diffs: [{ path: 'notes.md', oldText: null, newText: '' }],
          },
        },
      },
    })
    await settle()

    expect(presentationOf(store, 'call-cleared')).toMatchObject({
      card: 'diff',
      diffs: [{ path: 'notes.md', oldText: null, newText: '' }],
    })
    store.dispose()
  })
})
