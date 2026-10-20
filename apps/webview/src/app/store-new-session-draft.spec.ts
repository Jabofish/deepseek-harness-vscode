// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { AgentConfiguration } from '@dsh-vscode/domain'
import { activateDraftOwner, clearDraftIf, readDraft, resetDraft, setDraft } from './draft-store.js'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

const configuration: AgentConfiguration = {
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

function fixture(
  failFirstOpen = false,
  beforeList?: () => Promise<void>,
  beforeConfigure?: () => Promise<void>,
  createReceipt?: Record<string, unknown>,
): {
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
      if (request.type === 'session.list') {
        await beforeList?.()
        return { items: created ? [session('created')] : [] }
      }
      if (request.type === 'session.create') {
        created = true
        return createReceipt ?? { id: 'created' }
      }
      if (request.type === 'session.configure') await beforeConfigure?.()
      if (request.type === 'session.open') {
        if (openFailures > 0) {
          openFailures -= 1
          throw new Error('Open failed')
        }
        return session(request.payload.sessionId)
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
  it('transfers first-message text only after opening the created session', async () => {
    resetDraft()
    const { store } = fixture(true)
    try {
      await store.refreshSessions()
      await store.stageSession('w1')
      const owner = `pending:${store.getState().pendingSession!.revision}`
      activateDraftOwner(owner)
      setDraft('Hello')
      await expect(store.sendPendingPrompt('Hello', [], 'queue')).rejects.toThrow('Open failed')
      expect(readDraft()).toBe('Hello')
      await store.sendPendingPrompt('Hello', [], 'queue')
      activateDraftOwner('created')
      expect(readDraft()).toBe('Hello')
      clearDraftIf(owner, 'Hello')
      expect(readDraft()).toBe('')
    } finally {
      store.dispose()
      resetDraft()
    }
  })

  it('keeps New local until the first ordinary message is submitted', async () => {
    const { store, requests } = fixture()
    try {
      await store.refreshSessions()
      const before = requests.length
      await store.stageSession('w1')
      expect(requests).toHaveLength(before)
      expect(store.getState().pendingSession?.workspaceId).toBe('w1')
      expect(store.getState().pendingSession?.configuration.preset).toBe('')
      expect(store.activeSessionId).toBeUndefined()

      await store.sendPendingPrompt('Hello', [], 'queue')
      const createIndex = requests.findIndex((request) => request.type === 'session.create')
      const configureIndex = requests.findIndex((request) => request.type === 'session.configure')
      const sendIndex = requests.findIndex((request) => request.type === 'session.sendPrompt')
      expect(createIndex).toBeGreaterThanOrEqual(before)
      expect(configureIndex).toBeGreaterThan(createIndex)
      expect(sendIndex).toBeGreaterThan(configureIndex)
      expect(store.activeSessionId).toBe('created')
      expect(store.getState().pendingSession).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('waits for the selected permissions and Plan before sending the first prompt', async () => {
    const gate = deferred<void>()
    const { store, requests } = fixture(false, undefined, () => gate.promise, session('created'))
    try {
      await store.refreshSessions()
      await store.stageSession('w1')
      const chosen = { ...configuration, permissionPreset: 'read-only', planMode: true }
      store.configurePendingSession(chosen)
      const send = store.sendPendingPrompt('Hello', [], 'queue')
      await vi.waitFor(() => expect(requests.some((r) => r.type === 'session.configure')).toBe(true))
      expect(requests.find((r) => r.type === 'session.configure')?.payload).toEqual({
        sessionId: 'created',
        configuration: chosen,
      })
      expect(requests.some((r) => r.type === 'session.sendPrompt' || r.type === 'session.open')).toBe(false)
      gate.resolve()
      await send
      expect(requests.filter((r) => r.type === 'session.sendPrompt')).toHaveLength(1)
    } finally {
      gate.resolve()
      store.dispose()
    }
  })

  it('uses a fresh authoritative create receipt without reconfiguring untouched display defaults', async () => {
    const { store, requests } = fixture(false, undefined, undefined, session('created'))
    try {
      await store.refreshSessions()
      await store.stageSession('w1')
      await store.sendPendingPrompt('Hello', [], 'queue')
      expect(requests.some((request) => request.type === 'session.configure')).toBe(false)
      expect(requests.some((request) => request.type === 'session.sendPrompt')).toBe(true)
    } finally {
      store.dispose()
    }
  })

  it('rechecks configuration on retry even if the first fresh create needed no additional writes', async () => {
    const { store, requests } = fixture(true, undefined, undefined, session('created'))
    try {
      await store.refreshSessions()
      await store.stageSession('w1')
      await expect(store.sendPendingPrompt('Hello', [], 'queue')).rejects.toThrow('Open failed')
      expect(requests.some((request) => request.type === 'session.configure')).toBe(false)
      await store.sendPendingPrompt('Hello', [], 'queue')
      expect(requests.filter((request) => request.type === 'session.configure')).toHaveLength(1)
      expect(requests.filter((request) => request.type === 'session.create')).toHaveLength(1)
    } finally {
      store.dispose()
    }
  })

  it('configures a model that the create receipt did not confirm', async () => {
    const { store, requests } = fixture(false, undefined, undefined, session('created'))
    try {
      await store.refreshSessions()
      await store.stageSession('w1')
      const pending = store.getState().pendingSession!.configuration
      store.configurePendingSession({ ...pending, model: { providerId: 'provider', modelId: 'selected' } })
      await store.sendPendingPrompt('Hello', [], 'queue')
      expect(requests.filter((request) => request.type === 'session.configure')).toHaveLength(1)
    } finally {
      store.dispose()
    }
  })

  it('preserves the pending draft and created ID when configuration fails, then retries safely', async () => {
    let fail = true
    const { store, requests } = fixture(false, undefined, () =>
      fail ? Promise.reject(new Error('Configuration failed')) : Promise.resolve(),
    )
    resetDraft()
    try {
      await store.refreshSessions()
      await store.stageSession('w1')
      const owner = `pending:${store.getState().pendingSession!.revision}`
      activateDraftOwner(owner)
      setDraft('Hello')
      await expect(store.sendPendingPrompt('Hello', [], 'queue')).rejects.toThrow('Configuration failed')
      expect(readDraft()).toBe('Hello')
      expect(store.getState().pendingSession?.createdSessionId).toBe('created')
      expect(requests.some((r) => r.type === 'session.sendPrompt' || r.type === 'session.open')).toBe(false)
      fail = false
      await store.sendPendingPrompt('Hello', [], 'queue')
      expect(requests.filter((r) => r.type === 'session.create')).toHaveLength(1)
      expect(requests.filter((r) => r.type === 'session.configure')).toHaveLength(2)
      expect(requests.filter((r) => r.type === 'session.sendPrompt')).toHaveLength(1)
    } finally {
      store.dispose()
      resetDraft()
    }
  })

  it.each(['cancel', 'new-draft', 'configuration'] as const)(
    'does not send a stale first prompt after %s during configuration',
    async (change) => {
      const gate = deferred<void>()
      const controller = new AbortController()
      const { store, requests } = fixture(false, undefined, () => gate.promise)
      try {
        await store.refreshSessions()
        await store.stageSession('w1')
        const send = store.sendPendingPrompt('Hello', [], 'queue', controller.signal)
        await vi.waitFor(() => expect(requests.some((r) => r.type === 'session.configure')).toBe(true))
        if (change === 'cancel') controller.abort()
        else if (change === 'new-draft') await store.stageSession('w1')
        else store.configurePendingSession({ ...configuration, planMode: true })
        gate.resolve()
        await expect(send).rejects.toMatchObject(
          change === 'cancel' ? { name: 'AbortError' } : { code: 'REQUEST_CANCELLED' },
        )
        expect(requests.some((r) => r.type === 'session.sendPrompt' || r.type === 'session.open')).toBe(false)
      } finally {
        gate.resolve()
        store.dispose()
      }
    },
  )

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

  it.each(['first-message', 'create-session'] as const)(
    'completes %s before a slow directory refresh and keeps subsequent navigation',
    async (action) => {
      const directory = deferred<void>()
      let slow = false
      const { store, requests } = fixture(false, () => (slow ? directory.promise : Promise.resolve()))
      let operation: Promise<void> | undefined
      try {
        await store.refreshSessions()
        if (action === 'first-message') await store.stageSession('w1')
        slow = true
        let completed = false
        operation = (
          action === 'first-message'
            ? store.sendPendingPrompt('Hello', [], 'queue')
            : store.createSession('w1')
        ).then(() => {
          completed = true
        })
        await vi.waitFor(() => expect(completed).toBe(true))
        expect(store.activeSessionId).toBe('created')
        expect(store.sessions.some((row) => row.id === 'created')).toBe(true)
        if (action === 'first-message')
          expect(requests.filter((request) => request.type === 'session.sendPrompt')).toHaveLength(1)
        await store.openSession('other')
        directory.resolve()
        await vi.waitFor(() => expect(store.workspaces[0]?.sessionCount).toBe(1))
        expect(store.activeSessionId).toBe('other')
      } finally {
        directory.resolve()
        await operation
        store.dispose()
      }
    },
  )

  it.each(['create', 'open'] as const)(
    'rejects a pending send superseded during %s as cancelled instead of resolving as delivered',
    async (phase) => {
      const gates = {
        create: deferred<unknown>(),
        open: deferred<unknown>(),
      }
      const armed = { create: false, open: false }
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
          if (request.type === 'session.list') return { items: created ? [session('created')] : [] }
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

        if (phase === 'create') {
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
