import { describe, expect, it, vi } from 'vitest'
import type { HostEvent, HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createHostBackedAppStore as createAppStore } from '../test/host-window-store.js'

/**
 * A scripted host that answers the ordinary startup/open traffic and can push
 * the surface control frames the real Host sends after `app.ready`.
 */
class SurfaceClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private sequence = 0
  public constructor(private readonly answer: (request: WebviewRequest) => unknown = surfaceResponse) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.answer(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  public emit(name: string, payload: unknown): void {
    this.sequence += 1
    const message: HostEvent = { type: 'event', name, sequence: this.sequence, payload }
    for (const listener of this.listeners) listener(message)
  }
}

const session = {
  id: 's1',
  workspaceId: 'workspace-1',
  title: 'Session one',
  blank: false,
  status: 'idle',
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
} as const

const blank = { ...session, id: 's2', title: 'Blank session', blank: true }
const workspace = {
  id: 'workspace-1',
  name: 'Workspace',
  sessionIds: ['s1', 's2'],
  sessionCount: 2,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
}

function surfaceResponse(request: WebviewRequest): unknown {
  switch (request.type) {
    case 'session.open':
      return {
        ...session,
        id: request.payload.sessionId,
        history: [],
        permissionPresets: ['workspace-write'],
        configuration: {
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        },
      }
    case 'session.list':
      return { items: [session] }
    case 'workspace.list':
      return []
    case 'subagent.list':
      return { entries: [], parentAvailable: true }
    case 'models.session.list':
      return {
        models: [],
        failures: [],
        current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        routable: true,
      }
    default:
      return undefined
  }
}

