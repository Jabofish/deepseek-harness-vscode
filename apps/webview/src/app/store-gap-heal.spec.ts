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

function liveUserMessage(sequence: number, hostSequence = 10_000 + sequence): HostMessage {
  return {
    type: 'event',
    sequence: hostSequence,
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

function historyEvent(
  sequence: number,
  event: Record<string, unknown>,
): { sequence: number; event: unknown } {
  return { sequence, event }
}

function liveEvent(sequence: number, event: Record<string, unknown>): HostMessage {
  return {
    type: 'event',
    sequence: 30_000 + sequence,
    name: typeof event.type === 'string' ? event.type : 'unknown',
    payload: { ...event, sequence },
  } as unknown as HostMessage
}

function toolView(
  id: string,
  status: 'running' | 'completed',
  outputSummary?: string,
): Record<string, unknown> {
  return {
    id,
    name: 'shell',
    category: 'execution',
    title: 'Shell',
    status,
    turn: 1,
    step: 1,
    ...(outputSummary === undefined ? {} : { outputSummary }),
    metadata: {},
  }
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
      return { models: [] }
    default:
      throw new Error(`unexpected request ${request.type}`)
  }
}

function makeStore(
  options: {
    readonly historySequences?: readonly number[]
    readonly history?: readonly unknown[]
    readonly historyPage?: unknown
    readonly openResponse?: unknown
    readonly respond?: Respond
  } = {},
): {
  store: ReturnType<typeof createAppStore>
  client: FakeClient
} {
  const historySequences = options.historySequences ?? [1, 2, 3, 4, 5]
  const respond: Respond = (request) => {
    if (request.type === 'session.open')
      return (
        options.openResponse ?? {
          ...activeSession,
          history: options.history ?? historySequences.map((sequence) => userMessageHistoryEntry(sequence)),
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
      )
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
    expect(store.getState().timeline.nodes.some((node) => node.id === `gap:${activeSession.id}:6:9`)).toBe(
      false,
    )
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

  it('uses raw page coverage when presentation history compacts deltas or hides system rows', async () => {
    const sessionId = activeSession.id
    const { store, client } = makeStore({
      history: [
        historyEvent(1, {
          type: 'message.user',
          sessionId,
          messageId: 'user-1',
          markdown: 'inspect the report',
        }),
      ],
      historyPage: {
        events: [
          historyEvent(3, {
            type: 'message.delta',
            sessionId,
            messageId: 'assistant-1',
            turn: 1,
            step: 1,
            delta: 'The report is complete.',
          }),
        ],
        hasMore: false,
        beforeSeq: 2,
        // The Adapter reports the raw page window, including the hidden
        // system row at sequence 2 and the delta row compacted over 2..3.
        coveredSeqRanges: [{ from: 2, to: 3 }],
      },
    })
    await store.openSession(sessionId)

    client.emit(gapMessage(2, 3))
    await flushAsync()

    const state = store.getState()
    expect(historyRequests(client)).toHaveLength(1)
    expect(state.timeline.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'assistant-1',
        markdown: 'The report is complete.',
      }),
    )
    expect(state.timeline.nodes.some((node) => node.id === `gap:${sessionId}:2:3`)).toBe(false)
  })

  it('does not append a live delta already represented by a compacted open-history row', async () => {
    const sessionId = activeSession.id
    let releaseOpen: ((value: unknown) => void) | undefined
    const openResponse = new Promise<unknown>((resolve) => {
      releaseOpen = resolve
    })
    const { store, client } = makeStore({ openResponse })
    const opening = store.openSession(sessionId)
    client.emit(
      liveEvent(3, {
        type: 'message.delta',
        sessionId,
        messageId: 'assistant-1',
        turn: 1,
        step: 1,
        delta: 'second',
      }),
    )
    releaseOpen?.({
      ...activeSession,
      history: [
        {
          sequence: 3,
          time: '2026-08-31T08:00:00.000Z',
          coveredSequences: [1, 3],
          event: {
            type: 'message.delta',
            sessionId,
            messageId: 'assistant-1',
            turn: 1,
            step: 1,
            delta: 'firstsecond',
          },
        },
      ],
      historyHasMore: false,
      permissionPresets: [],
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      },
    })
    await opening
    await flushAsync()

    const assistantNodes = store.getState().timeline.nodes.filter((node) => node.kind === 'assistant-message')
    expect(assistantNodes).toHaveLength(1)
    expect(assistantNodes[0]).toMatchObject({ markdown: 'firstsecond' })
    expect(store.getState().history.filter((entry) => entry.sequence === 3)).toHaveLength(1)
    store.dispose()
  })

  it('keeps distinct same-host-sequence events queued across the open barrier', async () => {
    let releaseOpen: ((value: unknown) => void) | undefined
    const openResponse = new Promise<unknown>((resolve) => {
      releaseOpen = resolve
    })
    const { store, client } = makeStore({ openResponse })
    const opening = store.openSession(activeSession.id)

    const queuedEvent = (durableSequence: number, messageId: string, markdown: string): HostMessage =>
      ({
        type: 'event',
        sequence: 42,
        name: 'message.user',
        payload: {
          type: 'message.user',
          sessionId: activeSession.id,
          messageId,
          markdown,
          source: 'user',
          sequence: durableSequence,
        },
      }) as unknown as HostMessage
    client.emit(queuedEvent(6, 'user-6', 'first concurrent request'))
    client.emit(queuedEvent(7, 'user-7', 'second concurrent request'))
    releaseOpen?.({
      ...activeSession,
      history: [5, 4, 3, 2, 1].map((sequence) => userMessageHistoryEntry(sequence)),
      historyHasMore: false,
      permissionPresets: [],
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      },
    })
    await opening

    expect(userMessageNodes(store.getState())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'user-6', markdown: 'first concurrent request' }),
        expect.objectContaining({ id: 'user-7', markdown: 'second concurrent request' }),
      ]),
    )
    expect(store.getState().history.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    store.dispose()
  })

  it('does not silently truncate a high-volume open barrier', async () => {
    let releaseOpen: ((value: unknown) => void) | undefined
    const openResponse = new Promise<unknown>((resolve) => {
      releaseOpen = resolve
    })
    const { store, client } = makeStore({ openResponse })
    const opening = store.openSession(activeSession.id)
    const pendingSequences = Array.from({ length: 4_100 }, (_value, index) => index + 6)

    // Reverse arrival is deliberate: it exercises the stable Host-sequence
    // ordering applied when the open barrier finally replays its queue.
    for (const [index, sequence] of [...pendingSequences].reverse().entries())
      client.emit(liveUserMessage(sequence, 40_000 + index))
    releaseOpen?.({
      ...activeSession,
      history: [5, 4, 3, 2, 1].map((sequence) => userMessageHistoryEntry(sequence)),
      historyHasMore: false,
      permissionPresets: [],
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      },
    })
    await opening
    await flushAsync()

    expect(store.getState().history.map((entry) => entry.sequence)).toEqual([
      1,
      2,
      3,
      4,
      5,
      ...pendingSequences,
    ])
    expect(userMessageNodes(store.getState())).toHaveLength(4_105)
    expect(userMessageNodes(store.getState()).at(-1)).toMatchObject({
      id: 'message-4105',
      markdown: 'message 4105',
    })
    store.dispose()
    client.dispose()
  })

  it('does not let a non-durable approval frame hide the next durable request', async () => {
    const { store, client } = makeStore()
    await store.openSession(activeSession.id)

    client.emit({
      type: 'event',
      sequence: 30_000,
      name: 'permission.requested',
      payload: {
        request: {
          id: 'approval-1',
          sessionId: activeSession.id,
          title: 'Allow the tool?',
          description: 'The tool needs approval.',
          risk: 'medium',
          options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
        },
      },
    } as unknown as HostMessage)
    client.emit(
      liveEvent(6, {
        type: 'message.user',
        sessionId: activeSession.id,
        messageId: 'message-6',
        markdown: 'continue after approval',
      }),
    )
    await flushAsync()

    expect(store.permissions).toHaveLength(1)
    expect(userMessageNodes(store.getState())).toContainEqual(
      expect.objectContaining({ id: 'message-6', markdown: 'continue after approval' }),
    )
    expect(store.getState().timeline.lastSequence).toBe(6)
    store.dispose()
    client.dispose()
  })

  it('keeps the gap notice when the backfill read fails', async () => {
    const { store, client } = makeStore({
      respond: () => {
        throw new Error('history endpoint is down')
      },
    })
    await store.openSession(activeSession.id)
    client.emit(gapMessage(6, 9))
    expect(store.getState().timeline.nodes.some((node) => node.id === `gap:${activeSession.id}:6:9`)).toBe(
      false,
    )
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

    // Ordered recovery redelivers sequence 3 after the live edge
    // moved on: the reduce gate drops it, so only a ledger rebuild can show it.
    client.emit(liveUserMessage(3))
    await flushAsync()

    const nodes = userMessageNodes(store.getState())
    expect(nodes).toHaveLength(5)
    expect(store.getState().timeline.lastSequence).toBe(5)
  })

  it('rebuilds a complex timeline after an out-of-order recovery burst', async () => {
    const sessionId = activeSession.id
    const history = [
      historyEvent(1, {
        type: 'message.user',
        sessionId,
        messageId: 'user-1',
        markdown: 'inspect two tools',
        source: 'user',
      }),
      historyEvent(2, { type: 'turn.started', sessionId, turn: 1 }),
      historyEvent(3, { type: 'step.started', sessionId, turn: 1, step: 1 }),
      historyEvent(4, {
        type: 'reasoning.delta',
        sessionId,
        messageId: 'assistant-1',
        turn: 1,
        step: 1,
        delta: 'I will inspect both tools.',
      }),
      historyEvent(5, {
        type: 'tool.updated',
        sessionId,
        tool: toolView('call-1', 'running'),
      }),
    ]
    const { store, client } = makeStore({ history })
    await store.openSession(sessionId)

    // This is the order an out-of-order recovery path could expose to the
    // Webview: the live edge advances first, then older records arrive.
    client.emit(
      liveEvent(10, {
        type: 'tool.updated',
        sessionId,
        tool: toolView('call-1', 'completed', 'first result'),
      }),
    )
    client.emit(
      liveEvent(12, {
        type: 'tool.updated',
        sessionId,
        tool: toolView('call-2', 'completed', 'second result'),
      }),
    )
    client.emit(
      liveEvent(13, {
        type: 'message.completed',
        sessionId,
        messageId: 'assistant-1',
        turn: 1,
        step: 1,
        markdown: 'Both tools completed successfully.',
      }),
    )
    client.emit(liveEvent(14, { type: 'step.ended', sessionId, turn: 1, step: 1 }))
    client.emit(liveEvent(15, { type: 'turn.ended', sessionId, turn: 1, reason: 'completed' }))

    for (const message of [
      historyEvent(6, {
        type: 'message.user',
        sessionId,
        messageId: 'user-2',
        markdown: 'include the second tool',
        source: 'user',
      }),
      historyEvent(7, { type: 'tool.updated', sessionId, tool: toolView('call-1', 'running') }),
      historyEvent(8, {
        type: 'tool.updated',
        sessionId,
        tool: toolView('call-2', 'running'),
      }),
      historyEvent(9, {
        type: 'message.delta',
        sessionId,
        messageId: 'assistant-1',
        turn: 1,
        step: 1,
        delta: 'Both tools completed successfully.',
      }),
      historyEvent(11, {
        type: 'session.projection',
        sessionId,
        key: 'contextPressure',
        value: { pressureTokens: 12 },
      }),
    ].map((entry) => liveEvent(entry.sequence, entry.event as Record<string, unknown>)))
      client.emit(message)

    await flushAsync()

    const state = store.getState()
    expect(state.history.map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ])
    expect(state.timeline.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user-message', id: 'user-1' }),
        expect.objectContaining({ kind: 'user-message', id: 'user-2' }),
        expect.objectContaining({ kind: 'tool', id: 'call-1' }),
        expect.objectContaining({ kind: 'tool', id: 'call-2' }),
        expect.objectContaining({
          kind: 'assistant-message',
          id: 'assistant-1',
          markdown: 'Both tools completed successfully.',
        }),
      ]),
    )
    expect(state.timeline.nodes.some((node) => node.id.startsWith('gap:'))).toBe(false)
    expect(state.timeline.lastSequence).toBe(15)
    store.dispose()
  })

  it('preserves an active v2 transient node while rebuilding the durable ledger', async () => {
    const { store, client } = makeStore({ historySequences: [1, 2, 4, 5] })
    await store.openSession(activeSession.id)

    client.emit({
      type: 'event',
      sequence: 30_001,
      name: 'message.delta',
      payload: {
        type: 'message.delta',
        sessionId: activeSession.id,
        messageId: 'assistant:1:0',
        delta: 'draft',
        turn: 1,
        step: 0,
        transientSequence: 1,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
      },
    } as unknown as HostMessage)
    expect(store.getState().timeline.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'assistant:1:0',
        markdown: 'draft',
        streaming: true,
      }),
    )

    // Sequence 3 arrives below the current durable cursor and triggers a
    // ledger rebuild. The process-local stream has no durable history entry.
    client.emit(liveUserMessage(3))
    await flushAsync()

    expect(store.getState().timeline.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'assistant:1:0',
        markdown: 'draft',
        streaming: true,
        liveAttemptId: 'attempt-1',
        liveLastIndex: 0,
      }),
    )
    expect(userMessageNodes(store.getState())).toHaveLength(5)
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
