// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

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

  it('repeats the ready handshake on resync even when the connected snapshot was missed', async () => {
    const { store, client } = makeStore()
    expect(store.getState().backend.kind).toBe('idle')
    client.emit(hostEvent(1, 'ui.resync', {}))
    await flushAsync()
    expect(client.requests.some((request) => request.type === 'app.ready')).toBe(true)
    store.dispose()
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
          clientHolder.current?.emit(
            controlEvent('queue.updated', { sessionId, items: [queueItem], asOfSequence: 50 }, 50),
          )
          clientHolder.current?.emit(
            controlEvent('queue.updated', { sessionId, items: [], asOfSequence: 49 }, 55),
          )
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

  it('keeps an approval that arrives during the open instead of clearing it on first paint', async () => {
    const sessionId = activeSession.id
    const permission = {
      id: 'permission-during-open',
      sessionId,
      title: 'Allow the command?',
      description: 'The command needs approval.',
      risk: 'medium' as const,
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' as const }],
    }
    let resolveOpen: ((value: unknown) => void) | undefined
    const openResponse = new Promise<unknown>((resolve) => {
      resolveOpen = resolve
    })
    const { store, client } = makeStore({ openResponse })
    const opening = store.openSession(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The pinned Host subscribes first and then replays the pending approval.
    // Both arrive before the critical open response installs first paint.
    client.emit(hostEvent(1, 'session.subscribed', { sessionId, lastSequence: 0 }))
    client.emit(hostEvent(2, 'permission.requested', { request: permission }))
    resolveOpen?.({
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

    expect(store.permissions).toEqual([permission])
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
})
