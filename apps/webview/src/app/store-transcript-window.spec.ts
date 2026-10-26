// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { HostMessage, TranscriptWindow, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

function window(sessionId: string, revision = 1, markdown = 'Final reply'): TranscriptWindow {
  return {
    sessionId,
    revision,
    nodes: [
      { kind: 'assistant-message', id: `reply-${sessionId}`, markdown, streaming: false, sequence: 10 },
    ],
    eventFacts: [{ id: 'event-10', type: 'message.completed', sequence: 10, representedSequences: 1 }],
    lastSequence: 10,
    hasMore: true,
    beforeSequence: 5,
    historical: false,
    omittedNodeIds: [],
  }
}
function detail(sessionId: string): Record<string, unknown> {
  return {
    id: sessionId,
    workspaceId: 'workspace',
    title: 'Fixture',
    blank: false,
    status: 'idle',
    createdAt: '2026-10-14T00:00:00Z',
    updatedAt: '2026-10-14T00:00:00Z',
    history: [],
    transcript: window(sessionId),
    historyHasMore: true,
    historyBeforeSequence: 5,
  }
}
class Client {
  public readonly requests: WebviewRequest[] = []
  public open: ((sessionId: string) => Promise<unknown>) | undefined
  private readonly listeners = new Set<(message: HostMessage) => void>()
  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    let result: unknown = []
    if (request.type === 'session.open')
      return (this.open?.(request.payload.sessionId) ??
        Promise.resolve(detail(request.payload.sessionId))) as Promise<T>
    if (request.type === 'subagent.list') result = { entries: [], parentAvailable: true }
    if (request.type === 'session.transcript.resync')
      result = { transcript: window(request.payload.sessionId, 2) }
    if (request.type === 'session.transcript.navigate')
      result = {
        ...window(request.payload.sessionId, request.payload.revision + 1, 'Older reply'),
        historical: true,
      }
    if (request.type === 'session.transcript.node')
      result = {
        node: {
          kind: 'assistant-message',
          id: request.payload.nodeId,
          markdown: 'Whole live body',
          streaming: true,
        },
      }
    if (request.type === 'session.transcript.content') result = { content: 'Complete reply' }
    return Promise.resolve(result as T)
  }
  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  public emit(window: TranscriptWindow): void {
    this.send('session.transcript', window, window.revision)
  }
  public send(name: string, payload: unknown, sequence = 1): void {
    for (const listener of this.listeners) listener({ type: 'event', name, sequence, payload })
  }
  public dispose(): void {
    this.listeners.clear()
  }
}

describe('Webview installs Host windows', () => {
  it('loads the complete message text through the content route', async () => {
    const client = new Client()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s')
      await expect(store.loadTranscriptContent('reply-s')).resolves.toBe('Complete reply')
      expect(client.requests.at(-1)).toMatchObject({
        type: 'session.transcript.content',
        payload: { sessionId: 's', revision: 1, nodeId: 'reply-s' },
      })
    } finally {
      store.dispose()
    }
  })

  it('loads a complete structured live node through the scoped transcript route', async () => {
    const client = new Client()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s')
      await expect(store.loadTranscriptNode('reply-s')).resolves.toMatchObject({
        id: 'reply-s',
        markdown: 'Whole live body',
        streaming: true,
      })
      expect(client.requests.at(-1)).toMatchObject({
        type: 'session.transcript.node',
        payload: { sessionId: 's', revision: 1, nodeId: 'reply-s' },
      })
    } finally {
      store.dispose()
    }
  })

  it('requests authoritative recovery when a full window is malformed', async () => {
    const client = new Client()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s')
      client.send('session.transcript', { ...window('s', 2), nodes: 'invalid nodes' })
      for (let index = 0; index < 30; index++) await Promise.resolve()
      expect(
        client.requests.filter(
          (request) => request.type === 'session.open' && request.payload.sessionId === 's',
        ).length,
      ).toBe(1)
      expect(client.requests.filter((request) => request.type === 'session.transcript.resync')).toHaveLength(
        1,
      )
      expect(store.getState().transcript?.nodes[0]).toMatchObject({ markdown: 'Final reply' })
    } finally {
      store.dispose()
    }
  })

  it('applies pending interactions immediately even when an open fails', async () => {
    const client = new Client()
    let reject: ((error: Error) => void) | undefined
    client.open = () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      const opening = store.openSession('s')
      const result = expect(opening).rejects.toThrow('open failed')
      for (let i = 0; i < 20 && reject === undefined; i++) await Promise.resolve()
      client.send('permission.requested', {
        request: {
          id: 'approval',
          sessionId: 's',
          title: 'Allow?',
          description: 'Fixture',
          risk: 'medium',
          options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
        },
      })
      expect(store.permissions.map((request) => request.id)).toEqual(['approval'])
      reject?.(new Error('open failed'))
      await result
      expect(store.permissions.map((request) => request.id)).toEqual(['approval'])
    } finally {
      store.dispose()
    }
  })
})
