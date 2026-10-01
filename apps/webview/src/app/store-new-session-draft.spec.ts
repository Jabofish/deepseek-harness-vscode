// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
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

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
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

  it.each(['create', 'refresh', 'open'] as const)(
    'rejects a pending send superseded during %s as cancelled instead of resolving as delivered',
    async (phase) => {
      const gates = {
        create: deferred<unknown>(),
        refresh: deferred<unknown>(),
        open: deferred<unknown>(),
      }
      const armed = { create: false, refresh: false, open: false }
      let sessionListCalls = 0
      const requests: WebviewRequest[] = []
      let created = false
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
          if (request.type === 'session.list') {
            // The first list is the test's own startup refresh; the second is
            // the send flow's catalog refresh.
            sessionListCalls += 1
            if (sessionListCalls >= 2 && phase === 'refresh') {
              armed.refresh = true
              await gates.refresh.promise
            }
            return { items: created ? [session('created')] : [] }
          }
          if (request.type === 'session.create') {
            if (phase === 'create') {
              armed.create = true
              await gates.create.promise
            }
            created = true
            return { id: 'created' }
          }
          if (request.type === 'session.open') {
            if (request.payload.sessionId === 'created' && phase === 'open') {
              armed.open = true
              await gates.open.promise
            }
            return session(request.payload.sessionId)
          }
          if (request.type === 'subagent.list') return { entries: [], parentAvailable: true }
          if (request.type === 'models.session.list') return { models: [], failures: [], routable: true }
          return []
        },
      }
      const store = createAppStore(client as unknown as ProtocolClient)
      try {
        await store.refreshSessions()
        await store.stageSession('w1')
        const send = store.sendPendingPrompt('Hello', [], 'queue')
        await vi.waitFor(() => expect(armed[phase]).toBe(true))

        if (phase === 'create' || phase === 'refresh') {
          // A newer pending draft replaces this composition while the send is
          // still working toward delivery.
          await store.stageSession('w1')
        } else {
          // The user navigates to an existing session while the send's own
          // open is in flight, so the send's open loses the panel.
          await store.openSession('existing')
        }
        gates[phase].resolve(undefined)

        // Nothing was delivered, so resolving here would run the composer's
        // success cleanup and wipe the draft and attachments the user can
        // still see and edit.
        await expect(send).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
        expect(requests.some((request) => request.type === 'session.sendPrompt')).toBe(false)
      } finally {
        store.dispose()
      }
    },
  )
})
