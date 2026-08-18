// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { SubagentView } from '@dsh-vscode/domain'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class FakeClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly answer: (request: WebviewRequest) => unknown) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.answer(request) as T)
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

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function child(overrides: Partial<SubagentView> = {}): SubagentView {
  return {
    kind: 'child',
    id: 'child',
    label: 'worker',
    activity: 'running',
    parentSessionId: 'parent',
    mode: 'continuable',
    hasChildren: false,
    ...overrides,
  }
}

function answer(request: WebviewRequest): unknown {
  switch (request.type) {
    case 'subagent.history':
      return {
        events: [],
        hasMore: false,
        projection: { asOfSequence: 4, values: { title: 'Worker' } },
      }
    case 'subagent.list':
      return { entries: [], parentAvailable: false }
    case 'session.list':
    case 'workspace.list':
      return { items: [] }
    case 'session.queue.list':
    case 'goal.list':
    case 'job.list':
    case 'providers.list':
    case 'models.list':
      return []
    case 'preset.list':
      return { presets: [] }
    case 'subagent.send':
    case 'subagent.interrupt':
      return undefined
    default:
      throw new Error(`unexpected request ${request.type}`)
  }
}

describe('AppStore subagent transport routing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens durable history and routes text follow-up plus Stop to subagent RPCs', async () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSubagent(child(), true)
    await store.sendPrompt('child', 'continue the work', [], 'queue')
    await store.cancelSession('child')

    expect(store.activeSubagent).toMatchObject({
      entry: { id: 'child', mode: 'continuable' },
      parentAvailable: true,
    })
    expect(store.timeline.sessionId).toBe('child')
    expect(store.getState().projections.child).toEqual({ title: 'Worker' })
    expect(client.requests.map((request) => request.type)).toContain('subagent.history')
    expect(client.requests).toContainEqual(
      expect.objectContaining({
        type: 'subagent.send',
        payload: { sessionId: 'child', message: 'continue the work' },
      }),
    )
    expect(client.requests).toContainEqual(
      expect.objectContaining({ type: 'subagent.interrupt', payload: { sessionId: 'child' } }),
    )
    expect(client.requests.some((request) => request.type === 'session.open')).toBe(false)
    expect(client.requests.some((request) => request.type === 'session.sendPrompt')).toBe(false)
    expect(client.requests.some((request) => request.type === 'session.cancel')).toBe(false)
    store.dispose()
  })

  it('keeps an offline continuable child interruptible while refusing follow-up', async () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSubagent(child(), false)

    await expect(store.sendPrompt('child', 'cannot route', [], 'queue')).rejects.toThrow(
      /parent session is unavailable/i,
    )
    await expect(store.cancelSession('child')).resolves.toBeUndefined()
    expect(client.requests.some((request) => request.type === 'subagent.send')).toBe(false)
    expect(client.requests.some((request) => request.type === 'subagent.interrupt')).toBe(true)
    store.dispose()
  })

  it('keeps one-shot histories read-only and never emits mutation RPCs', async () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSubagent(child({ mode: 'one-shot', label: 'once', activity: 'inactive' }), true)

    await expect(store.sendPrompt('child', 'no', [], 'queue')).rejects.toThrow(/read-only/i)
    await expect(store.cancelSession('child')).rejects.toThrow(/cannot be interrupted/i)
    expect(client.requests.some((request) => request.type === 'subagent.send')).toBe(false)
    expect(client.requests.some((request) => request.type === 'subagent.interrupt')).toBe(false)
    store.dispose()
  })

  it('rejects attachments before a subagent follow-up reaches the host', async () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSubagent(child(), true)

    await expect(
      store.sendPrompt(
        'child',
        'with image',
        [{ uri: 'opaque:attachment', name: 'image.png', mimeType: 'image/png' }],
        'queue',
      ),
    ).rejects.toThrow(/attachments are unavailable/i)
    expect(client.requests.some((request) => request.type === 'subagent.send')).toBe(false)
    store.dispose()
  })

  it('replays a live event that arrives while an ordinary session is still opening', async () => {
    const queue = deferred<readonly unknown[]>()
    const client = new FakeClient((request) => {
      switch (request.type) {
        case 'session.open':
          return {
            id: 'parent',
            workspaceId: 'workspace',
            title: 'Parent',
            blank: false,
            status: 'running',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            history: [],
          }
        case 'session.queue.list':
          return queue.promise
        case 'goal.list':
        case 'job.list':
          return []
        case 'subagent.list':
          return { entries: [], parentAvailable: true }
        case 'command.list':
          return []
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    const opening = store.openSession('parent')
    await vi.waitFor(() =>
      expect(client.requests.some((request) => request.type === 'session.queue.list')).toBe(true),
    )
    client.emit({
      type: 'event',
      name: 'message.completed',
      sequence: 10,
      payload: { sessionId: 'parent', messageId: 'assistant-1', markdown: 'arrived during open' },
    })
    client.emit({
      type: 'event',
      name: 'message.user',
      sequence: 11,
      payload: {
        sessionId: 'parent',
        messageId: 'context-1',
        markdown: 'plugin context arrives during open',
        source: 'plugin',
      },
    })
    queue.resolve([])
    await opening

    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant-1', markdown: 'arrived during open' }),
    )
    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({ id: 'context-1', source: 'plugin' }),
    )
    store.dispose()
  })

  it('does not append a live delta already covered by the hydrated history', async () => {
    const queue = deferred<readonly unknown[]>()
    const client = new FakeClient((request) => {
      switch (request.type) {
        case 'session.open':
          return {
            id: 'parent',
            workspaceId: 'workspace',
            title: 'Parent',
            blank: false,
            status: 'running',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            history: [
              {
                sequence: 10,
                event: {
                  type: 'message.delta',
                  sessionId: 'parent',
                  messageId: 'assistant-1',
                  delta: 'a',
                },
              },
            ],
          }
        case 'session.queue.list':
          return queue.promise
        case 'goal.list':
        case 'job.list':
          return []
        case 'subagent.list':
          return { entries: [], parentAvailable: true }
        case 'command.list':
          return []
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    const opening = store.openSession('parent')
    await vi.waitFor(() =>
      expect(client.requests.some((request) => request.type === 'session.queue.list')).toBe(true),
    )
    client.emit({
      type: 'event',
      name: 'message.delta',
      sequence: 10,
      payload: { sessionId: 'parent', messageId: 'assistant-1', delta: 'a' },
    })
    client.emit({
      type: 'event',
      name: 'message.delta',
      sequence: 11,
      payload: { sessionId: 'parent', messageId: 'assistant-1', delta: 'b' },
    })
    queue.resolve([])
    await opening

    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant-1', markdown: 'ab', streaming: true }),
    )
    store.dispose()
  })

  it('clears transient queue and jobs at a fresh subscription baseline', async () => {
    const client = new FakeClient((request) => {
      switch (request.type) {
        case 'session.open':
          return {
            id: 'parent',
            workspaceId: 'workspace',
            title: 'Parent',
            blank: false,
            status: 'running',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            history: [],
          }
        case 'session.queue.list':
          return [
            {
              id: 'queued-1',
              sessionId: 'parent',
              text: 'stale',
              attachments: [],
              mode: 'queue',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ]
        case 'job.list':
          return [
            {
              id: 'bash-1',
              kind: 'bash',
              label: 'stale job',
              status: 'running',
              startedAt: 1,
            },
          ]
        case 'goal.list':
          return []
        case 'subagent.list':
          return { entries: [], parentAvailable: true }
        case 'command.list':
          return []
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('parent')
    expect(store.queue).toHaveLength(1)
    expect(store.jobs).toHaveLength(1)

    client.emit({
      type: 'event',
      name: 'session.subscribed',
      sequence: 11,
      payload: { sessionId: 'parent', lastSequence: 20 },
    })

    expect(store.queue).toEqual([])
    expect(store.jobs).toEqual([])
    store.dispose()
  })
})

describe('AppStore sessions drawer', () => {
  afterEach(() => vi.restoreAllMocks())

  const sessionListCount = (client: FakeClient): number =>
    client.requests.filter((request) => request.type === 'session.list').length

  it('re-fetches the session list when the sessions drawer opens', () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)
    const before = sessionListCount(client)

    client.emit({ type: 'event', name: 'ui.sessions.toggle', sequence: 1, payload: {} })

    expect(store.drawer).toBe('sessions')
    // Opening the drawer re-fetches the authoritative list so stale cached
    // titles (missed live frames, reconnect gaps) cannot linger in the picker.
    expect(sessionListCount(client)).toBeGreaterThan(before)
    store.dispose()
  })

  it('does not re-fetch when the sessions drawer closes', () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)
    client.emit({ type: 'event', name: 'ui.sessions.toggle', sequence: 1, payload: {} })
    const afterOpen = sessionListCount(client)

    client.emit({ type: 'event', name: 'ui.sessions.toggle', sequence: 2, payload: {} })

    expect(store.drawer).toBeUndefined()
    expect(sessionListCount(client)).toBe(afterOpen)
    store.dispose()
  })
})
