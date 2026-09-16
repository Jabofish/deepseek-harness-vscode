// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const activeSession = {
  id: 'session-active',
  workspaceId: 'workspace-1',
  title: 'Open retry conversation',
  blank: false,
  status: 'idle',
  createdAt: '2026-08-31T08:00:00.000Z',
  updatedAt: '2026-08-31T08:05:00.000Z',
} as const

function userMessageHistoryEntry(sessionId: string, sequence: number): unknown {
  return {
    sequence,
    time: '2026-08-31T08:00:00.000Z',
    event: {
      type: 'message.user',
      sessionId,
      messageId: `message-${sequence}`,
      markdown: `message ${sequence}`,
    },
  }
}

function sessionOpenDetail(sessionId: string): unknown {
  return {
    ...activeSession,
    id: sessionId,
    history: [1, 2, 3].map((sequence) => userMessageHistoryEntry(sessionId, sequence)),
    historyHasMore: false,
    permissionPresets: [],
    configuration: {
      preset: 'standard',
      toolMode: 'native',
      permissionPreset: 'workspace-write',
      planMode: false,
      model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    },
  }
}

function retryableFailure(message: string): Error {
  return Object.assign(new Error(message), { code: 'BACKEND_UNREACHABLE', retryable: true })
}

type Respond = (request: WebviewRequest) => unknown

class FakeClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly respond: Respond) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    try {
      return Promise.resolve(this.respond(request) as T)
    } catch (reason: unknown) {
      return Promise.reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }
}

function baseResponse(request: WebviewRequest): unknown {
  switch (request.type) {
    case 'app.ready':
    case 'runtime.update.check':
    case 'settings.read':
    case 'workspace.list':
    case 'providers.list':
    case 'models.list':
      return request.type === 'runtime.update.check'
        ? {
            status: 'ready',
            availableVersions: [],
            updateAvailable: false,
            checkedAt: '2026-08-31T00:00:00.000Z',
          }
        : request.type === 'workspace.list'
          ? { items: [] }
          : undefined
    case 'session.list':
      return { items: [activeSession] }
    case 'preset.list':
      return { presets: [] }
    case 'session.queue.list':
    case 'goal.list':
    case 'job.list':
    case 'feedback.list':
    case 'command.list':
    case 'skill.list':
      return []
    case 'subagent.list':
      return { entries: [], parentAvailable: true }
    case 'models.session.list':
      return { models: [], failures: [] }
    default:
      throw new Error(`unexpected request ${request.type}`)
  }
}

function makeStore(
  options: {
    readonly onOpen?: (attempt: number, sessionId: string) => unknown
    readonly respond?: Respond
  } = {},
): {
  store: ReturnType<typeof createAppStore>
  client: FakeClient
} {
  let openAttempt = 0
  const respond: Respond = (request) => {
    if (request.type === 'session.open') {
      openAttempt += 1
      if (options.onOpen !== undefined) return options.onOpen(openAttempt, request.payload.sessionId)
      return sessionOpenDetail(request.payload.sessionId)
    }
    if (options.respond !== undefined) return options.respond(request)
    return baseResponse(request)
  }
  const client = new FakeClient(respond)
  return { store: createAppStore(client as unknown as ProtocolClient), client }
}

const openRequests = (client: FakeClient): WebviewRequest[] =>
  client.requests.filter((request) => request.type === 'session.open')

const userMessageNodes = (state: {
  readonly timeline: { readonly nodes: readonly { readonly kind: string }[] }
}): readonly unknown[] => state.timeline.nodes.filter((node) => node.kind === 'user-message')

describe('AppStore session.open bounded retry', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('retries a transient open failure and then opens the conversation', async () => {
    vi.useFakeTimers()
    const attempts: number[] = []
    const { store } = makeStore({
      onOpen: (attempt) => {
        attempts.push(attempt)
        if (attempt <= 2) throw retryableFailure('backend is still settling')
        return sessionOpenDetail(activeSession.id)
      },
    })
    const opened = store.openSession(activeSession.id)
    await vi.advanceTimersByTimeAsync(2_000)
    await opened

    expect(attempts).toEqual([1, 2, 3])
    const state = store.getState()
    expect(state.activeSessionId).toBe(activeSession.id)
    expect(userMessageNodes(state)).toHaveLength(3)
  })

  it('does not retry a definitive host rejection', async () => {
    vi.useFakeTimers()
    const attempts: number[] = []
    const { store, client } = makeStore({
      onOpen: () => {
        attempts.push(attempts.length + 1)
        throw Object.assign(new Error('session is gone'), { retryable: false })
      },
    })

    await expect(store.openSession(activeSession.id)).rejects.toThrow('session is gone')

    expect(attempts).toEqual([1])
    expect(openRequests(client)).toHaveLength(1)
  })

  it('rejects malformed critical session.open fields instead of opening blank state', async () => {
    const valid = sessionOpenDetail(activeSession.id) as Record<string, unknown>
    const malformedDetails = [
      { ...valid, history: { events: [] } },
      { ...valid, configuration: { toolMode: 'native' } },
      { ...valid, historyHasMore: 'yes' },
      { ...valid, permissionPresets: ['workspace-write', 7] },
      {
        ...valid,
        history: [
          {
            sequence: 'not-a-sequence',
            event: {
              type: 'message.user',
              sessionId: activeSession.id,
              messageId: 'message-1',
              markdown: 'must not be assigned an array-index sequence',
            },
          },
        ],
      },
      {
        ...valid,
        history: [
          {
            sequence: 1,
            time: 17,
            event: {
              type: 'message.user',
              sessionId: activeSession.id,
              messageId: 'message-1',
              markdown: 'must reject a malformed history timestamp',
            },
          },
        ],
      },
    ]

    for (const detail of malformedDetails) {
      const { store, client } = makeStore({ onOpen: () => detail })
      await expect(store.openSession(activeSession.id)).rejects.toThrow(
        /unable to open session|malformed subagent history page/i,
      )
      expect(store.activeSessionId).toBeUndefined()
      expect(openRequests(client)).toHaveLength(1)
      store.dispose()
    }
  })

  it('gives up after the bounded attempts and surfaces the last failure', async () => {
    vi.useFakeTimers()
    const { store, client } = makeStore({
      onOpen: () => {
        throw retryableFailure('still unreachable')
      },
    })
    const opened = store.openSession(activeSession.id)
    const assertion = expect(opened).rejects.toThrow('still unreachable')
    await vi.advanceTimersByTimeAsync(5_000)

    await assertion
    expect(openRequests(client)).toHaveLength(3)
  })

  it('abandons a retrying open once a newer open takes over', async () => {
    vi.useFakeTimers()
    const { store, client } = makeStore({
      onOpen: (_attempt, sessionId) => {
        if (sessionId === activeSession.id) throw retryableFailure('backend unreachable')
        return sessionOpenDetail(sessionId)
      },
    })
    const failing = store.openSession(activeSession.id)
    await vi.advanceTimersByTimeAsync(1)
    await store.openSession('session-b')
    await vi.advanceTimersByTimeAsync(2_000)

    // The stale open resolves silently once the newer open owns the panel,
    // and its pending retry never re-requests the old session.
    await failing
    expect(openRequests(client)).toHaveLength(2)
    expect(store.getState().activeSessionId).toBe('session-b')
  })
})
