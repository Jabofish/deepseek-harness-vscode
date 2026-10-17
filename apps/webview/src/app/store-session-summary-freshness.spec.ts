// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { SessionDetail, SessionSummary } from '@dsh-vscode/domain'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

const SESSION = 'fresh-summary'
const CREATED = 1_700_000_000_000
const PROMPT = CREATED + 60_000

const listed: SessionSummary = {
  id: SESSION,
  workspaceId: 'workspace-1',
  title: 'Old title',
  blank: true,
  status: 'running',
  createdAt: new Date(CREATED).toISOString(),
  updatedAt: new Date(CREATED).toISOString(),
}
const opened: SessionDetail = {
  ...listed,
  title: 'Accepted title',
  blank: false,
  status: 'idle',
  updatedAt: new Date(PROMPT).toISOString(),
  agentPreset: 'review',
  history: [],
  historyHasMore: false,
  configuration: {
    preset: 'review',
    toolMode: 'native',
    permissionPreset: 'workspace-write',
    planMode: false,
    model: { providerId: '', modelId: '' },
  },
}

// UI boundary regression: a structured event is actually delivered to the
// store before the refreshed detail arrives. Adapter races are tested at the
// repository boundary; neither suite substitutes for an Extension Host replay.
class SummaryClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    switch (request.type) {
      case 'session.list':
        return Promise.resolve({ items: [listed] } as T)
      case 'session.open':
        return Promise.resolve(opened as T)
      case 'subagent.list':
        return Promise.resolve({ entries: [], parentAvailable: true } as T)
      default:
        return Promise.resolve([] as T)
    }
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  public idle(): void {
    const payload = { type: 'session.status', sessionId: SESSION, status: 'idle' } as const
    for (const listener of this.listeners)
      listener({ type: 'event', sequence: 1, name: payload.type, payload })
  }
}

describe('Reopened session summaries in the Webview store', () => {
  it('keeps a received idle status and refreshed durable fields across repeated opens', async () => {
    const client = new SummaryClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.refreshSessions()
      expect(store.getState().sessions[0]?.status).toBe('running')
      client.idle()
      expect(store.getState().sessions[0]?.status).toBe('idle')
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await store.openSession(SESSION)
        expect(store.getState().sessions[0]).toMatchObject({
          title: 'Accepted title',
          blank: false,
          status: 'idle',
          updatedAt: new Date(PROMPT).toISOString(),
          agentPreset: 'review',
        })
        expect(store.getState().configuration?.preset).toBe('review')
      }
    } finally {
      store.dispose()
    }
  })
})
