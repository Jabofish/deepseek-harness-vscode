// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION = 'session-rename'

function sessionSummary(title: string): Record<string, unknown> {
  return {
    id: SESSION,
    workspaceId: 'workspace-rename',
    title,
    blank: false,
    status: 'completed',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  }
}

/** Answers `session.list` and returns whatever receipt the test configures. */
class RenameClient {
  public renamePayload: { readonly sessionId: string; readonly title: string } | undefined
  public receipt: unknown
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    if (request.type === 'session.list')
      return Promise.resolve({ items: [sessionSummary('Original title')] } as T)
    if (request.type === 'session.rename') {
      this.renamePayload = request.payload
      return Promise.resolve(this.receipt as T)
    }
    return Promise.resolve(undefined as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }
}

function open(): { readonly client: RenameClient; readonly store: ReturnType<typeof createAppStore> } {
  const client = new RenameClient()
  return { client, store: createAppStore(client as unknown as ProtocolClient) }
}

const titleOf = (store: ReturnType<typeof createAppStore>): string | undefined =>
  store.getState().sessions.find((session) => session.id === SESSION)?.title

describe('AppStore session rename', () => {
  it('shows the title the host accepted instead of the typed text', async () => {
    const { client, store } = open()
    await store.refreshSessions()
    expect(titleOf(store)).toBe('Original title')

    // The host strips ANSI and control characters, collapses whitespace and
    // truncates to its own byte budget, then returns what it stored. A row that
    // keeps showing the requested text claims a title the session log does not
    // hold until the next refresh replaces it.
    client.receipt = { title: 'Hello World', seq: 12 }
    await store.renameSession(SESSION, '  Hello\n\nWorld  ')

    expect(titleOf(store)).toBe('Hello World')
    // The raw text still travels to the host: normalization belongs there, and
    // the client must not guess a second rendition of the same rule.
    expect(client.renamePayload).toEqual({ sessionId: SESSION, title: '  Hello\n\nWorld  ' })
    store.dispose()
  })

  it('falls back to the trimmed request when the host sends no receipt', async () => {
    const { client, store } = open()
    await store.refreshSessions()

    // An older extension build answers a rename without a payload; the row
    // still has to leave the rename dialog with the requested title.
    client.receipt = undefined
    await store.renameSession(SESSION, '  Typed title  ')

    expect(titleOf(store)).toBe('Typed title')
    store.dispose()
  })

  it('ignores an empty accepted title rather than blanking the row', async () => {
    const { client, store } = open()
    await store.refreshSessions()

    client.receipt = { title: '   ', seq: 13 }
    await store.renameSession(SESSION, 'Typed title')

    expect(titleOf(store)).toBe('Typed title')
    store.dispose()
  })
})
