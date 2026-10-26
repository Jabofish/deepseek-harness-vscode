// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { AgentConfiguration } from '@dsh-vscode/domain'
import { activateDraftOwner, readDraft, resetDraft, setDraft } from './draft-store.js'
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
})
