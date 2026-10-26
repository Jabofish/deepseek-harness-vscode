// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

const SESSION_ID = 'session-cursor'

class StreamClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.response(request) as T)
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

  private response(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open':
        return {
          id: SESSION_ID,
          workspaceId: 'workspace-cursor',
          title: 'Cursor fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
          history: [],
          permissionPresets: ['workspace-write'],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        }
      case 'models.session.list':
        return {
          models: [],
          failures: [],
          current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          routable: true,
        }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }
}

function event(sequence: number, name: string, payload: unknown): HostMessage {
  return { type: 'event', name, sequence, payload }
}

function settle(milliseconds = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function open(): { readonly client: StreamClient; readonly store: ReturnType<typeof createAppStore> } {
  const client = new StreamClient()
  return { client, store: createAppStore(client as unknown as ProtocolClient) }
}

describe('store durable cursor integrity', () => {
  it('does not let an uninterpreted frame spend a durable cursor slot', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_ID)

    // A newer DSH delivered a frame the pinned mapper cannot read. The adapter
    // preserves it together with its durable cursor so the raw row can stay
    // ordered (packages/dsh-adapter/src/stream-controller.ts).
    client.emit(
      event(1, 'unknown', {
        type: 'unknown',
        name: 'future/new-frame',
        sessionId: SESSION_ID,
        payload: { opaque: true },
        sequence: 41,
      }),
    )
    await settle()

    // DSH legitimately carries more than one row in one durable slot
    // (projections, replay races), so the cursor must not be spent by a row
    // the client cannot render.
    client.emit(
      event(2, 'message.user', {
        sessionId: SESSION_ID,
        messageId: 'user-41',
        markdown: 'durable row sharing the slot',
        source: 'user',
        sequence: 41,
      }),
    )
    await settle()

    expect(
      store.timeline.nodes.filter((node) => node.kind === 'user-message').map((node) => node.id),
    ).toEqual(['user-41'])
    expect(store.timeline.lastSequence).toBe(41)
    store.dispose()
  })

  it('keeps a live streaming answer when the ledger is rebuilt below the cursor', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_ID)

    client.emit(
      event(1, 'message.user', {
        sessionId: SESSION_ID,
        messageId: 'user-1',
        markdown: 'write the answer',
        source: 'user',
        sequence: 1,
      }),
    )
    client.emit(event(2, 'turn.started', { sessionId: SESSION_ID, turn: 1, sequence: 2 }))
    client.emit(event(3, 'step.started', { sessionId: SESSION_ID, turn: 1, step: 1, sequence: 3 }))
    client.emit(
      event(4, 'message.delta', {
        sessionId: SESSION_ID,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'partial ',
        transientSequence: 1,
        transientAttemptId: 'attempt-1',
        transientIndex: 0,
      }),
    )
    client.emit(
      event(5, 'message.delta', {
        sessionId: SESSION_ID,
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'answer',
        transientSequence: 2,
        transientAttemptId: 'attempt-1',
        transientIndex: 1,
      }),
    )
    await settle()

    // History recovery redelivers a durable row below the timeline cursor: it
    // is absorbed by the ledger gate and republishes the rebuilt projection.
    client.emit(
      event(6, 'message.user', {
        sessionId: SESSION_ID,
        messageId: 'user-1',
        markdown: 'write the answer',
        source: 'user',
        sequence: 1,
      }),
    )
    await settle(60)

    expect(store.timeline.nodes.map((node) => node.id)).toEqual(['user-1', 'assistant:1:1'])
    expect(store.timeline.nodes[1]).toMatchObject({
      kind: 'assistant-message',
      markdown: 'partial answer',
      streaming: true,
    })
    store.dispose()
  })

  it('does not let a host-only notice spend a durable cursor slot', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_ID)

    client.emit(
      event(1, 'message.user', {
        sessionId: SESSION_ID,
        messageId: 'user-1',
        markdown: 'before the notice',
        source: 'user',
        sequence: 11,
      }),
    )
    // A command notice is a host-only row: no durable DSH sequence, only the
    // Host publication counter. Its envelope sequence (40) is far ahead of the
    // durable cursor (11).
    client.emit(
      event(40, 'notice', {
        sessionId: SESSION_ID,
        level: 'info',
        text: '压缩已完成。',
        commandName: 'compact',
        commandId: 'command-1',
        commandPhase: 'done',
        commandInput: '/compact',
      }),
    )
    await settle(40)
    expect(store.timeline.nodes.some((node) => node.id === 'notice:-1')).toBe(true)
    expect(store.timeline.lastSequence).toBe(11)

    client.emit(
      event(41, 'tool.updated', {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-after-notice',
          name: 'read',
          category: 'read',
          title: 'Read',
          status: 'completed',
          turn: 1,
          step: 1,
          metadata: {},
        },
        sequence: 12,
      }),
    )
    await settle(60)

    expect(store.timeline.nodes.some((node) => node.id === 'call-after-notice')).toBe(true)
    expect(store.timeline.lastSequence).toBe(12)
    store.dispose()
  })
})
