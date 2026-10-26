// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

const SESSION_A = 'session-switch-a'
const SESSION_B = 'session-switch-b'

function sessionView(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: 'workspace-switch',
    title: `Session ${id}`,
    blank: false,
    status: 'running',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  }
}

function userHistoryEntry(sessionId: string, sequence: number): unknown {
  return {
    sequence,
    time: '2026-09-13T00:00:00.000Z',
    event: {
      type: 'message.user',
      sessionId,
      messageId: `user-${sessionId}-${sequence}`,
      markdown: `message ${sequence}`,
    },
  }
}

class SwitchClient {
  public readonly requests: WebviewRequest[] = []
  public readonly history = new Map<string, unknown[]>()
  private readonly listeners = new Set<(message: HostMessage) => void>()

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

  private respond(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open': {
        const sessionId = (request.payload as { readonly sessionId?: string } | undefined)?.sessionId ?? ''
        return {
          ...sessionView(sessionId),
          history: this.history.get(sessionId) ?? [],
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
      case 'session.list':
        return { items: [sessionView(SESSION_A), sessionView(SESSION_B)] }
      case 'session.history':
        return { events: [], hasMore: false }
      case 'session.queue.list':
      case 'goal.list':
      case 'job.list':
      case 'feedback.list':
      case 'command.list':
      case 'models.session.list':
      case 'subagent.list':
        return request.type === 'subagent.list' ? { entries: [], parentAvailable: true } : []
      default:
        return []
    }
  }
}

function event(sequence: number, name: string, payload: unknown): HostMessage {
  return { type: 'event', sequence, name, payload }
}

function hostOnlyNotice(sessionId: string, hostSequence: number, text: string): HostMessage {
  return event(hostSequence, 'notice', { sessionId, level: 'error', text })
}

function settle(milliseconds = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function open(): { readonly client: SwitchClient; readonly store: ReturnType<typeof createAppStore> } {
  const client = new SwitchClient()
  return { client, store: createAppStore(client as unknown as ProtocolClient) }
}

const nodeIds = (store: ReturnType<typeof createAppStore>): readonly string[] =>
  store.getState().timeline.nodes.map((node) => node.id)

describe('AppStore session switch integrity', () => {
  it('keeps a host-only notice that arrived while its session was in the background', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_A)
    client.emit(hostOnlyNotice(SESSION_B, 12, 'A background job failed.'))
    await settle()

    await store.openSession(SESSION_B)
    await settle()

    expect(nodeIds(store)).toEqual(['notice:-1'])
    store.dispose()
  })

  it('restores a background row at its durable position instead of appending it', async () => {
    const { client, store } = open()
    client.history.set(
      SESSION_A,
      [1, 2, 3].map((sequence) => userHistoryEntry(SESSION_A, sequence)),
    )
    await store.openSession(SESSION_A)
    client.emit(hostOnlyNotice(SESSION_A, 14, 'The provider rejected the request.'))
    await settle()

    // The session keeps producing durable rows while another session is on
    // screen: the restored warning must stay between rows 3 and 4.
    await store.openSession(SESSION_B)
    await settle()
    client.history.set(
      SESSION_A,
      [1, 2, 3, 4, 5, 6].map((sequence) => userHistoryEntry(SESSION_A, sequence)),
    )
    await store.openSession(SESSION_A)
    await settle()

    expect(nodeIds(store)).toEqual([
      `user-${SESSION_A}-1`,
      `user-${SESSION_A}-2`,
      `user-${SESSION_A}-3`,
      'notice:-1',
      `user-${SESSION_A}-4`,
      `user-${SESSION_A}-5`,
      `user-${SESSION_A}-6`,
    ])
    store.dispose()
  })
})
