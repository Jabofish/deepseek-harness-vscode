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

function hostEvent(hostSequence: number, name: string, payload: unknown): HostMessage {
  return { type: 'event', sequence: hostSequence, name, payload } as unknown as HostMessage
}

function liveTransientEvent(
  hostSequence: number,
  name: 'message.delta' | 'reasoning.delta',
  payload: Record<string, unknown>,
): HostMessage {
  return hostEvent(hostSequence, name, payload)
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
      return {
        models: [],
        failures: [],
        current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        routable: true,
      }
    default:
      throw new Error(`unexpected request ${request.type}`)
  }
}

function makeStore(
  options: {
    readonly historySequences?: readonly number[]
    readonly history?: readonly unknown[]
    readonly historyPage?: unknown
    /** Receives the 1-based session.history call index; wins over historyPage. */
    readonly historyPageForCall?: (call: number) => unknown
    readonly openResponse?: unknown
    /** Receives the 1-based session.open call index; wins over openResponse. */
    readonly openResponseForCall?: (call: number) => unknown
    readonly respond?: Respond
  } = {},
): {
  store: ReturnType<typeof createAppStore>
  client: FakeClient
} {
  const historySequences = options.historySequences ?? [1, 2, 3, 4, 5]
  let openCalls = 0
  let historyCalls = 0
  const respond: Respond = (request) => {
    if (request.type === 'session.open') {
      openCalls += 1
      return (
        options.openResponseForCall?.(openCalls) ??
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
    }
    if (request.type === 'session.history') {
      historyCalls += 1
      return (
        options.historyPageForCall?.(historyCalls) ?? options.historyPage ?? { events: [], hasMore: false }
      )
    }
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
      payload: {
        sessionId: activeSession.id,
        beforeSeq: 10,
        maxMessages: 200,
        pagePurpose: 'gap-recovery',
      },
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

  it('replays an Alpha transient prefix before its durable settlement during open', async () => {
    let releaseOpen: ((value: unknown) => void) | undefined
    const openResponse = new Promise<unknown>((resolve) => {
      releaseOpen = resolve
    })
    const { store, client } = makeStore({ openResponse })
    const opening = store.openSession(activeSession.id)
    const transientMessageId = 'assistant:1:1'
    const durableMessageId = 'durable-assistant-message-1'

    // This is the actual Alpha13 publication shape: cursorless assistant
    // chunks are followed by the durable assistant/message only after the
    // matching end frame commits. Host sequence is the only total order that
    // contains both kinds of records.
    client.emit({
      type: 'event',
      sequence: 40,
      name: 'message.delta',
      payload: {
        type: 'message.delta',
        sessionId: activeSession.id,
        messageId: transientMessageId,
        turn: 1,
        step: 1,
        delta: 'a',
        transientSequence: 1,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
      },
    } as unknown as HostMessage)
    client.emit({
      type: 'event',
      sequence: 41,
      name: 'reasoning.delta',
      payload: {
        type: 'reasoning.delta',
        sessionId: activeSession.id,
        messageId: transientMessageId,
        turn: 1,
        step: 1,
        delta: 'thinking',
        transientSequence: 2,
        transientAttemptId: 'attempt-1',
        transientIndex: 1,
      },
    } as unknown as HostMessage)
    client.emit({
      type: 'event',
      sequence: 42,
      name: 'message.completed',
      payload: {
        type: 'message.completed',
        sessionId: activeSession.id,
        messageId: durableMessageId,
        turn: 1,
        step: 1,
        markdown: 'a',
        reasoning: 'thinking',
        sequence: 6,
      },
    } as unknown as HostMessage)
    client.emit({
      type: 'event',
      sequence: 43,
      name: 'turn.ended',
      payload: {
        type: 'turn.ended',
        sessionId: activeSession.id,
        turn: 1,
        reason: 'completed',
        sequence: 7,
      },
    } as unknown as HostMessage)

    releaseOpen?.({
      ...activeSession,
      history: [],
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

    const assistant = store
      .getState()
      .timeline.nodes.find((node) => node.kind === 'assistant-message' && node.id === durableMessageId)
    expect(assistant).toMatchObject({
      markdown: 'a',
      streaming: false,
      reasoning: { markdown: 'thinking', streaming: false },
    })
    expect(store.getState().timeline.lastSequence).toBe(7)
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

  it('replays every control event delivered before first paint over stale advisory snapshots', async () => {
    const sessionId = activeSession.id
    const queueItem = {
      id: 'queue-live',
      sessionId,
      text: 'continue after the tool result',
      attachments: [],
      textOnly: true,
      mode: 'queue' as const,
      createdAt: '2026-08-31T08:06:00.000Z',
    }
    const goal = { id: 'goal-live', title: 'Finish the verification', status: 'in-progress' as const }
    const job = {
      id: 'job-live',
      kind: 'shell',
      label: 'Verify report',
      status: 'running' as const,
      startedAt: 1_727_000_000_000,
    }
    const permission = {
      id: 'permission-live',
      sessionId,
      title: 'Allow verification command?',
      description: 'The verification command needs approval.',
      risk: 'medium' as const,
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' as const }],
    }
    const question = {
      id: 'question-live',
      sessionId,
      prompt: 'Which report should be verified?',
      choices: [{ id: 'latest', label: 'The latest report' }],
      allowFreeText: false,
    }
    const controlEvent = (name: string, payload: unknown, sequence: number): HostMessage =>
      ({
        type: 'event',
        sequence,
        name,
        payload,
      }) as unknown as HostMessage
    let releaseQueue: (() => void) | undefined
    const queueList = new Promise<unknown>((resolve) => {
      releaseQueue = () => resolve([])
    })
    const clientHolder: { current?: FakeClient } = {}
    const { store, client: createdClient } = makeStore({
      respond: (request) => {
        if (request.type === 'session.queue.list') {
          // The real Host can publish from another stream while the critical
          // history request is still being installed. Return an intentionally
          // stale advisory response after first paint to exercise the race.
          clientHolder.current?.emit(controlEvent('queue.updated', { sessionId, items: [queueItem] }, 50))
          clientHolder.current?.emit(controlEvent('goal.updated', { sessionId, goals: [goal] }, 51))
          clientHolder.current?.emit(controlEvent('jobs.updated', { sessionId, jobs: [job] }, 52))
          clientHolder.current?.emit(controlEvent('permission.requested', { request: permission }, 53))
          clientHolder.current?.emit(controlEvent('question.requested', { question }, 54))
          return queueList
        }
        return baseResponse(request)
      },
    })
    clientHolder.current = createdClient

    const opening = store.openSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseQueue?.()
    await opening
    await flushAsync()

    expect(store.queue).toEqual([queueItem])
    expect(store.goals).toEqual([goal])
    expect(store.jobs).toEqual([job])
    expect(store.permissions).toEqual([permission])
    expect(store.questions).toEqual([question])
    store.dispose()
    createdClient.dispose()
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

  it('clears a published gap notice once a later backfill read covers the hole', async () => {
    const sessionId = activeSession.id
    const { store, client } = makeStore({
      historySequences: [1, 4, 5],
      historyPageForCall: (call) => {
        if (call === 1) throw new Error('history endpoint is down')
        return {
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
          // The raw window covers the announced hole even though the
          // presentation ledger can only carry the delta row at sequence 3.
          coveredSeqRanges: [{ from: 2, to: 3 }],
        }
      },
    })
    await store.openSession(sessionId)

    client.emit(gapMessage(2, 3))
    await flushAsync()
    expect(store.getState().timeline.nodes.some((node) => node.id === `gap:${sessionId}:2:3`)).toBe(true)

    // A re-announced hole re-fetches; this read succeeds and reports that the
    // range is fully covered, so the warning no longer describes the transcript.
    client.emit(gapMessage(2, 3))
    await flushAsync()

    const state = store.getState()
    expect(historyRequests(client)).toHaveLength(2)
    expect(state.timeline.nodes.some((node) => node.id === `gap:${sessionId}:2:3`)).toBe(false)
    expect(
      state.timeline.nodes.some((node) => node.kind === 'assistant-message' && node.id === 'assistant-1'),
    ).toBe(true)
  })

  it('clears a published gap notice when paging reads a covered window', async () => {
    const sessionId = activeSession.id
    const { store, client } = makeStore({
      history: [4, 5].map((sequence) => userMessageHistoryEntry(sequence)),
      openResponse: {
        ...activeSession,
        history: [4, 5].map((sequence) => userMessageHistoryEntry(sequence)),
        historyHasMore: true,
        permissionPresets: [],
        configuration: {
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        },
      },
      historyPageForCall: (call) => {
        if (call === 1) throw new Error('history endpoint is down')
        return {
          events: [userMessageHistoryEntry(3)],
          hasMore: false,
          beforeSeq: 3,
          coveredSeqRanges: [{ from: 2, to: 3 }],
        }
      },
    })
    await store.openSession(sessionId)

    client.emit(gapMessage(2, 3))
    await flushAsync()
    expect(store.getState().timeline.nodes.some((node) => node.id === `gap:${sessionId}:2:3`)).toBe(true)

    await store.loadOlderHistory()
    const state = store.getState()
    expect(historyRequests(client)).toHaveLength(2)
    expect(state.timeline.nodes.some((node) => node.id === `gap:${sessionId}:2:3`)).toBe(false)
  })

  it('keeps one warning row for adjacent unhealed announcements', async () => {
    const sessionId = activeSession.id
    const { store, client } = makeStore({
      respond: () => {
        throw new Error('history endpoint is down')
      },
    })
    await store.openSession(sessionId)

    client.emit(gapMessage(6, 9))
    await flushAsync()
    client.emit(gapMessage(10, 11))
    await flushAsync()

    const notices = store.getState().timeline.nodes.filter((node) => node.id.startsWith(`gap:${sessionId}:`))
    // Both announcements describe one contiguous hole, so the transcript must
    // not show two overlapping warnings for it.
    expect(notices).toHaveLength(1)
    expect(notices[0]?.id).toBe(`gap:${sessionId}:6:11`)
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

  it('preserves the live transcript position when a later durable row triggers a rebuild', async () => {
    const sessionId = activeSession.id
    const { store, client } = makeStore({
      history: [
        historyEvent(0, {
          type: 'message.user',
          sessionId,
          messageId: 'user-1',
          markdown: 'inspect the live result',
          source: 'user',
        }),
      ],
    })
    await store.openSession(sessionId)

    // The live assistant prefix is observed before the durable tool row. The
    // later duplicate tool row is the kind of below-cursor recovery delivery
    // that forces a ledger rebuild.
    client.emit(
      liveTransientEvent(30_001, 'message.delta', {
        type: 'message.delta',
        sessionId,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'The live result is ready.',
        transientSequence: 1,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
        transientStartedAfterSequence: 0,
      }),
    )
    const tool = {
      type: 'tool.updated',
      sessionId,
      tool: toolView('call-1', 'completed', 'verified'),
      sequence: 2,
    }
    client.emit(liveEvent(2, tool))
    expect(store.getState().timeline.nodes.map((node) => node.id)).toEqual([
      'user-1',
      'assistant:1:1',
      'call-1',
    ])

    // Redelivery has a new Host sequence but the same durable record.
    client.emit(hostEvent(30_003, 'tool.updated', tool))
    await flushAsync()

    expect(store.getState().timeline.nodes.map((node) => node.id)).toEqual([
      'user-1',
      'assistant:1:1',
      'call-1',
    ])
    store.dispose()
    client.dispose()
  })

  it('does not let a durable settlement be overwritten by a live node during rebuild', async () => {
    const { store, client } = makeStore({ historySequences: [1, 2, 4, 5] })
    await store.openSession(activeSession.id)

    client.emit({
      type: 'event',
      sequence: 30_001,
      name: 'message.delta',
      payload: {
        type: 'message.delta',
        sessionId: activeSession.id,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'partial answer',
        transientSequence: 1,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
      },
    } as unknown as HostMessage)
    client.emit(
      liveEvent(3, {
        type: 'message.completed',
        sessionId: activeSession.id,
        messageId: 'durable-assistant-1',
        turn: 1,
        step: 1,
        markdown: 'final answer',
        reasoning: 'final reasoning',
      }),
    )

    await flushAsync()

    expect(store.getState().timeline.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'assistant-message',
        id: 'durable-assistant-1',
        markdown: 'final answer',
        streaming: false,
        reasoning: { markdown: 'final reasoning', streaming: false },
      }),
    )
    expect(store.getState().timeline.nodes.filter((node) => node.kind === 'assistant-message')).toHaveLength(
      1,
    )
    store.dispose()
    client.dispose()
  })

  it('does not let an earlier same-coordinate retry absorb a newer live attempt during rebuild', async () => {
    const sessionId = activeSession.id
    const { store, client } = makeStore({
      history: [
        historyEvent(5, {
          type: 'message.completed',
          sessionId,
          messageId: 'durable-attempt-1',
          turn: 1,
          step: 1,
          markdown: 'first attempt was persisted',
        }),
      ],
    })
    await store.openSession(sessionId)

    // Alpha starts a retry at the same logical turn/step with a new
    // process-local attempt identity. It has no durable settlement yet.
    client.emit({
      type: 'event',
      sequence: 30_001,
      name: 'message.delta',
      payload: {
        type: 'message.delta',
        sessionId,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'second attempt is still running',
        transientSequence: 1,
        transientAttemptId: 'attempt-2',
        transientIndex: 0,
        transientStartedAfterSequence: 5,
      },
    } as unknown as HostMessage)

    // An older recovery record arrives below the current durable cursor and
    // forces a ledger rebuild while the retry is still streaming.
    client.emit(liveUserMessage(3))
    await flushAsync()

    const assistantNodes = store.getState().timeline.nodes.filter((node) => node.kind === 'assistant-message')
    expect(assistantNodes).toHaveLength(2)
    expect(assistantNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'durable-attempt-1',
          markdown: 'first attempt was persisted',
          streaming: false,
        }),
        expect.objectContaining({
          id: 'assistant:1:1',
          markdown: 'second attempt is still running',
          streaming: true,
          liveAttemptId: 'attempt-2',
        }),
      ]),
    )
    store.dispose()
    client.dispose()
  })

  it('does not reattach a failed live attempt when its assistant attempt is in history', async () => {
    const sessionId = activeSession.id
    const { store, client } = makeStore({
      history: [
        historyEvent(5, {
          type: 'assistant.attempt',
          sessionId,
          turn: 1,
          step: 1,
          time: 5_000,
        }),
      ],
    })
    await store.openSession(sessionId)

    client.emit({
      type: 'event',
      sequence: 30_001,
      name: 'message.delta',
      payload: {
        type: 'message.delta',
        sessionId,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'stale attempt prefix',
        transientSequence: 1,
        transientAttemptId: 'attempt-failed',
        transientIndex: 0,
        transientStartedAfterSequence: 0,
      },
    } as unknown as HostMessage)
    expect(store.getState().timeline.nodes).toContainEqual(
      expect.objectContaining({ markdown: 'stale attempt prefix', streaming: true }),
    )

    // A below-cursor recovery record rebuilds from the durable ledger. The
    // attempt settlement has no visible node, so the merge must explicitly
    // discard the old process-local prefix.
    client.emit(liveUserMessage(3))
    await flushAsync()

    expect(store.getState().timeline.nodes).not.toContainEqual(
      expect.objectContaining({ markdown: 'stale attempt prefix' }),
    )
    expect(store.getState().timeline.nodes.some((node) => node.kind === 'assistant-message')).toBe(false)
    store.dispose()
    client.dispose()
  })

  it('keeps a multi-request Alpha-like stream complete across first paint and advisory replay', async () => {
    const sessionId = activeSession.id
    let releaseOpen: ((value: unknown) => void) | undefined
    const openResponse = new Promise<unknown>((resolve) => {
      releaseOpen = resolve
    })
    let releaseQueue: (() => void) | undefined
    const staleQueue = new Promise<unknown>((resolve) => {
      releaseQueue = () => resolve([])
    })
    let queueRequestStarted = false
    const durableEvent = (
      hostSequence: number,
      sequence: number,
      event: Record<string, unknown>,
    ): HostMessage =>
      hostEvent(hostSequence, typeof event.type === 'string' ? event.type : 'unknown', { ...event, sequence })
    const tool = (
      id: string,
      turn: number,
      step: number,
      status: 'running' | 'completed' | 'failed',
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id,
      name: 'shell',
      category: 'execution',
      title: 'Shell',
      status,
      turn,
      step,
      metadata: {},
      ...extra,
    })
    const queueBefore = {
      id: 'queue-before-paint',
      sessionId,
      text: 'inspect the second result',
      attachments: [],
      textOnly: true,
      mode: 'queue' as const,
      createdAt: '2026-08-31T08:06:00.000Z',
    }
    const queueAfter = {
      id: 'queue-after-paint',
      sessionId,
      text: 'keep the live tail visible',
      attachments: [],
      textOnly: true,
      mode: 'steer' as const,
      createdAt: '2026-08-31T08:07:00.000Z',
    }
    const goalBefore = { id: 'goal-complex', title: 'Inspect both results', status: 'in-progress' as const }
    const goalAfter = { id: 'goal-complex', title: 'Inspect both results', status: 'completed' as const }
    const todoBefore = {
      id: 'todo-complex',
      content: 'Compare nested tool output',
      status: 'in-progress' as const,
    }
    const todoAfter = {
      id: 'todo-complex',
      content: 'Compare nested tool output',
      status: 'completed' as const,
    }
    const jobBefore = {
      id: 'job-complex',
      kind: 'shell',
      label: 'Run verification',
      status: 'running' as const,
      startedAt: 1_727_000_000_000,
    }
    const jobAfter = { ...jobBefore, status: 'completed' as const, finishedAt: 1_727_000_000_500 }
    const permissionBefore = {
      id: 'permission-before',
      rpcId: 'permission-rpc-before',
      sessionId,
      title: 'Allow the first verification?',
      description: 'The first tool needs approval.',
      risk: 'medium' as const,
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' as const }],
    }
    const permissionAfter = {
      ...permissionBefore,
      id: 'permission-after',
      rpcId: 'permission-rpc-after',
      title: 'Allow the second verification?',
    }
    const questionBefore = {
      id: 'question-before',
      rpcId: 'question-rpc-before',
      sessionId,
      prompt: 'Which report should be compared?',
      choices: [{ id: 'latest', label: 'The latest report' }],
      allowFreeText: false,
    }
    const questionAfter = {
      ...questionBefore,
      id: 'question-after',
      rpcId: 'question-rpc-after',
      prompt: 'Which live result should remain open?',
    }
    const { store, client } = makeStore({
      openResponse,
      respond: (request) => {
        if (request.type === 'session.queue.list') {
          queueRequestStarted = true
          // The real advisory read can lag behind both the durable stream and
          // the process-local control stream. Keep it stale until all live
          // records have had a chance to cross the open barrier.
          return staleQueue
        }
        return baseResponse(request)
      },
    })
    const opening = store.openSession(sessionId)
    const beforeFirstPaint: HostMessage[] = [
      hostEvent(100, 'session.subscribed', {
        sessionId,
        lastSequence: 5,
        controlBaseline: false,
      }),
      durableEvent(101, 6, {
        type: 'tool.updated',
        sessionId,
        tool: tool('call-root-1:ptc:1', 1, 1, 'failed', {
          parentCallId: 'call-root-1',
          error: 'nested command failed',
        }),
      }),
      durableEvent(102, 7, {
        type: 'tool.updated',
        sessionId,
        tool: tool('call-root-1', 1, 1, 'completed', { outputSummary: 'root recovered' }),
      }),
      durableEvent(103, 8, {
        type: 'deliverables.presented',
        sessionId,
        turn: 1,
        callId: 'call-root-1',
        files: [{ path: 'artifacts/first-report.md', description: 'First report' }],
      }),
      liveTransientEvent(104, 'reasoning.delta', {
        type: 'reasoning.delta',
        sessionId,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'I compared the nested result. ',
        transientSequence: 1,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
      }),
      liveTransientEvent(105, 'message.delta', {
        type: 'message.delta',
        sessionId,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'The first result is ready.',
        transientSequence: 2,
        transientAttemptId: 'attempt-1',
        transientIndex: 1,
      }),
      durableEvent(106, 9, {
        type: 'message.completed',
        sessionId,
        messageId: 'durable-assistant-1',
        turn: 1,
        step: 1,
        markdown: 'The first result is ready.',
        reasoning: 'I compared the nested result. ',
        usage: { inputTokens: 32, outputTokens: 14, reasoningTokens: 5 },
      }),
      durableEvent(107, 10, { type: 'step.ended', sessionId, turn: 1, step: 1 }),
      durableEvent(108, 11, { type: 'turn.ended', sessionId, turn: 1, reason: 'completed' }),
      hostEvent(109, 'queue.updated', { sessionId, items: [queueBefore] }),
      hostEvent(110, 'goal.updated', { sessionId, goals: [goalBefore] }),
      hostEvent(111, 'todo.updated', { sessionId, todos: [todoBefore] }),
      hostEvent(112, 'jobs.updated', { sessionId, jobs: [jobBefore] }),
      hostEvent(113, 'permission.requested', { request: permissionBefore }),
      hostEvent(114, 'question.requested', { question: questionBefore }),
      hostEvent(115, 'permission.resolved', {
        sessionId,
        requestId: permissionBefore.id,
        outcome: 'approved',
      }),
      hostEvent(116, 'question.resolved', {
        sessionId,
        questionId: questionBefore.id,
        questionRpcId: questionBefore.rpcId,
        outcome: 'answered',
      }),
      hostEvent(117, 'goal.updated', { sessionId, goals: [goalAfter] }),
      hostEvent(118, 'todo.updated', { sessionId, todos: [todoAfter] }),
      hostEvent(119, 'jobs.updated', { sessionId, jobs: [jobAfter] }),
      durableEvent(120, 12, {
        type: 'message.user',
        sessionId,
        messageId: 'user-2',
        rpcId: 'rpc-2',
        markdown: 'Now inspect the second result.',
        source: 'user',
      }),
      durableEvent(121, 13, { type: 'turn.started', sessionId, turn: 2 }),
      durableEvent(122, 14, { type: 'step.started', sessionId, turn: 2, step: 1 }),
      durableEvent(123, 15, {
        type: 'tool.updated',
        sessionId,
        tool: tool('call-root-2', 2, 1, 'running'),
      }),
      durableEvent(124, 16, {
        type: 'tool.updated',
        sessionId,
        tool: tool('call-root-2:ptc:1', 2, 1, 'running', { parentCallId: 'call-root-2' }),
      }),
      durableEvent(125, 17, {
        type: 'tool.updated',
        sessionId,
        tool: tool('call-root-2:ptc:1', 2, 1, 'completed', {
          parentCallId: 'call-root-2',
          outputSummary: 'nested result',
        }),
      }),
      durableEvent(126, 18, {
        type: 'tool.updated',
        sessionId,
        tool: tool('call-root-2', 2, 1, 'completed', { outputSummary: 'second root recovered' }),
      }),
      durableEvent(127, 19, {
        type: 'model.retry',
        retry: {
          sessionId,
          id: 'retry-2',
          turn: 2,
          step: 1,
          attempt: 1,
          state: 'scheduled',
          delayMs: 250,
          maxRetries: 2,
          message: 'retrying provider request',
        },
      }),
      durableEvent(128, 20, {
        type: 'model.retry',
        retry: {
          sessionId,
          id: 'retry-2',
          turn: 2,
          step: 1,
          attempt: 1,
          state: 'started',
          delayMs: 250,
          maxRetries: 2,
          message: 'retrying provider request',
        },
      }),
      durableEvent(129, 21, {
        type: 'deliverables.presented',
        sessionId,
        turn: 2,
        callId: 'call-root-2',
        files: [{ path: 'artifacts/second-report.md', description: 'Second report' }],
      }),
      liveTransientEvent(130, 'reasoning.delta', {
        type: 'reasoning.delta',
        sessionId,
        messageId: 'assistant:2:1',
        turn: 2,
        step: 1,
        delta: 'The second result needs one more check. ',
        transientSequence: 1,
        transientAttemptId: 'attempt-2',
        transientIndex: 0,
      }),
      liveTransientEvent(131, 'message.delta', {
        type: 'message.delta',
        sessionId,
        messageId: 'assistant:2:1',
        turn: 2,
        step: 1,
        delta: 'The second result is ready.',
        transientSequence: 2,
        transientAttemptId: 'attempt-2',
        transientIndex: 1,
      }),
      durableEvent(132, 21, {
        type: 'session.projection',
        sessionId,
        key: 'tokenUsage',
        value: { inputTokens: 64, outputTokens: 28 },
      }),
      durableEvent(133, 21, {
        type: 'session.projection',
        sessionId,
        key: 'contextPressure',
        value: { pressureTokens: 96 },
      }),
      durableEvent(134, 22, {
        type: 'message.completed',
        sessionId,
        messageId: 'durable-assistant-2',
        turn: 2,
        step: 1,
        markdown: 'The second result is ready.',
        reasoning: 'The second result needs one more check. ',
      }),
      durableEvent(135, 23, { type: 'step.ended', sessionId, turn: 2, step: 1 }),
      durableEvent(136, 24, { type: 'turn.ended', sessionId, turn: 2, reason: 'completed' }),
      // The same durable tool event can be redelivered by a reconnect with a
      // new Host sequence. It must not create a second timeline/history row.
      durableEvent(137, 17, {
        type: 'tool.updated',
        sessionId,
        tool: tool('call-root-2:ptc:1', 2, 1, 'completed', {
          parentCallId: 'call-root-2',
          outputSummary: 'nested result',
        }),
      }),
      durableEvent(138, 25, {
        type: 'future.new-event',
        sessionId,
        detail: 'preserve unknown durable records for forward compatibility',
      }),
    ]
    for (const message of beforeFirstPaint) client.emit(message)
    releaseOpen?.({
      ...activeSession,
      history: [
        historyEvent(1, {
          type: 'message.user',
          sessionId,
          messageId: 'user-1',
          markdown: 'Review the first result.',
          source: 'user',
        }),
        historyEvent(2, { type: 'turn.started', sessionId, turn: 1 }),
        historyEvent(3, { type: 'step.started', sessionId, turn: 1, step: 1 }),
        historyEvent(4, {
          type: 'tool.updated',
          sessionId,
          tool: tool('call-root-1', 1, 1, 'running'),
        }),
        historyEvent(5, {
          type: 'tool.updated',
          sessionId,
          tool: tool('call-root-1:ptc:1', 1, 1, 'running', { parentCallId: 'call-root-1' }),
        }),
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
    expect(queueRequestStarted).toBe(true)

    // These records arrive after first paint while the queue/list snapshot is
    // still in flight. They must be applied live, then remain intact when the
    // stale advisory [] response is finally merged.
    const afterFirstPaint: HostMessage[] = [
      hostEvent(200, 'queue.updated', { sessionId, items: [queueAfter] }),
      hostEvent(201, 'goal.updated', { sessionId, goals: [goalAfter] }),
      hostEvent(202, 'todo.updated', { sessionId, todos: [todoAfter] }),
      hostEvent(203, 'jobs.updated', { sessionId, jobs: [jobAfter] }),
      hostEvent(204, 'permission.requested', { request: permissionAfter }),
      hostEvent(205, 'question.requested', { question: questionAfter }),
      durableEvent(206, 26, {
        type: 'message.user',
        sessionId,
        messageId: 'user-3',
        rpcId: 'rpc-3',
        markdown: 'Keep the live verification open.',
        source: 'user',
      }),
      durableEvent(207, 27, { type: 'turn.started', sessionId, turn: 3 }),
      durableEvent(208, 28, { type: 'step.started', sessionId, turn: 3, step: 1 }),
      liveTransientEvent(209, 'reasoning.delta', {
        type: 'reasoning.delta',
        sessionId,
        messageId: 'assistant:3:1',
        turn: 3,
        step: 1,
        delta: 'The live verification is still running. ',
        transientSequence: 1,
        transientAttemptId: 'attempt-3',
        transientIndex: 0,
      }),
      liveTransientEvent(210, 'message.delta', {
        type: 'message.delta',
        sessionId,
        messageId: 'assistant:3:1',
        turn: 3,
        step: 1,
        delta: 'Live verification in progress.',
        transientSequence: 2,
        transientAttemptId: 'attempt-3',
        transientIndex: 1,
      }),
    ]
    for (const message of afterFirstPaint) client.emit(message)
    releaseQueue?.()
    await flushAsync()

    const state = store.getState()
    expect(state.activeSessionId).toBe(sessionId)
    expect(userMessageNodes(state).map((node) => node.id)).toEqual(['user-1', 'user-2', 'user-3'])
    expect(state.history.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 28 }, (_value, index) => index + 1).flatMap((sequence) =>
        sequence === 21 ? [sequence, sequence, sequence] : [sequence],
      ),
    )
    expect(state.history.filter((entry) => entry.sequence === 17)).toHaveLength(1)
    expect(state.history.filter((entry) => entry.sequence === 21)).toHaveLength(3)
    expect(state.timeline.lastSequence).toBe(28)

    const assistants = state.timeline.nodes.filter((node) => node.kind === 'assistant-message')
    expect(assistants).toHaveLength(3)
    expect(assistants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'durable-assistant-1',
          markdown: 'The first result is ready.',
          streaming: false,
          reasoning: { markdown: 'I compared the nested result. ', streaming: false },
        }),
        expect.objectContaining({
          id: 'durable-assistant-2',
          markdown: 'The second result is ready.',
          streaming: false,
          reasoning: { markdown: 'The second result needs one more check. ', streaming: false },
        }),
        expect.objectContaining({
          id: 'assistant:3:1',
          markdown: 'Live verification in progress.',
          streaming: true,
          reasoning: { markdown: 'The live verification is still running. ', streaming: false },
        }),
      ]),
    )

    const tools = state.timeline.nodes.filter((node) => node.kind === 'tool')
    expect(tools).toHaveLength(4)
    const toolById = (id: string): (typeof tools)[number]['tool'] | undefined =>
      tools.find((node) => node.id === id)?.tool
    expect(toolById('call-root-1')?.status).toBe('completed')
    expect(toolById('call-root-1:ptc:1')).toMatchObject({
      parentCallId: 'call-root-1',
      status: 'failed',
      error: 'nested command failed',
    })
    expect(toolById('call-root-2')?.status).toBe('completed')
    expect(toolById('call-root-2:ptc:1')).toMatchObject({
      parentCallId: 'call-root-2',
      status: 'completed',
      outputSummary: 'nested result',
    })
    expect(state.timeline.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'deliverables',
          id: 'deliverables:call-root-1',
          files: [{ path: 'artifacts/first-report.md', description: 'First report' }],
        }),
        expect.objectContaining({
          kind: 'deliverables',
          id: 'deliverables:call-root-2',
          files: [{ path: 'artifacts/second-report.md', description: 'Second report' }],
        }),
        expect.objectContaining({ kind: 'retry', id: 'retry:retry-2', turn: 2, step: 1, attempt: 1 }),
        expect.objectContaining({ kind: 'event', name: 'future.new-event', sequence: 25 }),
      ]),
    )
    expect(state.projections[sessionId]).toEqual({
      tokenUsage: { inputTokens: 64, outputTokens: 28 },
      contextPressure: { pressureTokens: 96 },
    })
    expect(state.queue).toEqual([queueAfter])
    expect(state.goals).toEqual([goalAfter])
    expect(state.todos).toEqual([todoAfter])
    expect(state.jobs).toEqual([jobAfter])
    expect(state.permissions).toEqual([permissionAfter])
    expect(state.questions).toEqual([questionAfter])
    store.dispose()
    client.dispose()
  })

  it('keeps a newer retry after an earlier settlement during the open replay', async () => {
    let releaseOpen: ((value: unknown) => void) | undefined
    const openResponse = new Promise<unknown>((resolve) => {
      releaseOpen = resolve
    })
    const { store, client } = makeStore({ openResponse })
    const opening = store.openSession(activeSession.id)

    // The old attempt was already durable when the newer Alpha attempt
    // started. Host sequence is the only total order that contains both the
    // durable settlement and the cursorless live prefix.
    client.emit(
      liveEvent(5, {
        type: 'message.completed',
        sessionId: activeSession.id,
        messageId: 'durable-attempt-1',
        turn: 1,
        step: 1,
        markdown: 'old attempt',
      }),
    )
    client.emit(
      liveTransientEvent(30_006, 'message.delta', {
        type: 'message.delta',
        sessionId: activeSession.id,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'new attempt',
        transientSequence: 1,
        transientAttemptId: 'attempt-2',
        transientIndex: 0,
        transientStartedAfterSequence: 5,
      }),
    )
    releaseOpen?.({
      ...activeSession,
      history: [],
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

    const assistants = store.getState().timeline.nodes.filter((node) => node.kind === 'assistant-message')
    expect(assistants).toHaveLength(2)
    expect(assistants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'durable-attempt-1', markdown: 'old attempt', streaming: false }),
        expect.objectContaining({
          id: 'assistant:1:1',
          markdown: 'new attempt',
          streaming: true,
          liveAttemptId: 'attempt-2',
        }),
      ]),
    )
    store.dispose()
    client.dispose()
  })

  it('uses the attempt cursor when an earlier settlement arrives after the live prefix', async () => {
    let releaseOpen: ((value: unknown) => void) | undefined
    const openResponse = new Promise<unknown>((resolve) => {
      releaseOpen = resolve
    })
    const { store, client } = makeStore({ openResponse })
    const opening = store.openSession(activeSession.id)

    // Simulate two merged sources: the new Alpha attempt is observed first,
    // while the previous durable settlement is delivered later. The attempt
    // cursor still places the older settlement before the live prefix.
    client.emit(
      liveTransientEvent(30, 'message.delta', {
        type: 'message.delta',
        sessionId: activeSession.id,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'new attempt',
        transientSequence: 1,
        transientAttemptId: 'attempt-2',
        transientIndex: 0,
        transientStartedAfterSequence: 5,
      }),
    )
    client.emit(
      hostEvent(40, 'message.completed', {
        type: 'message.completed',
        sessionId: activeSession.id,
        messageId: 'durable-attempt-1',
        turn: 1,
        step: 1,
        markdown: 'old attempt',
        sequence: 5,
      }),
    )
    releaseOpen?.({
      ...activeSession,
      history: [],
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

    expect(store.getState().timeline.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'durable-attempt-1', markdown: 'old attempt', streaming: false }),
        expect.objectContaining({
          id: 'assistant:1:1',
          markdown: 'new attempt',
          streaming: true,
          liveAttemptId: 'attempt-2',
        }),
      ]),
    )
    store.dispose()
    client.dispose()
  })

  it('does not let an older Alpha follow projection baseline overwrite a newer control update', async () => {
    const sessionId = activeSession.id
    const firstEpochDetail = {
      ...activeSession,
      history: [],
      historyHasMore: false,
      permissionPresets: [],
      projection: {
        asOfSequence: 5,
        values: {
          contextPressure: { pressureTokens: 5 },
          tokenUsage: { outputTokens: 5 },
        },
      },
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      },
    }
    const { store, client } = makeStore({
      // The replacement process answers the reopen with its own authoritative
      // baseline: lower durable sequences than the previous process, which its
      // predecessor's cuts must not fence out as stale.
      openResponseForCall: (call) =>
        call === 1
          ? firstEpochDetail
          : {
              ...firstEpochDetail,
              backendInstanceId: 'backend-next',
              projection: {
                asOfSequence: 1,
                values: {
                  contextPressure: { pressureTokens: 1 },
                  tokenUsage: { outputTokens: 1 },
                },
              },
            },
    })
    await store.openSession(sessionId)
    await flushAsync()

    client.emit(
      hostEvent(200, 'session.projection', {
        sessionId,
        key: 'contextPressure',
        value: { pressureTokens: 20 },
        sequence: 20,
      }),
    )
    // Session/follow and session/control are independent Alpha streams. The
    // follow snapshot is older, but can be published after the control update.
    // Its tokenUsage cell is still newer than the open baseline and must not be
    // discarded merely because contextPressure already has a higher cut.
    client.emit(
      hostEvent(201, 'session.subscribed', {
        sessionId,
        lastSequence: 10,
        controlBaseline: false,
        projection: {
          asOfSequence: 10,
          values: {
            contextPressure: { pressureTokens: 10 },
            tokenUsage: { outputTokens: 10 },
          },
        },
      }),
    )
    await flushAsync()

    expect(store.projections[sessionId]).toEqual({
      contextPressure: { pressureTokens: 20 },
      tokenUsage: { outputTokens: 10 },
    })

    // A manual reconnect may publish lifecycle snapshots without a separate
    // connection.lost event. The replacement process is allowed to reuse lower
    // durable sequence values and must seed its new projection epoch.
    client.emit(hostEvent(202, 'connection.snapshot', { kind: 'idle' }))
    client.emit(
      hostEvent(203, 'connection.snapshot', {
        kind: 'connected',
        backendInstanceId: 'backend-next',
        connectionGeneration: 2,
      }),
    )
    client.emit(
      hostEvent(204, 'session.subscribed', {
        sessionId,
        lastSequence: 1,
        controlBaseline: false,
        projection: {
          asOfSequence: 1,
          values: {
            contextPressure: { pressureTokens: 1 },
            tokenUsage: { outputTokens: 1 },
          },
        },
      }),
    )
    await flushAsync()
    expect(store.projections[sessionId]).toEqual({
      contextPressure: { pressureTokens: 1 },
      tokenUsage: { outputTokens: 1 },
    })
    store.dispose()
    client.dispose()
  })

  it('fences delayed projections for keys omitted by a complete baseline', async () => {
    const sessionId = activeSession.id
    const { store, client } = makeStore()
    await store.openSession(sessionId)

    client.emit(
      hostEvent(300, 'session.projection', {
        sessionId,
        key: 'removedKey',
        value: { stale: true },
        sequence: 8,
      }),
    )
    client.emit(
      hostEvent(301, 'session.subscribed', {
        sessionId,
        lastSequence: 10,
        controlBaseline: false,
        projection: { asOfSequence: 10, values: {} },
      }),
    )
    client.emit(
      hostEvent(302, 'session.projection', {
        sessionId,
        key: 'removedKey',
        value: { stale: true, replayed: true },
        sequence: 9,
      }),
    )
    client.emit(
      hostEvent(303, 'session.projection', {
        sessionId,
        key: 'newKey',
        value: { fresh: true },
        sequence: 11,
      }),
    )
    await flushAsync()

    expect(store.projections[sessionId]).toEqual({ newKey: { fresh: true } })
    store.dispose()
    client.dispose()
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

  it('keeps an announced hole when another session takes over its backfill', async () => {
    const sessionId = activeSession.id
    const otherSessionId = 'session-other'
    let releasePage: ((value: unknown) => void) | undefined
    const page = new Promise<unknown>((resolve) => {
      releasePage = resolve
    })
    const configuration = {
      preset: 'standard',
      toolMode: 'native',
      permissionPreset: 'workspace-write',
      planMode: false,
      model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    }
    const historyOf = (id: string, sequences: readonly number[]): unknown[] =>
      sequences.map((sequence) => ({
        sequence,
        time: '2026-08-31T08:00:00.000Z',
        event: {
          type: 'message.user',
          sessionId: id,
          messageId: `${id}-${sequence}`,
          markdown: `message ${sequence}`,
        },
      }))
    const client = new FakeClient((request) => {
      if (request.type === 'session.open') {
        const requested = (request.payload as { readonly sessionId?: string }).sessionId
        const id = requested === otherSessionId ? otherSessionId : sessionId
        return {
          ...activeSession,
          id,
          // The other session's ledger numerically covers the announced
          // range. That says nothing about this session's hole.
          history: historyOf(id, id === otherSessionId ? [6, 7, 8, 9] : [1, 2, 3, 4, 5]),
          historyHasMore: false,
          permissionPresets: [],
          configuration,
        }
      }
      if (request.type === 'session.history') return page
      if (request.type === 'session.list')
        return { items: [activeSession, { ...activeSession, id: otherSessionId }] }
      return baseResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(sessionId)
    // Let the open barrier settle first: an announcement delivered while the
    // barrier is still buffering is replayed on the next open, which would
    // mask a lost range behind an accidental second backfill.
    await flushAsync()
    expect(userMessageNodes(store.getState())).toHaveLength(5)

    client.emit(gapMessage(6, 9))
    expect(historyRequests(client)).toHaveLength(1)

    await store.openSession(otherSessionId)
    await flushAsync()
    releasePage?.({ events: [], hasMore: false })
    await flushAsync()

    // Coming back to the session re-derives the notice from its own history:
    // the range was never healed, so it must still be announced.
    await store.openSession(sessionId)
    const state = store.getState()
    expect(userMessageNodes(state)).toHaveLength(5)
    expect(state.timeline.nodes.some((node) => node.id === `gap:${sessionId}:6:9`)).toBe(true)
    store.dispose()
    client.dispose()
  })

  it('keeps the notice when the session is reopened while its backfill read is in flight', async () => {
    let releasePage: ((value: unknown) => void) | undefined
    const page = new Promise<unknown>((resolve) => {
      releasePage = resolve
    })
    const { store, client } = makeStore({ historyPage: page })
    await store.openSession(activeSession.id)
    // An announcement buffered by the open barrier is replayed by the next
    // open, so the barrier has to settle before the hole is announced.
    await flushAsync()

    client.emit(gapMessage(6, 9))
    expect(historyRequests(client)).toHaveLength(1)

    await store.openSession(activeSession.id)
    await flushAsync()
    releasePage?.({ events: [], hasMore: false })
    await flushAsync()

    const state = store.getState()
    expect(userMessageNodes(state)).toHaveLength(5)
    expect(state.timeline.nodes.some((node) => node.id === `gap:${activeSession.id}:6:9`)).toBe(true)
    store.dispose()
    client.dispose()
  })
})
