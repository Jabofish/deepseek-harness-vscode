// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentConfiguration, SessionDetail } from '@dsh-vscode/domain'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { resetDraft } from './draft-store.js'
import { createHostBackedAppStore, type FixtureRequest } from '../test/host-window-store.js'

const configuration: AgentConfiguration = {
  preset: '',
  toolMode: 'native',
  permissionPreset: 'workspace-write',
  planMode: false,
  model: { providerId: '', modelId: '' },
}

function blank(id: string, agentPreset?: string): SessionDetail {
  return {
    id,
    workspaceId: 'w',
    title: id,
    blank: true,
    status: 'idle',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    configuration: { ...configuration, preset: agentPreset ?? '' },
    history: [],
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

async function fixture(
  rows: SessionDetail[],
  archived: string[] = [],
): Promise<{
  store: ReturnType<typeof createHostBackedAppStore>
  requests: FixtureRequest[]
  capability: (enabled?: boolean) => void
  disconnect: () => void
  setGate: (value: Promise<void>) => void
  fail: () => void
  replace: (id: string) => void
}> {
  const requests: FixtureRequest[] = []
  let listener: (message: HostMessage) => void = () => {}
  let gate: Promise<void> | undefined
  let failure = false
  let replacement: string | undefined
  const client = {
    subscribe: (next: typeof listener) => {
      listener = next
      return () => {}
    },
    dispose: () => {},
    request: async (request: FixtureRequest) => {
      requests.push(request)
      if (request.type === 'workspace.list')
        return {
          items: [...new Set(['w', ...rows.map((row) => row.workspaceId)])].map((workspaceId) => ({
            id: workspaceId,
            name: 'Workspace',
            sessionIds: rows.filter((r) => r.workspaceId === workspaceId).map((r) => r.id),
            sessionCount: rows.filter((r) => r.workspaceId === workspaceId).length,
            createdAt: rows[0]?.createdAt ?? '',
            updatedAt: rows[0]?.updatedAt ?? '',
          })),
          archivedSessionIds: archived,
        }
      if (request.type === 'session.list') return { items: rows }
      if (request.type === 'session.create') {
        await gate
        if (failure) throw new Error('Creation refused')
        const existing =
          replacement === undefined ? rows.find((r) => r.id === request.payload.sessionId) : undefined
        const created =
          existing ??
          blank(replacement ?? `new-${rows.length}`, request.payload.configuration.preset || undefined)
        if (!existing) rows.push(created)
        return created
      }
      if (request.type === 'session.open') return rows.find((r) => r.id === request.payload.sessionId)
      if (request.type === 'models.session.list') return { models: [], failures: [], routable: true }
      if (request.type === 'subagent.list') return { entries: [], parentAvailable: true }
      return []
    },
  }
  const store = createHostBackedAppStore(client as unknown as ProtocolClient)
  const capability = (enabled?: boolean): void =>
    listener({
      type: 'event',
      name: 'connection.snapshot',
      sequence: 1,
      payload: { kind: 'connected', ...(enabled === undefined ? {} : { blankSessionReuse: enabled }) },
    })
  capability(true)
  await store.refreshSessions()
  return {
    store,
    requests,
    capability,
    disconnect: () =>
      listener({ type: 'event', name: 'connection.snapshot', sequence: 2, payload: { kind: 'idle' } }),
    setGate: (value: Promise<void>) => {
      gate = value
    },
    fail: () => {
      failure = true
    },
    replace: (id: string) => {
      replacement = id
    },
  }
}

afterEach(resetDraft)

describe('native blank-session creation capability', () => {
  it('matches the requested preset and excludes archived, started, foreign and subagent sessions', async () => {
    const rows = [
      blank('ordinary', 'standard'),
      blank('archived', 'cordis'),
      { ...blank('started', 'cordis'), blank: false },
      { ...blank('child', 'cordis'), origin: 'subagent' as const },
      { ...blank('foreign', 'cordis'), workspaceId: 'other' },
      blank('creator', 'cordis'),
    ]
    const { store, requests } = await fixture(rows, ['archived'])
    try {
      await store.stageSession('w', 'cordis')
      expect(store.activeSessionId).toBe('creator')
      expect(requests.find((r) => r.type === 'session.create')).toMatchObject({
        payload: {
          workspaceId: 'w',
          sessionId: 'creator',
          configuration: { preset: 'cordis' },
        },
      })
    } finally {
      store.dispose()
    }
  })

  it('preserves the current session on refusal and does not navigate after a newer open', async () => {
    const { store, setGate, fail } = await fixture([blank('current')])
    let release!: () => void
    try {
      await store.openSession('current')
      fail()
      await expect(store.stageSession('w', 'cordis')).rejects.toThrow('Creation refused')
      expect(store.activeSessionId).toBe('current')
      setGate(
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      const creation = store.stageSession('w', 'cordis')
      await store.openSession('current')
      release()
      await expect(creation).rejects.toThrow('Creation refused')
      expect(store.activeSessionId).toBe('current')
    } finally {
      release?.()
      store.dispose()
    }
  })
})
