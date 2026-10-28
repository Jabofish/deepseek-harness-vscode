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

const permission = {
  id: 'approval-1',
  sessionId: activeSession.id,
  title: 'Allow the tool?',
  description: 'The tool needs approval.',
  risk: 'medium',
  options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
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

const sessionOpens = (client: FakeClient): WebviewRequest[] =>
  client.requests.filter((request) => request.type === 'session.open')

const userMessageNodes = (state: {
  readonly timeline: { readonly nodes: readonly { readonly kind: string }[] }
}): readonly { readonly kind: string }[] =>
  state.timeline.nodes.filter((node) => node.kind === 'user-message')

const flushAsync = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 60))
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
})
