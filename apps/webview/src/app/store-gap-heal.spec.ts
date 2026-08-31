// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const activeSession = {
  id: 'session-active',
  workspaceId: 'workspace-1',
  title: 'Gap healing conversation',
  blank: false,
  status: 'running',
  createdAt: '2026-08-31T08:00:00.000Z',
  updatedAt: '2026-08-31T08:05:00.000Z',
} as const

function userMessageHistoryEntry(sequence: number): unknown {
  return {
    sequence,
    time: '2026-08-31T08:00:00.000Z',
    event: {
      type: 'message.user',
      sessionId: activeSession.id,
      messageId: `message-${sequence}`,
      markdown: `message ${sequence}`,
    },
  }
}

function liveUserMessage(sequence: number): HostMessage {
  return {
    type: 'event',
    sequence: 10_000 + sequence,
    name: 'message.user',
    payload: {
      type: 'message.user',
      sessionId: activeSession.id,
      messageId: `message-${sequence}`,
      markdown: `message ${sequence}`,
      sequence,
    },
  } as unknown as HostMessage
}

function gapMessage(fromSequence: number, toSequence: number, payload?: unknown): HostMessage {
  return {
    type: 'event',
    sequence: 20_000 + fromSequence,
    name: 'session.gap',
    payload: payload ?? {
      sessionId: activeSession.id,
      fromSequence,
      toSequence,
    },
  } as unknown as HostMessage
}

type Respond = (request: WebviewRequest) => unknown

class FakeClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly respond: Respond) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.respond(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
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
      return { models: [] }
    default:
      throw new Error(`unexpected request ${request.type}`)
  }
}

function makeStore(
  options: {
    readonly historySequences?: readonly number[]
    readonly historyPage?: unknown
    readonly respond?: Respond
  } = {},
): {
  store: ReturnType<typeof createAppStore>
  client: FakeClient
} {
  const historySequences = options.historySequences ?? [1, 2, 3, 4, 5]
  const respond: Respond = (request) => {
    if (request.type === 'session.open')
      return {
        ...activeSession,
        history: historySequences.map((sequence) => userMessageHistoryEntry(sequence)),
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
    if (request.type === 'session.history') return options.historyPage ?? { events: [], hasMore: false }
    if (options.respond !== undefined) return options.respond(request)
    return baseResponse(request)
  }
  const client = new FakeClient(respond)
  return { store: createAppStore(client as unknown as ProtocolClient), client }
}

const historyRequests = (client: FakeClient): WebviewRequest[] =>
  client.requests.filter((request) => request.type === 'session.history')

const userMessageNodes = (state: {
  readonly timeline: { readonly nodes: readonly { readonly kind: string; readonly id: string }[] }
}): readonly { readonly kind: string; readonly id: string }[] =>
  state.timeline.nodes.filter((node) => node.kind === 'user-message')

const flushAsync = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

describe('AppStore session gap healing', () => {
  afterEach(() => document.body.replaceChildren())

  it('backfills a session gap from history and rebuilds the healed timeline', async () => {
    const { store, client } = makeStore({
      historyPage: {
        events: [6, 7, 8, 9].map((sequence) => userMessageHistoryEntry(sequence)),
        hasMore: false,
        beforeSequence: 6,
      },
    })
    await store.openSession(activeSession.id)
    expect(userMessageNodes(store.getState())).toHaveLength(5)

    client.emit(gapMessage(6, 9))
    await flushAsync()

    const requests = historyRequests(client)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      payload: { sessionId: activeSession.id, beforeSeq: 10, maxMessages: 200 },
    })
    const state = store.getState()
    // The rebuilt timeline renders the healed range and drops the notice,
    // because the ledger now covers the announced hole completely.
    expect(userMessageNodes(state)).toHaveLength(9)
    expect(state.timeline.nodes.some((node) => node.id === `gap:${activeSession.id}:6:9`)).toBe(false)
  })

  it('keeps the gap notice when the backfill read fails', async () => {
    const { store, client } = makeStore({
      respond: () => {
        throw new Error('history endpoint is down')
      },
    })
    await store.openSession(activeSession.id)
    client.emit(gapMessage(6, 9))
    await flushAsync()

    expect(historyRequests(client)).toHaveLength(1)
    const state = store.getState()
    expect(userMessageNodes(state)).toHaveLength(5)
    expect(state.timeline.nodes.some((node) => node.id === `gap:${activeSession.id}:6:9`)).toBe(true)
  })

  it('republishes the ledger when a recovered event arrives below the timeline cursor', async () => {
    const { store, client } = makeStore({ historySequences: [1, 2, 4, 5] })
    await store.openSession(activeSession.id)
    expect(userMessageNodes(store.getState())).toHaveLength(4)

    // Detached stream recovery redelivers sequence 3 after the live edge
    // moved on: the reduce gate drops it, so only a ledger rebuild can show it.
    client.emit(liveUserMessage(3))
    await flushAsync()

    const nodes = userMessageNodes(store.getState())
    expect(nodes).toHaveLength(5)
    expect(store.getState().timeline.lastSequence).toBe(5)
  })

  it('ignores malformed gap payloads without requesting history', async () => {
    const { store, client } = makeStore()
    await store.openSession(activeSession.id)

    client.emit(gapMessage(6, 9, { sessionId: activeSession.id, fromSequence: 9, toSequence: 6 }))
    client.emit(gapMessage(6, 9, { sessionId: activeSession.id }))
    await flushAsync()

    expect(historyRequests(client)).toHaveLength(0)
    expect(store.getState().timeline.nodes.some((node) => node.id.startsWith('gap:'))).toBe(false)
  })

  it('does not backfill gaps reported for other sessions', async () => {
    const { store, client } = makeStore()
    await store.openSession(activeSession.id)

    client.emit(gapMessage(6, 9, { sessionId: 'session-other', fromSequence: 6, toSequence: 9 }))
    await flushAsync()

    expect(historyRequests(client)).toHaveLength(0)
  })
})
