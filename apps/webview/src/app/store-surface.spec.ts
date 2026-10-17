// @vitest-environment jsdom

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

/** Let queued microtasks and the zero-delay retry timers settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('AppStore surface identity', () => {
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
  it('opens the session an editor assignment binds', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })

      await vi.waitFor(() => expect(requestsOfType(client, 'session.open')).toHaveLength(1))
      expect(requestsOfType(client, 'session.open')[0]).toMatchObject({ payload: { sessionId: 's1' } })
      // The assignment is readable through the store's state view, not only
      // through getState().
      expect(store.surface).toEqual({ kind: 'editor', sessionId: 's1' })
    } finally {
      store.dispose()
    }
  })

  it('does not re-open the session already on screen', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s1')
      expect(store.getState().activeSessionId).toBe('s1')

      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await settle()
      await settle()

      expect(requestsOfType(client, 'session.open')).toHaveLength(1)
    } finally {
      store.dispose()
    }
  })

  it('records the editor chat count from the handoff broadcast', () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.handoff', { editorChats: 2 })
      expect(store.getState().editorChats).toBe(2)
      expect(store.editorChats).toBe(2)

      client.emit('ui.surface.handoff', { editorChats: 0 })
      expect(store.editorChats).toBe(0)
    } finally {
      store.dispose()
    }
  })

  it('never opens the side-bar session into a malformed handoff count', () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.handoff', { editorChats: -1 })
      expect(store.editorChats).toBe(0)
      client.emit('ui.surface.handoff', 'nope')
      expect(store.editorChats).toBe(0)
    } finally {
      store.dispose()
    }
  })

  it('ignores an assignment whose kind is unknown', () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.assigned', { kind: 'floating' })
      expect(store.getState().surface).toBeUndefined()
      expect(requestsOfType(client, 'session.open')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })
})

describe('AppStore open-in-editor command', () => {
  it('asks the Host to open the active session in the editor area', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s1')
      client.emit('ui.surface.openInEditor', {})

      const requests = client.requests.filter((request) => request.type === 'surface.openInEditor')
      expect(requests).toHaveLength(1)
      // The store knows the session title, so the editor tab can be named
      // before its first render.
      expect(requests[0]).toMatchObject({ payload: { sessionId: 's1', title: 'Session one' } })
    } finally {
      store.dispose()
    }
  })

  it('sends nothing from an editor surface, which already shows the session', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await vi.waitFor(() => expect(requestsOfType(client, 'session.open')).toHaveLength(1))

      client.emit('ui.surface.openInEditor', {})

      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })

  it('sends nothing when the store has no active session', () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.openInEditor', {})
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })
})

describe('AppStore bound-session startup', () => {
  it('does not perform the startup restore on an editor surface', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      // The bound-session assignment precedes the Host's `app.ready` reply, and
      // a tab whose session is not known yet must not load the side bar's
      // remembered/last conversation in the meantime.
      client.emit('ui.surface.assigned', { kind: 'editor' })

      await store.initialize()

      expect(store.surface).toEqual({ kind: 'editor' })
      expect(requestsOfType(client, 'session.open')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })

  it('still restores the last session on the side bar surface', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.assigned', { kind: 'sidebar' })
      client.emit('connection.snapshot', { kind: 'connected' })

      await store.initialize()

      await vi.waitFor(() => expect(requestsOfType(client, 'session.open')).toHaveLength(1))
      expect(store.getState().activeSessionId).toBe('s1')
    } finally {
      store.dispose()
    }
  })
})

describe('AppStore move-to-sidebar action', () => {
  it('sends the surface.moveToSidebar request without a payload', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.moveChatToSidebar()

      const requests = requestsOfType(client, 'surface.moveToSidebar')
      expect(requests).toHaveLength(1)
      expect(requests[0]).not.toHaveProperty('payload')
    } finally {
      store.dispose()
    }
  })
})

describe('AppStore independent side-bar session routing', () => {
  it('opens an editor tab only when explicitly requested', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.handoff', { editorChats: 1 })
      client.emit('ui.surface.assigned', { kind: 'sidebar' })
      await store.refreshSessions()

      await store.openSessionInEditor('s1')

      const requests = requestsOfType(client, 'surface.openInEditor')
      expect(requests).toHaveLength(1)
      // The side bar already knows the session catalog, so the new tab is named
      // before it renders; the Host still bounds and re-sanitizes the label.
      expect(requests[0]).toMatchObject({ payload: { sessionId: 's1', title: 'Session one' } })
    } finally {
      store.dispose()
    }
  })

  it('opens a selected session in the sidebar even with editor chats open', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.handoff', { editorChats: 1 })
      client.emit('ui.surface.assigned', { kind: 'sidebar' })
      await store.refreshSessions()
      client.requests.length = 0

      await store.openSession('s1')

      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
      expect(requestsOfType(client, 'session.open')).toHaveLength(1)
      expect(store.getState().activeSessionId).toBe('s1')
    } finally {
      store.dispose()
    }
  })

  it('opens locally on the side bar when no editor tab exists', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.assigned', { kind: 'sidebar' })

      await store.openSession('s1')

      expect(requestsOfType(client, 'session.open')).toHaveLength(1)
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })

  it('creates and sends a sidebar session without rebinding or opening an editor tab', async () => {
    const client = new SurfaceClient((request) => {
      if (request.type === 'workspace.list')
        return [
          {
            id: 'workspace-1',
            name: 'Workspace',
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
      client.emit('ui.surface.assigned', { kind: 'sidebar' })
      await store.refreshSessions()
      await store.openSession('s1')
      await store.openSessionInEditor('s1')
      expect(store.getState().activeSessionId).toBe('s1')
      client.emit('ui.surface.handoff', { editorChats: 1 })
      client.requests.length = 0

      await store.stageSession('workspace-1')
      expect(store.getState().pendingSession?.workspaceId).toBe('workspace-1')
      expect(requestsOfType(client, 'session.create')).toHaveLength(0)
      // A later editor lifecycle notification must not take over the new draft.
      client.emit('ui.surface.handoff', { editorChats: 2 })
      await store.sendPendingPrompt('A separate task', [], 'queue')

      expect(store.getState().activeSessionId).toBe('s2')
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
      expect(requestsOfType(client, 'surface.moveToSidebar')).toHaveLength(0)
      expect(requestsOfType(client, 'session.sendPrompt')).toMatchObject([
        { payload: { sessionId: 's2', text: 'A separate task' } },
      ])
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
      expect(store.getState().surfaceError).not.toBe(firstFailure)
      expect(store.getState().activeSessionId).toBe('s1')
      expect(requestsOfType(client, 'session.sendPrompt')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })

  it('opens the returned session visibly in the sidebar while another editor remains', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s1')
      client.emit('ui.surface.handoff', { editorChats: 2 })
      client.emit('ui.surface.openInSidebar', { sessionId: 's2' })
      await vi.waitFor(() => expect(store.getState().activeSessionId).toBe('s2'))
      await store.openSession('s3')
      expect(store.getState().activeSessionId).toBe('s3')
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })
  it('moves the active session to the editor area for /moveto:editor', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s1')
      await store.refreshSessions()
      client.requests.length = 0

      expect(await store.runMovetoCommand('/moveto:editor')).toBe('editor')

      const requests = requestsOfType(client, 'surface.openInEditor')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ payload: { sessionId: 's1', title: 'Session one' } })
    } finally {
      store.dispose()
    }
  })

  it('moves the chat back to the side bar for /moveto:sidebar without a session', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      expect(await store.runMovetoCommand('/moveto:sidebar')).toBe('sidebar')

      expect(requestsOfType(client, 'surface.moveToSidebar')).toHaveLength(1)
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })

  it('reports an unusable target instead of asking the host for anything', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.openSession('s1')

      expect(await store.runMovetoCommand('/moveto:bogus')).toBe('unknown-target')
      expect(await store.runMovetoCommand('/moveto')).toBe('unknown-target')

      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
      expect(requestsOfType(client, 'surface.moveToSidebar')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })

  it('reports a missing session instead of opening an unbound editor tab', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      expect(await store.runMovetoCommand('/moveto:editor')).toBe('no-session')
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
    } finally {
      store.dispose()
    }
  })

  it('does nothing extra when the editor surface already shows the session', async () => {
    const client = new SurfaceClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      client.emit('ui.surface.assigned', { kind: 'editor', sessionId: 's1' })
      await vi.waitFor(() => expect(requestsOfType(client, 'session.open')).toHaveLength(1))
      client.requests.length = 0

      expect(await store.runMovetoCommand('/moveto:editor')).toBe('editor')
      expect(requestsOfType(client, 'surface.openInEditor')).toHaveLength(0)
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
