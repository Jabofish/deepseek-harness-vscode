// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class StartupClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly respond: (request: WebviewRequest) => unknown = startupResponse) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.respond(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
  }
}

const activeSession = {
  id: 'session-active',
  workspaceId: 'workspace-1',
  title: 'Existing active conversation',
  blank: false,
  status: 'running',
  createdAt: '2026-08-21T08:00:00.000Z',
  updatedAt: '2026-08-21T08:05:00.000Z',
} as const

const blankSession = {
  id: 'session-blank',
  workspaceId: 'workspace-1',
  title: 'New session',
  blank: true,
  status: 'idle',
  createdAt: '2026-08-21T07:00:00.000Z',
  updatedAt: '2026-08-21T07:01:00.000Z',
} as const

const workspace = {
  id: 'workspace-1',
  name: 'Workspace',
  path: 'C:\\workspace',
  sessionIds: ['session-blank'],
  createdAt: '2026-08-21T06:00:00.000Z',
  updatedAt: '2026-08-21T07:01:00.000Z',
  sessionCount: 1,
} as const

function startupResponse(request: WebviewRequest): unknown {
  switch (request.type) {
    case 'app.ready':
    case 'runtime.update.check':
    case 'settings.read':
      return request.type === 'runtime.update.check'
        ? {
            status: 'ready',
            availableVersions: ['0.1.0-rc.8'],
            updateAvailable: false,
            checkedAt: '2026-08-21T00:00:00.000Z',
          }
        : undefined
    case 'session.list':
      return { items: [activeSession] }
    case 'workspace.list':
      return { items: [] }
    case 'providers.list':
    case 'models.list':
      return []
    case 'preset.list':
      return { presets: [] }
    case 'session.open':
      return {
        ...activeSession,
        history: [],
        permissionPresets: ['workspace-write', 'danger-full-access'],
        configuration: {
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        },
      }
    case 'session.queue.list':
    case 'goal.list':
    case 'job.list':
    case 'feedback.list':
    case 'command.list':
    case 'skill.list':
    case 'subagent.list':
      return request.type === 'subagent.list' ? { entries: [], parentAvailable: true } : []
    case 'models.session.list':
      return { models: [] }
    default:
      throw new Error(`unexpected startup request ${request.type}`)
  }
}

describe('AppStore startup session restoration', () => {
  afterEach(() => document.body.replaceChildren())

  it('retains Host-emitted DSH update phases for the settings progress surface', () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)

    client.emit({
      type: 'event',
      name: 'runtime.update.progress',
      sequence: 1,
      payload: { phase: 'downloading', version: '0.1.1-rc.1' },
    })

    expect(store.dshUpdateProgress).toEqual({ phase: 'downloading', version: '0.1.1-rc.1' })
  })

  it('opens an existing active root session when no persisted id is available', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()

    expect(store.activeSessionId).toBe('session-active')
    expect(store.configuration).toMatchObject({
      permissionPreset: 'workspace-write',
      planMode: false,
    })
    expect(client.requests.filter((request) => request.type === 'session.open')).toHaveLength(1)
    expect(client.requests).toContainEqual(
      expect.objectContaining({
        type: 'runtime.update.check',
        payload: { force: false },
      }),
    )
    expect(client.requests).toContainEqual(
      expect.objectContaining({
        type: 'session.open',
        payload: { sessionId: 'session-active' },
      }),
    )

    store.dispose()
  })

  it('opens an existing blank root session instead of showing the new-session empty state', async () => {
    const client = new StartupClient()
    client.request = <T>(request: WebviewRequest): Promise<T> => {
      client.requests.push(request)
      if (request.type === 'session.list') return Promise.resolve({ items: [blankSession] } as T)
      if (request.type === 'session.open')
        return Promise.resolve({
          ...blankSession,
          history: [],
          permissionPresets: [],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        } as T)
      return Promise.resolve(startupResponse(request) as T)
    }
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()

    expect(store.activeSessionId).toBe('session-blank')
    expect(client.requests).toContainEqual(
      expect.objectContaining({ type: 'session.open', payload: { sessionId: 'session-blank' } }),
    )

    store.dispose()
  })

  it('uses the rc.1 workspace blank-session adoption payload for a matching new session', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'workspace.list') return { items: [workspace] }
      if (request.type === 'session.list') return { items: [{ ...blankSession, cwd: workspace.path }] }
      if (request.type === 'session.create') return { id: blankSession.id }
      if (request.type === 'session.open')
        return {
          ...blankSession,
          cwd: workspace.path,
          history: [],
          permissionPresets: [],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()
    client.emit({
      type: 'event',
      name: 'connection.snapshot',
      sequence: 1,
      payload: { kind: 'connected', dshVersion: '0.1.1-rc.1' },
    })
    await store.createSession('workspace-1')

    const reuseRequest = client.requests.find(
      (request): request is Extract<WebviewRequest, { type: 'session.create' }> =>
        request.type === 'session.create',
    )
    expect(reuseRequest).toBeDefined()
    if (reuseRequest === undefined) throw new Error('expected blank session reuse request')
    expect(reuseRequest.payload.workspaceId).toBe('workspace-1')
    expect(reuseRequest.payload.sessionId).toBe('session-blank')
    expect(reuseRequest.payload.reuseWorkspaceBlank).toBe(true)

    store.dispose()
  })

  it('opens the matching blank workspace session locally on rc.2', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'workspace.list') return { items: [workspace] }
      if (request.type === 'session.list') return { items: [{ ...blankSession, cwd: workspace.path }] }
      if (request.type === 'session.open')
        return {
          ...blankSession,
          cwd: workspace.path,
          history: [],
          permissionPresets: [],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()
    client.emit({
      type: 'event',
      name: 'connection.snapshot',
      sequence: 1,
      payload: { kind: 'connected', dshVersion: '0.1.1-rc.2' },
    })
    await store.createSession('workspace-1')

    expect(client.requests.filter((request) => request.type === 'session.create')).toHaveLength(0)
    expect(client.requests).toContainEqual(
      expect.objectContaining({ type: 'session.open', payload: { sessionId: 'session-blank' } }),
    )
    expect(store.activeSessionId).toBe('session-blank')

    store.dispose()
  })

  it('refreshes the cached model directory on rc.1 and legacy owner invalidations', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()
    for (const [sequence, name] of [
      [7, 'credentials/reference-updated'],
      [8, 'credentials/updated'],
    ] as const) {
      const before = client.requests.filter(
        (request) => request.type === 'providers.list' || request.type === 'models.list',
      ).length
      client.emit({
        type: 'event',
        name: 'remote.event',
        sequence,
        payload: { name, args: ['deepseek-key'] },
      })
      await Promise.resolve()
      await Promise.resolve()

      const after = client.requests.filter(
        (request) => request.type === 'providers.list' || request.type === 'models.list',
      ).length
      expect(after).toBe(before + 2)
    }
    store.dispose()
  })
})
