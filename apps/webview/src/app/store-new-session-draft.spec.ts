// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const configuration = {
  preset: 'standard',
  toolMode: 'native',
  permissionPreset: 'workspace-write',
  planMode: false,
  model: { providerId: '', modelId: '' },
}

function session(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: 'w1',
    title: id,
    blank: true,
    status: 'idle',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    history: [],
    configuration,
  }
}

function fixture(failFirstOpen = false): {
  store: ReturnType<typeof createAppStore>
  requests: WebviewRequest[]
} {
  const requests: WebviewRequest[] = []
  let created = false
  let openFailures = failFirstOpen ? 1 : 0
  const client = {
    subscribe: () => () => {},
    dispose: () => {},
    request: async (request: WebviewRequest) => {
      await Promise.resolve()
      requests.push(request)
      if (request.type === 'workspace.list')
        return {
          items: [
            {
              id: 'w1',
              name: 'Workspace',
              sessionIds: created ? ['created'] : [],
              sessionCount: created ? 1 : 0,
              createdAt: '2026-09-01T00:00:00.000Z',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          archivedSessionIds: [],
        }
      if (request.type === 'session.list') return { items: created ? [session('created')] : [] }
      if (request.type === 'session.create') {
        created = true
        return { id: 'created' }
      }
      if (request.type === 'session.open') {
        if (openFailures > 0) {
          openFailures -= 1
          throw new Error('Open failed')
        }
        return session('created')
      }
      if (request.type === 'subagent.list') return { entries: [], parentAvailable: true }
      if (request.type === 'models.session.list') return { models: [], failures: [], routable: true }
      return []
    },
  }
  const store = createAppStore(client as unknown as ProtocolClient)
  return { store, requests }
}

describe('New Session draft', () => {
  it('keeps New local until the first ordinary message is submitted', async () => {
    const { store, requests } = fixture()
    try {
      await store.refreshSessions()
      const before = requests.length
      await store.stageSession('w1')
      expect(requests).toHaveLength(before)
      expect(store.getState().pendingSession?.workspaceId).toBe('w1')
      expect(store.activeSessionId).toBeUndefined()

      await store.sendPendingPrompt('Hello', [], 'queue')
      const createIndex = requests.findIndex((request) => request.type === 'session.create')
      const sendIndex = requests.findIndex((request) => request.type === 'session.sendPrompt')
      expect(createIndex).toBeGreaterThanOrEqual(before)
      expect(sendIndex).toBeGreaterThan(createIndex)
      expect(store.activeSessionId).toBe('created')
      expect(store.getState().pendingSession).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('does not create a session for an empty draft or a command', async () => {
    const { store, requests } = fixture()
    try {
      await store.refreshSessions()
      await store.stageSession('w1')
      await expect(store.sendPendingPrompt(' ', [], 'queue')).rejects.toThrow()
      await expect(store.sendPendingPrompt('/plan', [], 'queue')).rejects.toThrow()
      expect(requests.some((request) => request.type === 'session.create')).toBe(false)
      expect(store.getState().pendingSession).toBeDefined()
    } finally {
      store.dispose()
    }
  })

  it('reuses the created ID when opening fails after the first submission', async () => {
    const { store, requests } = fixture(true)
    try {
      await store.refreshSessions()
      await store.stageSession('w1')
      await expect(store.sendPendingPrompt('Hello', [], 'queue')).rejects.toThrow('Open failed')
      expect(store.getState().pendingSession?.createdSessionId).toBe('created')
      await store.sendPendingPrompt('Hello', [], 'queue')
      expect(requests.filter((request) => request.type === 'session.create')).toHaveLength(1)
      expect(requests.filter((request) => request.type === 'session.sendPrompt')).toHaveLength(1)
    } finally {
      store.dispose()
    }
  })
})
