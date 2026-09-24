// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const activeSession = {
  id: 'session-active',
  workspaceId: 'workspace-1',
  title: 'Reconnect epoch conversation',
  blank: false,
  status: 'running',
  createdAt: '2026-08-31T08:00:00.000Z',
  updatedAt: '2026-08-31T08:05:00.000Z',
} as const

const queueItem = {
  id: 'queued-1',
  sessionId: activeSession.id,
  text: 'queued while the old process was alive',
  attachments: [],
  textOnly: true,
  mode: 'queue',
  createdAt: '2026-08-31T08:00:00.000Z',
} as const

const nextQueueItem = {
  ...queueItem,
  id: 'queued-2',
  text: 'second queued input',
} as const

const permission = {
  id: 'approval-1',
  sessionId: activeSession.id,
  title: 'Allow the tool?',
  description: 'The tool needs approval.',
  risk: 'medium',
  options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
} as const

const childEntry = {
  kind: 'child',
  id: 'session-child',
  label: 'Explore the store',
  activity: 'running',
  parentSessionId: activeSession.id,
  mode: 'continuable',
  hasChildren: false,
} as const

const PROBE_IMAGE = {
  attachmentId: 'image-probe',
  mediaType: 'image/png',
  bytes: 71,
  width: 2,
  height: 1,
  name: 'probe.png',
} as const

function userMessageHistoryEntry(sequence: number, images?: readonly (typeof PROBE_IMAGE)[]): unknown {
  return {
    sequence,
    time: '2026-08-31T08:00:00.000Z',
    event: {
      type: 'message.user',
      sessionId: activeSession.id,
      messageId: `message-${sequence}`,
      markdown: `message ${sequence}`,
      ...(images === undefined ? {} : { images }),
    },
  }
}

function childHistoryEntry(sequence: number): unknown {
  return {
    sequence,
    time: '2026-08-31T08:00:00.000Z',
    event: {
      type: 'message.user',
      sessionId: childEntry.id,
      messageId: `child-message-${sequence}`,
      markdown: `child message ${sequence}`,
    },
  }
}

function hostEvent(hostSequence: number, name: string, payload: unknown): HostMessage {
  return { type: 'event', sequence: hostSequence, name, payload } as unknown as HostMessage
}

/** The exact snapshot sequence an extension-initiated reconnect publishes. */
function connectionSnapshot(hostSequence: number, kind: string, payload: object = {}): HostMessage {
  return hostEvent(hostSequence, 'connection.snapshot', { kind, ...payload })
}

type Respond = (request: WebviewRequest) => unknown

class FakeClient {
  public readonly requests: WebviewRequest[] = []
  /** Requests the host answered with an error, in order. */
  public readonly failures: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly respond: Respond) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    let value: unknown
    try {
      value = this.respond(request)
    } catch (reason) {
      this.failures.push(request)
      return Promise.reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
    return Promise.resolve(value as T).catch((reason: unknown) => {
      this.failures.push(request)
      throw reason
    })
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
    case 'runtime.update.check':
      return {
        status: 'ready',
        availableVersions: [],
        updateAvailable: false,
        checkedAt: '2026-08-31T00:00:00.000Z',
      }
    case 'session.list':
      return { items: [activeSession] }
    case 'workspace.list':
      return { items: [] }
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
      return undefined
  }
}

