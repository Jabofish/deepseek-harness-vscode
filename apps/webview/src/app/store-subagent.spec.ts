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
    case 'command.list':
    case 'skill.list':
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

  it('shows subagent history before advisory reads finish', async () => {
    const queue = deferred<readonly unknown[]>()
    const client = new FakeClient((request) => {
      if (request.type === 'subagent.history') return answer(request)
      if (request.type === 'session.queue.list') return queue.promise
      return answer(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    let settled = false
    const opening = store.openSubagent(child(), true).then(() => {
      settled = true
    })

    await vi.waitFor(() => expect(store.activeSessionId).toBe('child'))
    expect(store.timeline.sessionId).toBe('child')
    expect(settled).toBe(false)

    queue.resolve([])
    await opening
    expect(settled).toBe(true)
    store.dispose()
  })

  it('replays buffered subagent events with the first history paint', async () => {
    const history = deferred<unknown>()
    const queue = deferred<readonly unknown[]>()
    const client = new FakeClient((request) => {
      if (request.type === 'subagent.history') return history.promise
      if (request.type === 'session.queue.list') return queue.promise
      return answer(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    const opening = store.openSubagent(child(), true)

    await vi.waitFor(() =>
      expect(client.requests.some((request) => request.type === 'subagent.history')).toBe(true),
    )
    client.emit({
      type: 'event',
      name: 'message.completed',
      sequence: 1,
      payload: { sessionId: 'child', messageId: 'assistant-1', markdown: 'buffered answer' },
    })
    history.resolve({ events: [], hasMore: false })

    await vi.waitFor(() => expect(store.activeSessionId).toBe('child'))
    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant-1', markdown: 'buffered answer' }),
    )

    queue.resolve([])
    await opening
    store.dispose()
  })

  it('does not notify when an unknown subagent parent is added', async () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)
    const listener = vi.fn()
    store.subscribe(listener)

    client.emit({
      type: 'event',
      name: 'session.added',
      sequence: 1,
      payload: {
        sessionId: 'child',
        parentSessionId: 'unknown-parent',
        origin: 'subagent',
      },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(listener).not.toHaveBeenCalled()
    expect(store.subagents.entries).toHaveLength(0)
    store.dispose()
  })

  it('preserves identity for equivalent transient queue, goal, todo, and job snapshots', async () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSubagent(child(), true)
    const listener = vi.fn()
    store.subscribe(listener)

    const queueItem = {
      id: 'queue-1',
      sessionId: 'child',
      text: 'queued prompt',
      attachments: [{ uri: 'attachment-1', name: 'notes.txt', mimeType: 'text/plain' }],
      mode: 'queue' as const,
      createdAt: '2026-08-31T00:00:00.000Z',
      rpcId: 'rpc-1',
    }
    const goal = { id: 'goal-1', title: 'Ship it', status: 'in-progress' as const }
    const todo = { id: 'todo-1', content: 'Verify it', status: 'pending' as const }
    const job = {
      id: 'job-1',
      kind: 'shell-1',
      label: 'Build',
      status: 'running' as const,
      startedAt: 1,
    }
    client.emit({
      type: 'event',
      name: 'queue.updated',
      sequence: 1,
      payload: { sessionId: 'child', items: [queueItem] },
    })
    client.emit({
      type: 'event',
      name: 'goal.updated',
      sequence: 2,
      payload: { sessionId: 'child', goals: [goal] },
    })
    client.emit({
      type: 'event',
      name: 'todo.updated',
      sequence: 3,
      payload: { sessionId: 'child', todos: [todo] },
    })
    client.emit({
      type: 'event',
      name: 'jobs.updated',
      sequence: 4,
      payload: { sessionId: 'child', jobs: [job] },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    listener.mockClear()
    const queueSnapshot = store.queue
    const goalSnapshot = store.goals
    const todoSnapshot = store.todos
    const jobSnapshot = store.jobs

    client.emit({
      type: 'event',
      name: 'queue.updated',
      sequence: 5,
      payload: { sessionId: 'child', items: [queueItem] },
    })
    client.emit({
      type: 'event',
      name: 'goal.updated',
      sequence: 6,
      payload: { sessionId: 'child', goals: [goal] },
    })
    client.emit({
      type: 'event',
      name: 'todo.updated',
      sequence: 7,
      payload: { sessionId: 'child', todos: [todo] },
    })
    client.emit({
      type: 'event',
      name: 'jobs.updated',
      sequence: 8,
      payload: { sessionId: 'child', jobs: [job] },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.queue).toBe(queueSnapshot)
    expect(store.goals).toBe(goalSnapshot)
    expect(store.todos).toBe(todoSnapshot)
    expect(store.jobs).toBe(jobSnapshot)
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
        case 'skill.list':
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

  it('replays live tool updates immediately after the first history paint', async () => {
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
        case 'skill.list':
          return []
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    const opening = store.openSession('parent')

    await vi.waitFor(() => expect(store.activeSessionId).toBe('parent'))
    expect(client.requests.some((request) => request.type === 'session.queue.list')).toBe(true)
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 12,
      payload: {
        sessionId: 'parent',
        sequence: 12,
        tool: {
          id: 'tool-live',
          name: 'web_search',
          category: 'network',
          title: 'web_search',
          status: 'running',
          inputSummary: 'latest AI news',
          metadata: {},
        },
      },
    })

    expect(store.timeline.nodes.some((node) => node.kind === 'tool' && node.tool.id === 'tool-live')).toBe(
      true,
    )
    queue.resolve([])
    await opening
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
        case 'skill.list':
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

  it('keeps live model output when the history and host transport use different sequence spaces', async () => {
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
                sequence: 100,
                event: {
                  type: 'message.completed',
                  sessionId: 'parent',
                  messageId: 'assistant-1',
                  markdown: 'before',
                },
              },
            ],
          }
        case 'session.queue.list':
        case 'goal.list':
        case 'job.list':
        case 'command.list':
        case 'skill.list':
          return []
        case 'subagent.list':
          return { entries: [], parentAvailable: true }
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('parent')

    // The outer sequence is only the Webview delivery order. The payload's
    // sequence is the durable DSH cursor used by the hydrated history.
    client.emit({
      type: 'event',
      name: 'session.projection',
      sequence: 1,
      payload: {
        sessionId: 'parent',
        // A projection may carry a later durable sequence than the next
        // visible delta. It is not itself a timeline record.
        sequence: 999,
        key: 'sessionStats',
        value: { turns: 1 },
      },
    })
    client.emit({
      type: 'event',
      name: 'message.delta',
      sequence: 2,
      payload: {
        sessionId: 'parent',
        sequence: 102,
        messageId: 'assistant-1',
        delta: ' live',
      },
    })

    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant-1', markdown: 'before live', streaming: true }),
    )
    expect(store.timeline.lastSequence).toBe(102)
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
        case 'skill.list':
          return []
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('parent')
    await vi.waitFor(() => {
      expect(store.queue).toHaveLength(1)
      expect(store.jobs).toHaveLength(1)
    })
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
    const queueAfterReset = store.queue
    const jobsAfterReset = store.jobs
    const permissionsAfterReset = store.permissions
    const questionsAfterReset = store.questions

    client.emit({
      type: 'event',
      name: 'session.subscribed',
      sequence: 12,
      payload: { sessionId: 'parent', lastSequence: 21 },
    })

    expect(store.queue).toBe(queueAfterReset)
    expect(store.jobs).toBe(jobsAfterReset)
    expect(store.permissions).toBe(permissionsAfterReset)
    expect(store.questions).toBe(questionsAfterReset)
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

describe('AppStore history paging', () => {
  it('prepends one real-protocol-shaped history page and advances its beforeSeq boundary', async () => {
    const client = new FakeClient((request) => {
      switch (request.type) {
        case 'session.open':
          return {
            id: 'parent',
            workspaceId: 'workspace',
            title: 'Parent',
            blank: false,
            status: 'completed',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            historyHasMore: true,
            historyBeforeSequence: 20,
            history: [
              {
                sequence: 20,
                time: '2026-01-01T00:00:02.000Z',
                event: {
                  type: 'message.completed',
                  sessionId: 'parent',
                  messageId: 'newer',
                  markdown: 'newer',
                },
              },
              {
                sequence: 999,
                time: '2026-01-01T00:00:03.000Z',
                event: {
                  type: 'session.projection',
                  sessionId: 'parent',
                  key: 'sessionStats',
                  value: { turns: 1 },
                },
              },
            ],
          }
        case 'session.history':
          return {
            beforeSeq: 10,
            hasMore: false,
            projection: {
              asOfSequence: 20,
              values: { sessionStats: { turns: 1, steps: 1, llmMs: 10, toolMs: 5 } },
            },
            events: [
              {
                sequence: 10,
                time: '2026-01-01T00:00:01.000Z',
                event: {
                  type: 'message.completed',
                  sessionId: 'parent',
                  messageId: 'older',
                  markdown: 'older',
                },
              },
            ],
          }
        case 'session.queue.list':
        case 'goal.list':
        case 'job.list':
        case 'command.list':
        case 'skill.list':
          return []
        case 'subagent.list':
          return { entries: [], parentAvailable: true }
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession('parent')
    expect(store.timeline.lastSequence).toBe(20)
    await store.loadOlderHistory()

    expect(client.requests).toContainEqual(
      expect.objectContaining({
        type: 'session.history',
        payload: { sessionId: 'parent', beforeSeq: 20, maxMessages: 200 },
      }),
    )
    expect(store.timeline.nodes.map((node) => node.id)).toEqual(['older', 'newer'])
    expect(store.timeline.lastSequence).toBe(20)
    expect(store.historyHasMore).toBe(false)
    expect(store.historyBeforeSequence).toBe(10)
    expect(store.getState().projections.parent).toEqual({
      sessionStats: { turns: 1, steps: 1, llmMs: 10, toolMs: 5 },
    })
    expect(store.historyLoading).toBe(false)
    store.dispose()
  })
})

describe('AppStore session branching', () => {
  afterEach(() => vi.restoreAllMocks())

  it('forks at the durable sequence and opens the returned child session', async () => {
    const childDetail = {
      id: 'child',
      workspaceId: 'workspace',
      title: 'Branched',
      blank: false,
      status: 'idle',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      history: [],
    }
    const client = new FakeClient((request) => {
      switch (request.type) {
        case 'session.fork':
          return { id: 'child' }
        case 'session.open':
          return childDetail
        case 'session.queue.list':
        case 'goal.list':
        case 'job.list':
        case 'command.list':
        case 'skill.list':
          return []
        case 'subagent.list':
          return { entries: [], parentAvailable: true }
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.forkSession('parent', 42)

    expect(client.requests).toContainEqual(
      expect.objectContaining({
        type: 'session.fork',
        payload: { sessionId: 'parent', atSeq: 42 },
      }),
    )
    expect(store.activeSessionId).toBe('child')
    expect(store.sessions).toContainEqual(expect.objectContaining({ id: 'child', title: 'Branched' }))
    store.dispose()
  })

  it('assigns the next available numeric fork suffix before opening the child', async () => {
    const parent = {
      id: 'parent',
      workspaceId: 'workspace',
      title: 'Task',
      blank: false,
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const childDetail = {
      id: 'child',
      workspaceId: 'workspace',
      title: 'Task (2)',
      blank: false,
      status: 'idle',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      history: [],
    }
    const sibling = { ...parent, id: 'sibling', title: 'Task (1)' }
    const client = new FakeClient((request) => {
      switch (request.type) {
        case 'session.list':
          return { items: [parent, sibling] }
        case 'workspace.list':
          return {
            items: [
              {
                id: 'workspace',
                name: 'Workspace',
                createdAt: parent.createdAt,
                updatedAt: parent.updatedAt,
                sessionIds: ['parent', 'sibling'],
                sessionCount: 2,
              },
            ],
            archivedSessionIds: [],
          }
        case 'providers.list':
        case 'models.list':
          return []
        case 'preset.list':
          return { presets: [] }
        case 'session.fork':
          return { id: 'child' }
        case 'session.rename':
          return { title: 'Task (2)', seq: 44 }
        case 'session.open':
          return childDetail
        case 'session.queue.list':
        case 'goal.list':
        case 'job.list':
        case 'command.list':
        case 'skill.list':
        case 'subagent.list':
          return request.type === 'subagent.list' ? { entries: [], parentAvailable: true } : []
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.refreshSessions()
    await store.forkSession('parent')

    expect(client.requests).toContainEqual(
      expect.objectContaining({
        type: 'session.rename',
        payload: { sessionId: 'child', title: 'Task (2)' },
      }),
    )
    store.dispose()
  })
})

describe('AppStore running lifecycle', () => {
  it('stops the UI running bit from host idle without reopening the durable turn', async () => {
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
                sequence: 1,
                event: { type: 'turn.started', sessionId: 'parent', turn: 1 },
              },
              {
                sequence: 2,
                event: {
                  type: 'message.completed',
                  sessionId: 'parent',
                  messageId: 'assistant:1:0',
                  turn: 1,
                  step: 0,
                  markdown: 'done',
                },
              },
            ],
          }
        case 'session.queue.list':
        case 'goal.list':
        case 'job.list':
        case 'command.list':
        case 'skill.list':
          return []
        case 'subagent.list':
          return { entries: [], parentAvailable: true }
        default:
          throw new Error(`unexpected request ${request.type}`)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession('parent')
    expect(store.sessions).toContainEqual(expect.objectContaining({ id: 'parent', status: 'running' }))

    client.emit({
      type: 'event',
      name: 'session.status',
      sequence: 10,
      payload: { sessionId: 'parent', status: 'idle' },
    })

    expect(store.sessions).toContainEqual(expect.objectContaining({ id: 'parent', status: 'idle' }))
    expect(store.timeline.activeTurn).toBe(1)
    store.dispose()
  })
})
