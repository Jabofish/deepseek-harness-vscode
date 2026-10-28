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
