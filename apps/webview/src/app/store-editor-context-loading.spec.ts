// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type {
  FeatureHostEvent,
  FeatureRequest,
  HostMessage,
  WebviewRequest,
} from '@dsh-vscode/webview-protocol'
import type { SubagentView } from '@dsh-vscode/domain'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_A = 'editor-context-a'
const SESSION_B = 'editor-context-b'

function sessionView(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: 'workspace-editor-context',
    title: `Session ${id}`,
    blank: false,
    status: 'running',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  }
}

function child(): SubagentView {
  return {
    kind: 'child',
    id: 'editor-context-child',
    label: 'worker',
    activity: 'running',
    parentSessionId: SESSION_A,
    mode: 'continuable',
    hasChildren: false,
  }
}

function hang(): Promise<never> {
  return new Promise<never>(() => undefined)
}

class RailClient {
  /** A slow advisory endpoint keeps the post-open merge from ever running. */
  public hangQueueList = false
  public hangContextList = false
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private readonly featureListeners = new Set<(message: FeatureHostEvent) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    if (request.type === 'session.queue.list' && this.hangQueueList) return hang()
    return Promise.resolve(this.answer(request) as T)
  }

  public featureRequest<T>(request: FeatureRequest): Promise<T> {
    if (request.type === 'editor.context.list') {
      if (this.hangContextList) return hang()
      return Promise.resolve({ kind: 'editor.context', items: [], availableKinds: [] } as T)
    }
    return Promise.resolve({ kind: 'ok' } as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public subscribeFeature(listener: (message: FeatureHostEvent) => void): () => void {
    this.featureListeners.add(listener)
    return () => this.featureListeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
    this.featureListeners.clear()
  }

  private answer(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open': {
        const sessionId = (request.payload as { readonly sessionId?: string } | undefined)?.sessionId ?? ''
        return { ...sessionView(sessionId), history: [], historyHasMore: false, permissionPresets: [] }
      }
      case 'session.list':
        return { items: [sessionView(SESSION_A), sessionView(SESSION_B)] }
      case 'session.history':
        return { events: [], hasMore: false }
      case 'subagent.history':
        return { events: [], hasMore: false }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }
}

function settle(milliseconds = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function open(): { readonly client: RailClient; readonly store: ReturnType<typeof createAppStore> } {
  const client = new RailClient()
  return { client, store: createAppStore(client as unknown as ProtocolClient) }
}

describe('AppStore editor-context loading flag', () => {
  it('stops the rail spinner when the session is switched mid-refresh', async () => {
    const { client, store } = open()
    client.hangQueueList = true
    await store.openSession(SESSION_A)
    await settle()

    client.hangContextList = true
    void store.refreshEditorContext()
    await settle()
    expect(store.getState().editorContextLoading).toBe(true)

    await store.openSession(SESSION_B)
    await settle()

    // The in-flight refresh belongs to the previous view of the rail; the
    // reset that supersedes it has to release the spinner, or the composer
    // shows a loading affordance that no request can ever clear.
    expect(store.getState().editorContextLoading).toBe(false)
    store.dispose()
  })

  it('stops the rail spinner when a subagent transcript is entered mid-refresh', async () => {
    const { client, store } = open()
    client.hangQueueList = true
    await store.openSession(SESSION_A)
    await settle()

    client.hangContextList = true
    void store.refreshEditorContext()
    await settle()
    expect(store.getState().editorContextLoading).toBe(true)

    // The advisory merge never settles here, so the entry itself must not wait
    // on it; first paint is enough to judge the rail state.
    void store.openSubagent(child(), true)
    await settle(50)

    expect(store.getState().activeSubagent?.entry.id).toBe('editor-context-child')
    expect(store.getState().editorContextLoading).toBe(false)
    store.dispose()
  })
})
