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
      ).toBe(2)
      expect(store.getState().transcript?.nodes[0]).toMatchObject({ markdown: 'Final reply' })
    } finally {
      store.dispose()
    }
  })

  it('notifies subscribers synchronously when a Host view arrives', async () => {
    const client = new Client()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s')
      const revisions: number[] = []
      const unsubscribe = store.subscribe(() => revisions.push(store.getState().transcript!.revision))
      client.emit(window('s', 2, 'Immediate reply'))
      expect(revisions).toEqual([2])
      unsubscribe()
      client.emit(window('s', 3, 'Next reply'))
      expect(revisions).toEqual([2])
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
  it('rejects raw-only opens without reviving a compatibility engine or replacing the current view', async () => {
    const client = new Client()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('current')
      client.open = (id) =>
        Promise.resolve({
          ...detail(id),
          transcript: undefined,
          history: [{ sequence: 1, event: { type: 'message.user' } }],
        })
      await expect(store.openSession('legacy')).rejects.toThrow()
      expect(store.activeSessionId).toBe('current')
      expect(store.timeline.nodes[0]).toMatchObject({ markdown: 'Final reply' })
      expect(store.getState()).not.toHaveProperty('history')
    } finally {
      store.dispose()
    }
  })

  it('does not parse, buffer or replay raw transcript frames and never requests a gap page', async () => {
    const client = new Client()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s')
      for (const name of [
        'message.delta',
        'message.completed',
        'tool.updated',
        'session.gap',
        'compaction.updated',
        'todo.updated',
      ])
        client.send(name, {
          sessionId: 's',
          sequence: 99,
          messageId: 'raw',
          delta: 'RAW_BODY',
          markdown: 'RAW_BODY',
          fromSequence: 1,
          toSequence: 98,
        })
      expect(store.timeline.nodes[0]).toMatchObject({ markdown: 'Final reply' })
      expect(JSON.stringify(store.getState())).not.toContain('RAW_BODY')
      expect(client.requests.map((request) => request.type)).not.toContain('session.history')
      expect(store.getState()).not.toHaveProperty('history')
    } finally {
      store.dispose()
    }
  })
  it('replaces views without a durable ledger and releases previous session bodies from the roster', async () => {
    const client = new Client()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s')
      expect(store.getState()).not.toHaveProperty('history')
      expect(store.getState().timeline.nodes[0]).toMatchObject({ markdown: 'Final reply' })
      client.emit(window('s', 2, 'Latest complete response'))
      client.emit(window('s', 1, 'Stale reply'))
      expect(store.getState().timeline.nodes[0]).toMatchObject({ markdown: 'Latest complete response' })
      await store.loadOlderHistory()
      expect(store.getState().timeline.nodes).toHaveLength(1)
      expect(store.getState().timeline.nodes[0]).toMatchObject({ markdown: 'Older reply' })
      expect(client.requests.map((request) => request.type)).not.toContain('session.history')
      expect(client.requests).toContainEqual(
        expect.objectContaining({ type: 'session.transcript.ack', payload: { sessionId: 's', revision: 2 } }),
      )
      await store.openSession('other')
      expect(JSON.stringify(store.getState().sessions)).not.toContain('markdown')
      expect(store.getState()).not.toHaveProperty('history')
      client.emit(window('s', 100, 'Wrong session'))
      expect(store.getState().timeline.sessionId).toBe('other')
    } finally {
      store.dispose()
    }
  })

  it('coalesces streaming acknowledgements to the newest revision in one microtask', async () => {
    const client = new Client()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s')
      client.requests.length = 0
      client.emit(window('s', 2, 'a'))
      client.emit(window('s', 3, 'b'))
      client.emit(window('s', 4, 'c'))
      await Promise.resolve()
      const acks = client.requests.filter((request) => request.type === 'session.transcript.ack')
      expect(acks).toHaveLength(1)
      expect(acks[0]).toMatchObject({ payload: { sessionId: 's', revision: 4 } })
    } finally {
      store.dispose()
    }
  })

  it('coalesces snapshots arriving across the opening barrier and accepts only the latest complete view', async () => {
    const client = new Client()
    let resolve: ((detail: unknown) => void) | undefined
    client.open = () =>
      new Promise((done) => {
        resolve = done
      })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      const opening = store.openSession('s')
      for (let i = 0; i < 20 && resolve === undefined; i++) await Promise.resolve()
      for (let revision = 2; revision <= 100; revision++)
        client.emit(window('s', revision, `Response ${revision}`))
      resolve?.(detail('s'))
      await opening
      expect(store.getState().timeline.nodes[0]).toMatchObject({ markdown: 'Response 100' })
      expect(store.getState().transcript?.revision).toBe(100)
      expect(store.getState()).not.toHaveProperty('history')
    } finally {
      store.dispose()
    }
  })
})
