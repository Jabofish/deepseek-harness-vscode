// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfiguration } from '@dsh-vscode/domain'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'

const vscodeState = vi.hoisted((): { value: unknown } => ({ value: undefined }))

vi.mock('../vscode-api.js', () => ({
  getVsCodeApi: () => ({
    postMessage: () => undefined,
    getState: () => vscodeState.value,
    setState: (value: unknown) => {
      vscodeState.value = value
    },
  }),
}))

import { createAppStore } from './store.js'

const STANDARD_CONFIGURATION: AgentConfiguration = {
  preset: 'standard',
  toolMode: 'native',
  permissionPreset: 'workspace-write',
  planMode: false,
  model: { providerId: '', modelId: '' },
}

function presetRoster(defaultPreset: string): Record<string, unknown> {
  return {
    presets: ['standard', 'alternate'].map((id) => ({
      id,
      trust: 'system',
      isDefault: id === defaultPreset,
    })),
    authorable: false,
    hasDocument: false,
    modeSelectionEnabled: true,
  }
}

function session(id: string, blank = true): Record<string, unknown> {
  return {
    id,
    workspaceId: 'w1',
    title: id,
    blank,
    status: 'idle',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    history: [],
    permissionPresets: ['workspace-write'],
    configuration: STANDARD_CONFIGURATION,
  }
}

class PresetLifecycleClient {
  public readonly requests: WebviewRequest[] = []
  public roster: unknown = presetRoster('standard')
  public sessions: readonly Record<string, unknown>[] = [session('blank')]
  private deferredPresetList:
    { readonly promise: Promise<unknown>; readonly resolve: (value: unknown) => void } | undefined

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    if (request.type === 'preset.list') {
      const deferred = this.deferredPresetList
      this.deferredPresetList = undefined
      return (deferred?.promise ?? Promise.resolve(this.roster)) as Promise<T>
    }
    if (request.type === 'session.list') return Promise.resolve({ items: this.sessions }) as Promise<T>
    if (request.type === 'workspace.list')
      return Promise.resolve({
        items: [
          {
            id: 'w1',
            name: 'Workspace',
            sessionIds: this.sessions.map((item) => item.id),
            sessionCount: this.sessions.length,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        ],
        archivedSessionIds: [],
      }) as Promise<T>
    if (request.type === 'session.open') {
      const opened = this.sessions.find((item) => item.id === request.payload.sessionId)
      return Promise.resolve(opened ?? session(request.payload.sessionId)) as Promise<T>
    }
    if (request.type === 'models.session.list')
      return Promise.resolve({ models: [], failures: [], routable: true }) as Promise<T>
    if (request.type === 'subagent.list')
      return Promise.resolve({ entries: [], parentAvailable: true }) as Promise<T>
    if (request.type === 'session.queue.list') return Promise.resolve({ items: [] }) as Promise<T>
    if (request.type === 'session.create') return Promise.resolve({ id: 'created' }) as Promise<T>
    return Promise.resolve([]) as Promise<T>
  }

  public subscribe(): () => void {
    return () => undefined
  }

  public dispose(): void {}

  public deferNextPresetList(): (value: unknown) => void {
    let resolve: (value: unknown) => void = () => undefined
    const promise = new Promise<unknown>((finish) => {
      resolve = finish
    })
    this.deferredPresetList = { promise, resolve }
    return (value) => resolve(value)
  }
}

async function loadedStore(client: PresetLifecycleClient): Promise<ReturnType<typeof createAppStore>> {
  const store = createAppStore(client as unknown as ProtocolClient)
  await store.refreshSessions()
  await store.loadPresetRoster()
  return store
}

describe('preset selection lifecycle', () => {
  beforeEach(() => {
    vscodeState.value = undefined
  })

  it('does not persist a selected preset or reuse it for the next new task', async () => {
    vscodeState.value = {
      version: 1,
      composerPreferences: { preset: 'alternate' },
    }
    const client = new PresetLifecycleClient()
    const store = await loadedStore(client)

    try {
      await store.openSession('blank')
      await store.configureSession('blank', {
        ...STANDARD_CONFIGURATION,
        preset: 'alternate',
      })
      await store.stageSession('w1')

      expect(store.getState().pendingSession?.configuration.preset).toBe('standard')
      const preferences = (vscodeState.value as { composerPreferences?: Record<string, unknown> })
        .composerPreferences
      expect(preferences?.preset).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('applies a changed Host default to the same active blank session', async () => {
    const client = new PresetLifecycleClient()
    const store = await loadedStore(client)

    try {
      await store.openSession('blank')
      client.roster = presetRoster('alternate')
      await store.loadPresetRoster()

      const configure = client.requests.find(
        (request): request is Extract<WebviewRequest, { type: 'session.configure' }> =>
          request.type === 'session.configure',
      )
      expect(configure?.payload.sessionId).toBe('blank')
      expect(configure?.payload.configuration).toMatchObject({
        preset: 'alternate',
        permissionPreset: 'workspace-write',
      })
      expect(store.getState().configuration?.preset).toBe('alternate')
    } finally {
      store.dispose()
    }
  })

  it('updates a local pending session when the Host default changes', async () => {
    const client = new PresetLifecycleClient()
    const store = await loadedStore(client)

    try {
      await store.stageSession('w1')
      client.roster = presetRoster('alternate')
      await store.loadPresetRoster()

      expect(store.getState().pendingSession?.configuration.preset).toBe('alternate')
      expect(client.requests.some((request) => request.type === 'session.configure')).toBe(false)
    } finally {
      store.dispose()
    }
  })

  it('does not change a nonblank active session when the Host default changes', async () => {
    const client = new PresetLifecycleClient()
    client.sessions = [session('started', false)]
    const store = await loadedStore(client)

    try {
      await store.openSession('started')
      client.roster = presetRoster('alternate')
      await store.loadPresetRoster()

      expect(client.requests.some((request) => request.type === 'session.configure')).toBe(false)
      expect(store.getState().configuration?.preset).toBe('standard')
    } finally {
      store.dispose()
    }
  })

  it('does not change a started session even if its summary still says blank', async () => {
    const client = new PresetLifecycleClient()
    client.sessions = [{ ...session('started'), status: 'running' }]
    const store = await loadedStore(client)

    try {
      await store.openSession('started')
      client.roster = presetRoster('alternate')
      await store.loadPresetRoster()

      expect(client.requests.some((request) => request.type === 'session.configure')).toBe(false)
      expect(store.getState().configuration?.preset).toBe('standard')
    } finally {
      store.dispose()
    }
  })

  it('does not apply a delayed default to a different session opened while the roster loads', async () => {
    const client = new PresetLifecycleClient()
    client.sessions = [session('first'), session('second')]
    const store = await loadedStore(client)

    try {
      await store.openSession('first')
      const finishRoster = client.deferNextPresetList()
      const rosterLoad = store.loadPresetRoster()
      await store.openSession('second')
      finishRoster(presetRoster('alternate'))
      await rosterLoad

      expect(client.requests.some((request) => request.type === 'session.configure')).toBe(false)
      expect(store.activeSessionId).toBe('second')
      expect(store.getState().configuration?.preset).toBe('standard')
    } finally {
      store.dispose()
    }
  })
})