function requestsOfType(client: SurfaceClient, type: WebviewRequest['type']): readonly WebviewRequest[] {
  return client.requests.filter((request) => request.type === type)
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AppStore surface identity', () => {
  it('keeps the originating editor unchanged when New Session reveals another editor', async () => {
    const client = new SurfaceClient((request) => {
      if (request.type === 'workspace.list') return [workspace]
      if (request.type === 'session.list') return { items: [blank, session] }
      if (request.type === 'session.create') return blank
      if (request.type === 'surface.openInEditor') return { surface: 'editor', rebound: false }
      return surfaceResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('connection.snapshot', {
        kind: 'connected',
        dshVersion: '0.2.2-rc.3',
        blankSessionReuse: true,
      })
      await store.refreshSessions()
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))

      await expect(store.createSession(workspace.id)).resolves.toBe('s2')

      const creations = requestsOfType(client, 'session.create')
      expect(creations).toHaveLength(1)
      expect(creations[0]).toHaveProperty('payload.sessionId', 's2')
      expect(requestsOfType(client, 'surface.openInEditor')).toEqual([
        expect.objectContaining({ payload: { sessionId: 's2', replaceCurrent: true } }),
      ])
      expect(requestsOfType(client, 'session.open')).toEqual([
        expect.objectContaining({ payload: { sessionId: 's1' } }),
      ])
      expect(store.getState().surface).toEqual({ kind: 'editor', sessionId: 's1' })
      expect(store.getState().activeSessionId).toBe('s1')
    } finally {
      store.dispose()
    }
  })

  it.each(['0.1.1-rc.1', '0.1.1-rc.2'])(
    'creates a local first-message session in an editor on DSH %s',
    async (version) => {
      const client = new SurfaceClient((request) => {
        if (request.type === 'workspace.list') return [workspace]
        if (request.type === 'session.list') return { items: [blank, session] }
        if (request.type === 'session.create') return { id: 'new' }
        if (request.type === 'surface.openInEditor') return { surface: 'editor', rebound: true }
        return surfaceResponse(request)
      })
      const store = createAppStore(client as unknown as ProtocolClient)
      try {
        client.emit('connection.snapshot', { kind: 'connected', dshVersion: version })
        await store.refreshSessions()
        client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
        await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))
        await store.stageSession(workspace.id)

        await store.sendPendingPrompt('First message', [], 'queue')

        const creations = requestsOfType(client, 'session.create')
        expect(creations).toHaveLength(1)
        expect(creations[0]).not.toHaveProperty('payload.sessionId')
        const prompts = requestsOfType(client, 'session.sendPrompt')
        expect(prompts).toHaveLength(1)
        expect(prompts[0]).toMatchObject({ payload: { sessionId: 'new', text: 'First message' } })
        expect(store.getState().surface).toEqual({ kind: 'editor', sessionId: 'new' })
      } finally {
        store.dispose()
      }
    },
  )

  it('clears the old conversation after rebinding even when the new history cannot load', async () => {
    let failOpen = true
    const client = new SurfaceClient((request) => {
      if (request.type === 'workspace.list') return [workspace]
      if (request.type === 'session.create') return blank
      if (request.type === 'surface.openInEditor') return { surface: 'editor', rebound: true }
      if (request.type === 'session.open' && request.payload.sessionId === 's2' && failOpen)
        return Promise.reject(new Error('History is unavailable.'))
      return surfaceResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.refreshSessions()
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))

      await expect(store.createSession(workspace.id)).rejects.toThrow('History is unavailable.')
      expect(store.getState().surface).toEqual({ kind: 'editor', sessionId: 's2' })
      expect(store.getState().activeSessionId).toBeUndefined()
      expect(store.getState().transcript).toBeUndefined()

      failOpen = false
      await store.openSession('s2')
      expect(store.getState().activeSessionId).toBe('s2')
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(1)
    } finally {
      store.dispose()
    }
  })

  it('does not rebind an editor when a creation receipt arrives after the user opens a different tab', async () => {
    const creation = deferred<typeof blank>()
    let created = false
    const client = new SurfaceClient((request) => {
      if (request.type === 'workspace.list') return [workspace]
      if (request.type === 'session.list') return { items: created ? [session, blank] : [session] }
      if (request.type === 'session.create')
        return creation.promise.then((value) => {
          created = true
          return value
        })
      return surfaceResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('connection.snapshot', {
        kind: 'connected',
        dshVersion: '0.2.2-rc.3',
        blankSessionReuse: true,
      })
      await store.refreshSessions()
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))

      const creating = store.createSession(workspace.id)
      await store.openSession('s3')
      creation.resolve(blank)
      await creating

      const opens = requestsOfType(client, 'surface.openInEditor')
      expect(opens).toHaveLength(1)
      expect(opens[0]).toMatchObject({ payload: { sessionId: 's3' } })
      expect(store.getState().surface).toEqual({ kind: 'editor', sessionId: 's1' })
      expect(store.getState().sessions.some((entry) => entry.id === 's2')).toBe(true)
    } finally {
      store.dispose()
    }
  })

  it('ignores an older binding reply that arrives after a newer binding is shown', async () => {
    const older = deferred<{ surface: string; rebound: boolean }>()
    const client = new SurfaceClient((request) => {
      if (request.type === 'workspace.list') return [workspace]
      if (request.type === 'session.create')
        return request.payload.configuration.preset === 'first' ? blank : { ...blank, id: 's3' }
      if (request.type === 'surface.openInEditor')
        return request.payload.sessionId === 's2' ? older.promise : { surface: 'editor', rebound: true }
      return surfaceResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.refreshSessions()
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))

      const first = store.createSession(workspace.id, 'first')
      await vi.waitFor(() => expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(1))
      await store.createSession(workspace.id, 'second')
      older.resolve({ surface: 'editor', rebound: true })
      await first

      expect(store.getState().surface).toEqual({ kind: 'editor', sessionId: 's3' })
      expect(store.getState().activeSessionId).toBe('s3')
    } finally {
      store.dispose()
    }
  })

  it('creates and sends a first message in an editor after updating the Host binding', async () => {
    const client = new SurfaceClient((request) => {
      if (request.type === 'workspace.list')
        return [
          {
            id: 'workspace-1',
            name: 'Workspace',
            sessionIds: ['s1'],
            sessionCount: 1,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
        ]
      if (request.type === 'session.create') return { id: 's2' }
      return surfaceResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.refreshSessions()
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))
      await store.stageSession('workspace-1')
      await store.sendPendingPrompt('First message', [], 'queue')
      expect(requestsOfType(client, 'surface.openInEditor')).toContainEqual(
        expect.objectContaining({
          payload: { sessionId: 's2', replaceCurrent: true },
        }),
      )
      expect(requestsOfType(client, 'session.sendPrompt')[0]).toMatchObject({
        payload: { sessionId: 's2', text: 'First message' },
      })
      expect(store.getState().surface).toEqual({ kind: 'editor', sessionId: 's2' })
      expect(store.getState().activeSessionId).toBe('s2')
      expect(store.getState().pendingSession).toBeUndefined()
    } finally {
      store.dispose()
    }
  })
  it('keeps an editor bound to its Host session when another session is selected', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('s1'))
      await store.openSession('s2')
      expect(store.getState().activeSessionId).toBe('s1')
      expect(requestsOfType(client, 'surface.openInEditor')[0]).toMatchObject({
        payload: { sessionId: 's2' },
      })
    } finally {
      store.dispose()
    }
  })
})

describe('AppStore /moveto client command', () => {
  it('rejects a failed move and exposes the failure without sending a prompt', async () => {
    const client = new SurfaceClient()
    const original = client.request.bind(client)
    client.request = (request) =>
      request.type === 'surface.openInEditor'
        ? Promise.reject(new Error('The editor cannot be opened.'))
        : original(request)
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s1')
      await expect(store.runMovetoCommand('/moveto editor')).rejects.toThrow('The editor cannot be opened.')
      const firstFailure = store.getState().surfaceError
      expect(firstFailure?.message).toBe('The editor cannot be opened.')
      await expect(store.runMovetoCommand('/moveto editor')).rejects.toThrow('The editor cannot be opened.')
      expect(store.getState().surfaceError?.message).toBe('The editor cannot be opened.')
      expect(store.getState().activeSessionId).toBe('s1')
      expect(requestsOfType(client, 'session.sendPrompt')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })

  it('never lets a /moveto line reach DSH as a prompt', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s1')
      await store.refreshSessions()
      client.requests.length = 0

      await store.sendPrompt('s1', '/moveto:editor', [], 'queue')
      await store.sendPrompt('s1', '/moveto:bogus', [], 'queue')

      expect(requestsOfType(client, 'session.sendPrompt')).toHaveLength(0)
      // The valid line still becomes an editor tab; the malformed one reports
      // itself through the caller's error surface and sends nothing.
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(1)
    } finally {
      store.dispose()
    }
  })
})