function sessionOpenResponse(withImage: boolean): unknown {
  return {
    ...activeSession,
    history: [1, 2, 3, 4, 5].map((sequence) =>
      userMessageHistoryEntry(sequence, withImage && sequence === 1 ? [PROBE_IMAGE] : undefined),
    ),
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

function makeStore(withImage = false): {
  store: ReturnType<typeof createAppStore>
  client: FakeClient
} {
  const respond: Respond = (request) => {
    if (request.type === 'session.open') return sessionOpenResponse(withImage)
    return baseResponse(request)
  }
  const client = new FakeClient(respond)
  return { store: createAppStore(client as unknown as ProtocolClient), client }
}

/**
 * Models the per-process routing table of the DSH adapter: a child transcript
 * can only be read after its parent catalog was read on *this* connection, and
 * a replacement process starts with an empty table.
 */
function makeSubagentStore(): {
  store: ReturnType<typeof createAppStore>
  client: FakeClient
  replacementProcess: () => void
} {
  let routedParents = new Set<string>()
  const respond: Respond = (request) => {
    if (request.type === 'session.open') return sessionOpenResponse(false)
    if (request.type === 'subagent.list') {
      const parentSessionId = (request.payload as { sessionId?: unknown }).sessionId
      if (typeof parentSessionId === 'string') routedParents.add(parentSessionId)
      return {
        entries: parentSessionId === activeSession.id ? [childEntry] : [],
        parentAvailable: true,
      }
    }
    if (request.type === 'subagent.history') {
      const sessionId = (request.payload as { sessionId?: unknown }).sessionId
      if (sessionId === childEntry.id && !routedParents.has(childEntry.parentSessionId))
        throw new Error('This DSH host does not expose subagent history without a current catalog entry.')
      return { events: [1, 2].map((sequence) => childHistoryEntry(sequence)), hasMore: false }
    }
    return baseResponse(request)
  }
  const client = new FakeClient(respond)
  return {
    store: createAppStore(client as unknown as ProtocolClient),
    client,
    replacementProcess: () => {
      routedParents = new Set<string>()
    },
  }
}

function makeRejectingStore(rejections: { count: number }): {
  store: ReturnType<typeof createAppStore>
  client: FakeClient
} {
  const respond: Respond = (request) => {
    if (request.type === 'session.open') {
      if (rejections.count > 0) {
        rejections.count -= 1
        // The exact shape `requireCurrentWorkspaceSession` publishes when the
        // replacement process has not committed its workspace projection yet.
        const reason = Object.assign(
          new Error('The requested session is not part of the current VS Code workspace.'),
          { retryable: false },
        )
        throw reason
      }
      return sessionOpenResponse(false)
    }
    return baseResponse(request)
  }
  const client = new FakeClient(respond)
  return { store: createAppStore(client as unknown as ProtocolClient), client }
}

const sessionOpens = (client: FakeClient): WebviewRequest[] =>
  client.requests.filter((request) => request.type === 'session.open')

const userMessageNodes = (state: {
  readonly timeline: { readonly nodes: readonly { readonly kind: string }[] }
}): readonly { readonly kind: string }[] =>
  state.timeline.nodes.filter((node) => node.kind === 'user-message')

const firstUserImage = (state: {
  readonly timeline: {
    readonly nodes: readonly {
      readonly kind: string
      readonly images?: readonly { readonly attachmentId: string }[]
    }[]
  }
}): { readonly attachmentId: string } | undefined =>
  state.timeline.nodes.find((node) => node.kind === 'user-message')?.images?.[0]

const flushAsync = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('AppStore connection restart', () => {
  afterEach(() => document.body.replaceChildren())

  it('reopens the session and drops process-local surfaces when the connection restarts', async () => {
    const { store, client } = makeStore()
    client.emit(connectionSnapshot(1, 'connected', { dshVersion: '0.1.0' }))
    await store.openSession(activeSession.id)
    await flushAsync()
    expect(userMessageNodes(store.getState())).toHaveLength(5)

    // Process-local state of the first DSH process: the queue and a pending
    // approval exist only inside that process and are never replayed by a
    // replacement one.
    client.emit(hostEvent(2, 'queue.updated', { sessionId: activeSession.id, items: [queueItem] }))
    client.emit(hostEvent(3, 'permission.requested', { request: permission }))
    await flushAsync()
    expect(store.queue).toHaveLength(1)
    expect(store.permissions).toHaveLength(1)
    expect(sessionOpens(client)).toHaveLength(1)

    // The extension restarts the connection: stopping/idle precede the new
    // connected epoch and no connection.lost event is published.
    client.emit(connectionSnapshot(4, 'stopping'))
    client.emit(connectionSnapshot(5, 'idle'))
    client.emit(connectionSnapshot(6, 'connected', { dshVersion: '0.1.0' }))
    await flushAsync()

    expect(store.queue).toEqual([])
    expect(store.permissions).toEqual([])
    expect(sessionOpens(client)).toHaveLength(2)
    // The conversation itself is durable, so it survives the replacement.
    expect(userMessageNodes(store.getState())).toHaveLength(5)
    store.dispose()
    client.dispose()
  })

  it('republishes a reopened row with fresh image references', async () => {
    const { store, client } = makeStore(true)
    client.emit(connectionSnapshot(1, 'connected', { dshVersion: '0.1.0' }))
    await store.openSession(activeSession.id)
    await flushAsync()
    const before = firstUserImage(store.getState())
    expect(before?.attachmentId).toBe(PROBE_IMAGE.attachmentId)

    // The thumbnail loader latches a failed read for the life of its mount, so
    // the reopen is what lets a dropped image read be retried: the republished
    // row must carry a new reference object, not the same one the memo would
    // skip over.
    client.emit(connectionSnapshot(2, 'stopping'))
    client.emit(connectionSnapshot(3, 'idle'))
    client.emit(connectionSnapshot(4, 'connected', { dshVersion: '0.1.0' }))
    await flushAsync()

    expect(sessionOpens(client)).toHaveLength(2)
    const after = firstUserImage(store.getState())
    expect(after?.attachmentId).toBe(PROBE_IMAGE.attachmentId)
    expect(after).not.toBe(before)
    store.dispose()
    client.dispose()
  })

  it('leaves the open session and its surfaces alone while the connection stays connected', async () => {
    const { store, client } = makeStore()
    client.emit(
      connectionSnapshot(1, 'connected', {
        dshVersion: '0.1.0',
        backendInstanceId: 'backend-1',
        connectionGeneration: 1,
      }),
    )
    await store.openSession(activeSession.id)
    await flushAsync()
    client.emit(
      hostEvent(2, 'queue.updated', {
        sessionId: activeSession.id,
        items: [queueItem, nextQueueItem],
        asOfSequence: 6,
      }),
    )
    await flushAsync()

    // A cached-backend fast path republishes the same epoch; nothing was
    // replaced, so neither the surface nor its watermark may be reset.
    client.emit(
      connectionSnapshot(3, 'connected', {
        dshVersion: '0.1.0',
        backendInstanceId: 'backend-1',
        connectionGeneration: 1,
      }),
    )
    client.emit(
      hostEvent(4, 'queue.updated', {
        sessionId: activeSession.id,
        items: [queueItem],
        asOfSequence: 5,
      }),
    )
    await flushAsync()

    expect(sessionOpens(client)).toHaveLength(1)
    expect(store.queue.map((item) => item.id)).toEqual(['queued-1', 'queued-2'])
    expect(userMessageNodes(store.getState())).toHaveLength(5)
    store.dispose()
    client.dispose()
  })

  it('resets the queue watermark when the backend identity changes', async () => {
    const { store, client } = makeStore()
    client.emit(
      connectionSnapshot(1, 'connected', {
        dshVersion: '0.1.0',
        backendInstanceId: 'backend-old',
        connectionGeneration: 7,
      }),
    )
    await store.openSession(activeSession.id)
    await flushAsync()
    client.emit(
      hostEvent(2, 'queue.updated', {
        sessionId: activeSession.id,
        items: [queueItem, nextQueueItem],
        asOfSequence: 6,
      }),
    )
    await flushAsync()

    // The connection coordinator can publish the replacement identity in a
    // connected snapshot even if an intermediate state event was missed.
    client.emit(
      connectionSnapshot(3, 'connected', {
        dshVersion: '0.1.0',
        backendInstanceId: 'backend-new',
        connectionGeneration: 8,
      }),
    )
    await flushAsync()
    client.emit(
      hostEvent(4, 'queue.updated', {
        sessionId: activeSession.id,
        items: [{ ...queueItem, id: 'queued-new', text: 'new process queue' }],
        asOfSequence: 0,
      }),
    )
    await flushAsync()

    expect(store.queue.map((item) => item.id)).toEqual(['queued-new'])
    store.dispose()
    client.dispose()
  })

  it('does not let an older control queue replace a newer follow snapshot', async () => {
    const { store, client } = makeStore()
    client.emit(
      connectionSnapshot(1, 'connected', {
        dshVersion: '0.1.0',
        backendInstanceId: 'backend-1',
        connectionGeneration: 1,
      }),
    )
    await store.openSession(activeSession.id)
    await flushAsync()
    client.emit(
      hostEvent(2, 'queue.updated', {
        sessionId: activeSession.id,
        items: [queueItem, nextQueueItem],
        asOfSequence: 6,
      }),
    )
    client.emit(
      hostEvent(3, 'queue.updated', {
        sessionId: activeSession.id,
        items: [queueItem],
        asOfSequence: 6,
      }),
    )
    client.emit(
      hostEvent(4, 'queue.updated', {
        sessionId: activeSession.id,
        items: [queueItem],
        asOfSequence: 5,
      }),
    )
    await flushAsync()

    expect(store.queue.map((item) => item.id)).toEqual(['queued-1', 'queued-2'])
    store.dispose()
    client.dispose()
  })

  it('keeps the transcript while a replacement connection is still being established', async () => {
    const { store, client } = makeStore()
    client.emit(connectionSnapshot(1, 'connected', { dshVersion: '0.1.0' }))
    await store.openSession(activeSession.id)
    await flushAsync()

    client.emit(connectionSnapshot(2, 'stopping'))
    client.emit(connectionSnapshot(3, 'idle'))
    client.emit(connectionSnapshot(4, 'connecting'))
    await flushAsync()

    expect(sessionOpens(client)).toHaveLength(1)
    expect(userMessageNodes(store.getState())).toHaveLength(5)
    store.dispose()
    client.dispose()
  })

  it('re-registers the child transcript routing on the replacement connection', async () => {
    const { store, client, replacementProcess } = makeSubagentStore()
    client.emit(connectionSnapshot(1, 'connected', { dshVersion: '0.1.0' }))
    await store.openSession(activeSession.id)
    await flushAsync()
    await store.openSubagent(childEntry, true)
    await flushAsync()
    expect(store.getState().activeSubagent?.entry.id).toBe(childEntry.id)
    expect(store.getState().activeSubagent?.parentAvailable).toBe(true)
    const failuresBefore = client.failures.length

    // The user is reading a child transcript when the process is replaced. The
    // child→parent routing lives in the connection's catalog, so the child
    // history read only resolves when the parent catalog is read again here.
    replacementProcess()
    client.emit(connectionSnapshot(2, 'stopping'))
    client.emit(connectionSnapshot(3, 'idle'))
    client.emit(connectionSnapshot(4, 'connected', { dshVersion: '0.1.0' }))
    await flushAsync()

    expect(client.failures).toEqual([])
    expect(client.failures.length).toBe(failuresBefore)
    expect(store.getState().activeSubagent?.entry.id).toBe(childEntry.id)
    // A replacement connection may not claim the parent is gone: the follow-up
    // composer refuses to send from a transcript whose parent is unavailable.
    expect(store.getState().activeSubagent?.parentAvailable).toBe(true)
    store.dispose()
    client.dispose()
  })

  it('retries the re-open when the replacement connection rejects it as not yet owned', async () => {
    const rejections = { count: 0 }
    const { store, client } = makeRejectingStore(rejections)
    client.emit(connectionSnapshot(1, 'connected', { dshVersion: '0.1.0' }))
    await store.openSession(activeSession.id)
    await flushAsync()
    expect(sessionOpens(client)).toHaveLength(1)

    // `connected` is published before the replacement process commits its
    // workspace projection, so the ownership check answers with a definitive
    // `retryable: false` rejection that the open request itself never retries.
    // Without a retry the conversation stays frozen behind a healthy
    // connection.
    rejections.count = 2
    client.emit(connectionSnapshot(2, 'stopping'))
    client.emit(connectionSnapshot(3, 'idle'))
    client.emit(connectionSnapshot(4, 'connected', { dshVersion: '0.1.0' }))
    await waitFor(() => sessionOpens(client).length >= 4)

    expect(sessionOpens(client).length).toBeGreaterThanOrEqual(4)
    expect(client.failures.filter((request) => request.type === 'session.open')).toHaveLength(2)
    expect(store.activeSessionId).toBe(activeSession.id)
    expect(userMessageNodes(store.getState())).toHaveLength(5)
    store.dispose()
    client.dispose()
  })
})
