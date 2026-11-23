import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { SubagentView } from '@dsh-vscode/domain'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

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
      return { items: [] }
    case 'workspace.list':
      return []
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

  it('routes Stop for an ordinary session to session.cancel without requiring a subagent', async () => {
    const client = new FakeClient((request) => {
      if (request.type === 'session.cancel') return undefined
      return answer(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.cancelSession('ordinary')
      expect(client.requests).toEqual([
        expect.objectContaining({ type: 'session.cancel', payload: { sessionId: 'ordinary' } }),
      ])
    } finally {
      store.dispose()
    }
  })

  it('preserves a failed ordinary Stop so the caller can display the error and retry', async () => {
    let fail = true
    const client = new FakeClient((request) => {
      if (request.type !== 'session.cancel') return answer(request)
      if (fail) throw new Error('Cancellation unavailable')
      return undefined
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await expect(store.cancelSession('ordinary')).rejects.toThrow('Cancellation unavailable')
      fail = false
      await expect(store.cancelSession('ordinary')).resolves.toBeUndefined()
      expect(client.requests.map((request) => request.type)).toEqual(['session.cancel', 'session.cancel'])
    } finally {
      store.dispose()
    }
  })

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
        payload: { sessionId: 'child', message: 'continue the work', mode: 'queue' },
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
})

describe('AppStore history paging', () => {
  it('prepends an authoritative older page while preserving the newer window', async () => {
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
    expect(store.getState().projections.parent).toBeUndefined() // An older page cannot install current facts.
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
})

describe('AppStore live subagent activity and editor tabs', () => {
  afterEach(() => vi.restoreAllMocks())

  it('tracks live subagent activity updates and prunes idle or removed children', () => {
    const client = new FakeClient(answer)
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit({
        type: 'event',
        name: 'subagent.activity',
        sequence: 1,
        payload: { sessionId: 'child-1', phase: 'tool', toolName: 'edit', activeToolCount: 1 },
      })
      const firstRef = store.getState().subagentActivities
      expect(firstRef).toEqual({
        'child-1': { sessionId: 'child-1', phase: 'tool', toolName: 'edit', activeToolCount: 1 },
      })

      // Duplicate frames preserve object identity.
      client.emit({
        type: 'event',
        name: 'subagent.activity',
        sequence: 2,
        payload: { sessionId: 'child-1', phase: 'tool', toolName: 'edit', activeToolCount: 1 },
      })
      expect(store.getState().subagentActivities).toBe(firstRef)

      client.emit({
        type: 'event',
        name: 'subagent.activity',
        sequence: 3,
        payload: { sessionId: 'child-1', phase: 'idle' },
      })
      expect(store.getState().subagentActivities).toEqual({})

      client.emit({
        type: 'event',
        name: 'subagent.activity',
        sequence: 4,
        payload: { sessionId: 'child-2', phase: 'thinking' },
      })
      expect(store.getState().subagentActivities?.['child-2']?.phase).toBe('thinking')
      client.emit({
        type: 'event',
        name: 'session.status',
        sequence: 5,
        payload: { sessionId: 'child-2', status: 'idle' },
      })
      expect(store.getState().subagentActivities).toEqual({})
    } finally {
      store.dispose()
    }
  })

  it('opens an assigned child before the session list and keeps the editor bound when opening a descendant', async () => {
    const childEntry = child({
      id: 'child-ed',
      name: 'reviewer',
      label: 'Audit diff',
      parentSessionId: 'parent-1',
    })
    const client = new FakeClient((request) => {
      if (request.type === 'surface.openInEditor') return { surface: 'editor' }
      if (request.type === 'subagent.list') {
        return request.payload.sessionId === 'parent-1'
          ? { entries: [childEntry], parentAvailable: true }
          : { entries: [], parentAvailable: true }
      }
      return answer(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit({
        type: 'event',
        name: 'ui.surface.assigned',
        sequence: 1,
        payload: { kind: 'editor', sessionId: 'child-ed', parentSessionId: 'parent-1' },
      })
      await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('child-ed'))
      expect(store.getState().activeSubagent?.entry.id).toBe('child-ed')
      expect(client.requests.some((request) => request.type === 'subagent.history')).toBe(true)
      expect(client.requests.some((request) => request.type === 'session.open')).toBe(false)

      await store.openSubagent(
        child({ id: 'descendant', label: 'Review tests', parentSessionId: 'child-ed' }),
        true,
      )
      expect(client.requests).toContainEqual(
        expect.objectContaining({
          type: 'surface.openInEditor',
          payload: { sessionId: 'descendant', title: 'Review tests' },
        }),
      )
      expect(store.getState().activeSessionId).toBe('child-ed')
    } finally {
      store.dispose()
    }
  })

  it('opens controllable subagents in an editor tab, refuses external ones, and interrupts children directly', async () => {
    const client = new FakeClient((request) => {
      if (request.type === 'surface.openInEditor') return { surface: 'editor' }
      return answer(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSubagentInEditor?.(
        child({ id: 'child-1', name: 'reviewer', label: 'Review changes', mode: 'continuable' }),
      )
      expect(client.requests).toContainEqual(
        expect.objectContaining({
          type: 'surface.openInEditor',
          payload: { sessionId: 'child-1', title: 'reviewer · Review changes' },
        }),
      )

      await expect(
        store.openSubagentInEditor?.(child({ id: 'ext-1', mode: 'external', label: 'External run' })),
      ).rejects.toThrow()
      expect(client.requests.filter((request) => request.type === 'surface.openInEditor')).toHaveLength(1)

      await store.interruptSubagent?.('child-1')
      expect(client.requests).toContainEqual(
        expect.objectContaining({
          type: 'subagent.interrupt',
          payload: { sessionId: 'child-1' },
        }),
      )
    } finally {
      store.dispose()
    }
  })
})
