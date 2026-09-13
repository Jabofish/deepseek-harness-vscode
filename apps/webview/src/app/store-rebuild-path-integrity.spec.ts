// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const PARENT = 'session-rebuild-parent'
const CHILD = 'session-rebuild-child'

function sessionView(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: 'workspace-rebuild',
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

function subagentEntry(id: string): {
  readonly kind: 'child'
  readonly id: string
  readonly activity: 'inactive'
  readonly parentSessionId: string
  readonly mode: 'continuable'
  readonly hasChildren: false
} {
  return {
    kind: 'child',
    id,
    activity: 'inactive',
    parentSessionId: PARENT,
    mode: 'continuable',
    hasChildren: false,
  }
}

class RebuildClient {
  public readonly requests: WebviewRequest[] = []
  public readonly history = new Map<string, unknown[]>()
  public readonly historyHasMore = new Set<string>()
  public readonly olderPages = new Map<string, unknown>()
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
        const hasMore = this.historyHasMore.has(sessionId)
        return {
          ...sessionView(sessionId),
          history: this.history.get(sessionId) ?? [],
          historyHasMore: hasMore,
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
        return { items: [sessionView(PARENT), sessionView(CHILD)] }
      case 'session.history':
        return (
          this.olderPages.get(
            (request.payload as { readonly sessionId?: string } | undefined)?.sessionId ?? '',
          ) ?? { events: [], hasMore: false }
        )
      case 'subagent.history':
        return { events: [], hasMore: false }
      case 'subagent.list':
        return { entries: [subagentEntry(CHILD)], parentAvailable: true }
      case 'session.queue.list':
      case 'goal.list':
      case 'job.list':
      case 'feedback.list':
      case 'command.list':
      case 'models.session.list':
        return []
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

function settle(milliseconds = 30): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function open(): {
  readonly client: RebuildClient
  readonly store: ReturnType<typeof createAppStore>
} {
  const client = new RebuildClient()
  return { client, store: createAppStore(client as unknown as ProtocolClient) }
}

const nodeIds = (store: ReturnType<typeof createAppStore>): readonly string[] =>
  store.getState().timeline.nodes.map((node) => node.id)

describe('AppStore rebuild path integrity', () => {
  it('keeps a host-only row when a subagent session is re-entered', async () => {
    const { client, store } = open()
    await store.openSession(PARENT)
    await store.openSubagent(subagentEntry(CHILD), true)
    client.emit(hostOnlyNotice(CHILD, 21, 'The child run failed.'))
    await settle()
    expect(nodeIds(store)).toEqual(['notice:21'])

    await store.openSession(PARENT)
    await settle()
    await store.openSubagent(subagentEntry(CHILD), true)
    await settle()

    // Opening a child rebuilds from `subagent.history`, and DSH never replays
    // a host-only row, so the same restore step the parent open performs has
    // to run here too.
    expect(nodeIds(store)).toEqual(['notice:21'])
    store.dispose()
  })

  it('keeps an unhealed gap warning when a subagent session is re-entered', async () => {
    const { client, store } = open()
    await store.openSession(PARENT)
    await store.openSubagent(subagentEntry(CHILD), true)
    client.emit(event(1, 'session.gap', { sessionId: CHILD, fromSequence: 40, toSequence: 50 }))
    await settle()

    const gapId = `gap:${CHILD}:40:50`
    expect(nodeIds(store)).toContain(gapId)

    await store.openSession(PARENT)
    await settle()
    await store.openSubagent(subagentEntry(CHILD), true)
    await settle()

    expect(nodeIds(store)).toContain(gapId)
    store.dispose()
  })

  it('keeps a host-only row when an older history page is merged in', async () => {
    const { client, store } = open()
    client.history.set(
      PARENT,
      [5, 6, 7, 8].map((sequence) => userHistoryEntry(PARENT, sequence)),
    )
    client.historyHasMore.add(PARENT)
    await store.openSession(PARENT)
    client.emit(hostOnlyNotice(PARENT, 22, 'The provider rejected the request.'))
    await settle()
    expect(nodeIds(store)).toEqual([
      `user-${PARENT}-5`,
      `user-${PARENT}-6`,
      `user-${PARENT}-7`,
      `user-${PARENT}-8`,
      'notice:22',
    ])

    client.olderPages.set(PARENT, {
      events: [1, 2, 3, 4].map((sequence) => userHistoryEntry(PARENT, sequence)),
      hasMore: true,
      beforeSeq: 1,
    })
    await store.loadOlderHistory()
    await settle()

    // Paging in older rows rehydrates from the merged ledger; the host-only
    // row that arrived after row 8 has to stay at its place behind row 8.
    expect(nodeIds(store)).toEqual([
      `user-${PARENT}-1`,
      `user-${PARENT}-2`,
      `user-${PARENT}-3`,
      `user-${PARENT}-4`,
      `user-${PARENT}-5`,
      `user-${PARENT}-6`,
      `user-${PARENT}-7`,
      `user-${PARENT}-8`,
      'notice:22',
    ])
    store.dispose()
  })

  it('keeps an unhealed gap warning when an older history page is merged in', async () => {
    const { client, store } = open()
    client.history.set(
      PARENT,
      [5, 6, 7, 8].map((sequence) => userHistoryEntry(PARENT, sequence)),
    )
    client.historyHasMore.add(PARENT)
    await store.openSession(PARENT)
    client.emit(event(1, 'session.gap', { sessionId: PARENT, fromSequence: 40, toSequence: 50 }))
    await settle()

    const gapId = `gap:${PARENT}:40:50`
    expect(nodeIds(store)).toContain(gapId)

    client.olderPages.set(PARENT, {
      events: [1, 2, 3, 4].map((sequence) => userHistoryEntry(PARENT, sequence)),
      hasMore: true,
      beforeSeq: 1,
    })
    await store.loadOlderHistory()
    await settle()

    expect(nodeIds(store)).toContain(gapId)
    store.dispose()
  })
})
