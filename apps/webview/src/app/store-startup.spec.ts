// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('starts the independent settings read while the startup catalog is still loading', async () => {
    let releaseSessions: (() => void) | undefined
    const sessionsReady = new Promise<unknown>((resolve) => {
      releaseSessions = () => resolve({ items: [activeSession] })
    })
    let settingsReadStarted = false
    const client = new StartupClient((request) => {
      if (request.type === 'session.list') return sessionsReady
      if (request.type === 'settings.read') {
        settingsReadStarted = true
        return undefined
      }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    const initialization = store.initialize()
    await Promise.resolve()
    await Promise.resolve()

    expect(settingsReadStarted).toBe(true)
    releaseSessions?.()
    await initialization
    store.dispose()
  })

  it('opens the remembered session before the busy-enter settings read finishes', async () => {
    let releaseSettings: ((value: unknown) => void) | undefined
    const settings = new Promise<unknown>((resolve) => {
      releaseSettings = resolve
    })
    const client = new StartupClient((request) => {
      if (request.type === 'settings.read') return settings
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    const initialization = store.initialize()

    await vi.waitFor(() =>
      expect(client.requests.some((request) => request.type === 'session.open')).toBe(true),
    )
    expect(store.activeSessionId).toBe('session-active')

    releaseSettings?.(undefined)
    await initialization
    store.dispose()
  })

  it('opens the remembered session before the startup command directory finishes', async () => {
    let releaseCommands: ((value: readonly unknown[]) => void) | undefined
    let releaseSkills: ((value: readonly unknown[]) => void) | undefined
    const commands = new Promise<readonly unknown[]>((resolve) => {
      releaseCommands = resolve
    })
    const skills = new Promise<readonly unknown[]>((resolve) => {
      releaseSkills = resolve
    })
    const client = new StartupClient((request) => {
      if (request.type === 'command.list') return commands
      if (request.type === 'skill.list') return skills
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    let settled = false
    const initialization = store.initialize().then(() => {
      settled = true
    })

    await vi.waitFor(() =>
      expect(client.requests.some((request) => request.type === 'session.open')).toBe(true),
    )
    expect(store.activeSessionId).toBe('session-active')
    expect(settled).toBe(true)

    releaseCommands?.([])
    releaseSkills?.([])
    await initialization
    store.dispose()
  })

  it('coalesces a burst of host state updates without losing the final state', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    const listener = vi.fn()
    store.subscribe(listener)

    client.emit({
      type: 'event',
      name: 'connection.snapshot',
      sequence: 1,
      payload: { kind: 'discovering' },
    })
    client.emit({
      type: 'event',
      name: 'connection.snapshot',
      sequence: 2,
      payload: { kind: 'connecting' },
    })

    expect(store.backend).toEqual({ kind: 'connecting' })
    expect(listener).not.toHaveBeenCalled()
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    expect(listener).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it('does not wake subscribers for conversation events from an inactive session', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    const listener = vi.fn()
    store.subscribe(listener)

    client.emit({
      type: 'event',
      name: 'message.delta',
      sequence: 1,
      payload: { sessionId: 'session-not-active', messageId: 'assistant-1', delta: 'ignored' },
    })
    client.emit({
      type: 'event',
      name: 'message.user',
      sequence: 2,
      payload: { sessionId: 'session-not-active', messageId: 'user-1', markdown: 'ignored' },
    })

    await new Promise((resolve) => window.setTimeout(resolve, 24))
    expect(listener).not.toHaveBeenCalled()
    expect(store.timeline.nodes).toHaveLength(0)
    store.dispose()
  })

  it('does not wake subscribers for metadata from an inactive session', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.initialize()
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    const listener = vi.fn()
    store.subscribe(listener)

    client.emit({
      type: 'event',
      name: 'session.status',
      sequence: 1,
      payload: { sessionId: 'session-not-active', status: 'running' },
    })
    client.emit({
      type: 'event',
      name: 'session.activity',
      sequence: 2,
      payload: { sessionId: 'session-not-active', updatedAt: Date.parse('2026-08-21T08:05:00.000Z') },
    })
    client.emit({
      type: 'event',
      name: 'session.title',
      sequence: 3,
      payload: { sessionId: 'session-not-active', title: 'Not loaded' },
    })

    await new Promise((resolve) => window.setTimeout(resolve, 24))
    expect(listener).not.toHaveBeenCalled()
    store.dispose()
  })

  it('does not notify subscribers when a guarded refresh keeps the same state object', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    const listener = vi.fn()
    store.subscribe(listener)

    await store.refreshCommands('session-not-active')
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(listener).not.toHaveBeenCalled()
    store.dispose()
  })

  it('does not notify subscribers for an unchanged session projection value', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)

    const value = { turns: 1 }
    client.emit({
      type: 'event',
      name: 'session.projection',
      sequence: 1,
      payload: { sessionId: 'session-active', key: 'sessionStats', value },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    const projection = store.projections['session-active']
    expect(projection).toBeDefined()
    expect(projection?.sessionStats).toBe(value)
    const listener = vi.fn()
    store.subscribe(listener)
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    listener.mockClear()

    client.emit({
      type: 'event',
      name: 'session.projection',
      sequence: 2,
      payload: { sessionId: 'session-active', key: 'sessionStats', value },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.projections['session-active']).toBe(projection)
    expect(listener).not.toHaveBeenCalled()
    store.dispose()
  })

  it('does not notify when a projection title repeats the current session title', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.initialize()
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    const listener = vi.fn()
    store.subscribe(listener)

    client.emit({
      type: 'event',
      name: 'session.projection',
      sequence: 1,
      payload: { sessionId: 'session-active', key: 'title', value: activeSession.title },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    listener.mockClear()
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    const projection = store.projections['session-active']

    client.emit({
      type: 'event',
      name: 'session.projection',
      sequence: 2,
      payload: { sessionId: 'session-active', key: 'title', value: activeSession.title },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.projections['session-active']).toBe(projection)
    expect(listener).not.toHaveBeenCalled()
    store.dispose()
  })

  it('flushes live history once with the coalesced host notification', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.initialize()
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    const listener = vi.fn()
    store.subscribe(listener)
    client.emit({
      type: 'event',
      name: 'message.delta',
      sequence: 1,
      payload: { sessionId: 'session-active', sequence: 1, messageId: 'assistant-1', delta: 'a' },
    })
    client.emit({
      type: 'event',
      name: 'message.delta',
      sequence: 2,
      payload: { sessionId: 'session-active', sequence: 2, messageId: 'assistant-1', delta: 'b' },
    })

    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant-1', markdown: 'ab', streaming: true }),
    )
    expect(store.history).toHaveLength(0)
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    expect(store.history.map((entry) => entry.sequence)).toEqual([1, 2])
    expect(listener).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it('notifies for history appended by an otherwise unchanged event', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.initialize()
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    const value = { turns: 1 }
    client.emit({
      type: 'event',
      name: 'session.projection',
      sequence: 1,
      payload: { sessionId: 'session-active', sequence: 1, key: 'sessionStats', value },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    const listener = vi.fn()
    store.subscribe(listener)
    client.emit({
      type: 'event',
      name: 'session.projection',
      sequence: 2,
      payload: { sessionId: 'session-active', sequence: 2, key: 'sessionStats', value },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.history.map((entry) => entry.sequence)).toEqual([1, 2])
    expect(listener).toHaveBeenCalledTimes(1)
    store.dispose()
  })

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

  it('does not apply a partially malformed session configuration patch', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.initialize()

    const configuration = store.configuration
    client.emit({
      type: 'event',
      name: 'session.configuration',
      sequence: 1,
      payload: {
        sessionId: 'session-active',
        patch: { model: { providerId: 3, modelId: 'wrong-provider-shape' } },
      },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.configuration).toBe(configuration)
    expect(store.configuration).toMatchObject({
      model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    })
    store.dispose()
  })

  it('opens a durable workspace session when the session summary projection is temporarily empty', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'session.list') return { items: [] }
      if (request.type === 'workspace.list') return { items: [workspace] }
      if (request.type === 'session.open')
        return {
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
        }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()

    expect(store.activeSessionId).toBe('session-blank')
    expect(client.requests).toContainEqual(
      expect.objectContaining({ type: 'session.open', payload: { sessionId: 'session-blank' } }),
    )
    store.dispose()
  })

  it('retries startup restoration when a later workspace refresh reveals a session', async () => {
    let visible = false
    const client = new StartupClient((request) => {
      if (request.type === 'session.list') return visible ? { items: [activeSession] } : { items: [] }
      if (request.type === 'workspace.list')
        return visible
          ? {
              items: [
                {
                  ...workspace,
                  sessionIds: [activeSession.id],
                  sessionCount: 1,
                },
              ],
            }
          : { items: [] }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()
    expect(store.activeSessionId).toBeUndefined()

    visible = true
    client.emit({
      type: 'event',
      name: 'workspace.changed',
      sequence: 1,
      payload: {},
    })

    await vi.waitFor(() => expect(store.activeSessionId).toBe('session-active'))
    expect(client.requests.filter((request) => request.type === 'session.open')).toHaveLength(1)
    store.dispose()
  })

  it('keeps sorted history on the zero-copy hydration path and reorders an out-of-order page', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'session.open')
        return {
          ...activeSession,
          history: [
            {
              sequence: 2,
              event: {
                type: 'message.user',
                sessionId: activeSession.id,
                messageId: 'user-2',
                markdown: 'second',
              },
            },
            {
              sequence: 1,
              event: {
                type: 'message.user',
                sessionId: activeSession.id,
                messageId: 'user-1',
                markdown: 'first',
              },
            },
          ],
          permissionPresets: ['workspace-write'],
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

    await store.openSession(activeSession.id)

    expect(store.timeline.nodes.map((node) => node.id)).toEqual(['user-1', 'user-2'])
    expect(store.history.map((entry) => entry.sequence)).toEqual([1, 2])
    store.dispose()
  })

  it('keeps distinct same-sequence projection records during a replay merge', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'session.open')
        return {
          ...activeSession,
          history: [
            {
              sequence: 1,
              event: {
                type: 'message.user',
                sessionId: activeSession.id,
                messageId: 'user-1',
                markdown: 'inspect the repository',
              },
            },
          ],
          permissionPresets: ['workspace-write'],
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
    await store.openSession(activeSession.id)

    const emitProjection = (key: string, value: unknown): void => {
      client.emit({
        type: 'event',
        name: 'session.projection',
        sequence: 10_000 + (key === 'tokenUsage' ? 1 : 2),
        payload: {
          type: 'session.projection',
          sessionId: activeSession.id,
          key,
          value,
          sequence: 2,
        },
      })
    }
    emitProjection('tokenUsage', { outputTokens: 2 })
    emitProjection('contextPressure', { pressureTokens: 12 })
    // An exact replay is safe to deduplicate, but it must not erase the other
    // record that shares the same durable sequence.
    emitProjection('tokenUsage', { outputTokens: 2 })
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.history.filter((entry) => entry.sequence === 2)).toHaveLength(2)
    expect(
      store.history
        .filter((entry) => entry.sequence === 2)
        .map((entry) => (entry.event.type === 'session.projection' ? entry.event.key : undefined)),
    ).toEqual(['tokenUsage', 'contextPressure'])
    expect(store.projections[activeSession.id]).toMatchObject({
      tokenUsage: { outputTokens: 2 },
      contextPressure: { pressureTokens: 12 },
    })
    store.dispose()
  })

  it('publishes the session history before advisory open reads finish', async () => {
    let releaseQueue: ((value: readonly unknown[]) => void) | undefined
    const queue = new Promise<readonly unknown[]>((resolve) => {
      releaseQueue = resolve
    })
    const client = new StartupClient((request) => {
      if (request.type === 'session.queue.list') return queue
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    let settled = false
    const opening = store.openSession('session-active').then(() => {
      settled = true
    })

    await vi.waitFor(() => expect(store.activeSessionId).toBe('session-active'))
    expect(store.timeline.sessionId).toBe('session-active')
    expect(settled).toBe(true)

    releaseQueue?.([])
    await opening
    expect(settled).toBe(true)
    store.dispose()
  })

  it('completes session open before command and session-model directories finish', async () => {
    let releaseCommands: ((value: readonly unknown[]) => void) | undefined
    let releaseSkills: ((value: readonly unknown[]) => void) | undefined
    let releaseSessionModels: ((value: { readonly models: readonly unknown[] }) => void) | undefined
    const commands = new Promise<readonly unknown[]>((resolve) => {
      releaseCommands = resolve
    })
    const skills = new Promise<readonly unknown[]>((resolve) => {
      releaseSkills = resolve
    })
    const sessionModels = new Promise<{ readonly models: readonly unknown[] }>((resolve) => {
      releaseSessionModels = resolve
    })
    const client = new StartupClient((request) => {
      if (request.type === 'command.list') return commands
      if (request.type === 'skill.list') return skills
      if (request.type === 'models.session.list') return sessionModels
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    let settled = false
    const opening = store.openSession('session-active').then(() => {
      settled = true
    })

    await vi.waitFor(() => expect(store.activeSessionId).toBe('session-active'))
    expect(settled).toBe(true)
    expect(client.requests.some((request) => request.type === 'command.list')).toBe(true)
    expect(client.requests.some((request) => request.type === 'skill.list')).toBe(true)
    expect(client.requests.some((request) => request.type === 'models.session.list')).toBe(true)

    releaseCommands?.([])
    releaseSkills?.([])
    releaseSessionModels?.({ models: [] })
    await opening
    await vi.waitFor(() => expect(store.commands.some((command) => command.name === 'model')).toBe(true))
    expect(store.sessionModels).toEqual([])
    store.dispose()
  })

  it('preserves a skill whenToUse hint when building the command directory', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'command.list') return []
      if (request.type === 'skill.list')
        return [
          {
            id: 'code-review',
            name: 'code-review',
            description: 'Review changes.',
            whenToUse: 'Use for focused review requests.',
            source: 'project',
            enabled: true,
          },
        ]
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession('session-active')
    await vi.waitFor(() =>
      expect(store.commands.find((command) => command.name === 'code-review')).toMatchObject({
        whenToUse: 'Use for focused review requests.',
      }),
    )
    store.dispose()
  })

  it('does not publish a partial command directory when a returned row is malformed', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'command.list')
        return [
          { name: 'valid-command', description: 'Valid command.' },
          { name: 'broken-command', description: 3 },
        ]
      if (request.type === 'skill.list')
        return [
          {
            id: 'valid-skill',
            name: 'valid-skill',
            description: 'Valid skill.',
            source: 'project',
            enabled: true,
          },
          {
            id: 'broken-skill',
            name: '',
            description: 'Broken skill.',
            source: 'project',
            enabled: true,
          },
        ]
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession('session-active')
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(store.commands).toEqual([])
    store.dispose()
  })

  it('opens the remembered session before global catalogs finish loading', async () => {
    let releaseProviders: ((value: readonly unknown[]) => void) | undefined
    const providers = new Promise<readonly unknown[]>((resolve) => {
      releaseProviders = resolve
    })
    const client = new StartupClient((request) => {
      if (request.type === 'providers.list') return providers
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)
    let settled = false
    const initialization = store.initialize().then(() => {
      settled = true
    })

    await vi.waitFor(() => expect(store.activeSessionId).toBe('session-active'))
    expect(client.requests.some((request) => request.type === 'providers.list')).toBe(true)
    expect(settled).toBe(true)
    expect(store.timeline.sessionId).toBe('session-active')

    releaseProviders?.([])
    await initialization
    expect(settled).toBe(true)
    store.dispose()
  })

  it('keeps the last workspace snapshot when a refresh temporarily fails', async () => {
    let failWorkspaceList = false
    const client = new StartupClient((request) => {
      if (request.type === 'workspace.list') {
        if (failWorkspaceList) return Promise.reject(new Error('workspace list unavailable'))
        return { items: [workspace] }
      }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()
    expect(store.workspaces).toHaveLength(1)

    failWorkspaceList = true
    await store.refreshSessions()

    expect(store.workspaces).toEqual([workspace])
    store.dispose()
  })

  it('keeps session rows unique when a refresh snapshot repeats an id', async () => {
    const duplicate = { ...activeSession, title: 'Repeated projection' }
    const client = new StartupClient((request) => {
      if (request.type === 'session.list') return { items: [activeSession, duplicate] }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.refreshSessions()

    expect(store.sessions).toEqual([activeSession])
    store.dispose()
  })

  it('does not partially apply malformed session or workspace snapshots', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'session.list')
        return { items: [activeSession, { ...activeSession, id: 'malformed', status: 'future' }] }
      if (request.type === 'workspace.list')
        return {
          items: [workspace, { ...workspace, id: 'malformed', sessionCount: -1 }],
          archivedSessionIds: [],
        }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.refreshSessions()

    expect(store.sessions).toEqual([])
    expect(store.workspaces).toEqual([])
    store.dispose()
  })

  it('reuses unchanged session and workspace snapshots across refreshes', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'workspace.list') return { items: [workspace] }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.refreshSessions()
    const sessions = store.sessions
    const workspaces = store.workspaces
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    const listener = vi.fn()
    store.subscribe(listener)
    await store.refreshSessions()
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.sessions).toBe(sessions)
    expect(store.workspaces).toBe(workspaces)
    expect(listener).not.toHaveBeenCalled()
    store.dispose()
  })

  it('maps semantic workflow profiles to the advertised plan command without inventing a command', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'command.list')
        return [{ name: 'plan', description: 'Toggle plan mode', source: 'builtin' }]
      if (request.type === 'command.execute') return { kind: 'success' }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()
    await expect(store.setPromptMode('plan')).resolves.toBe(true)
    await expect(store.setPromptMode('review')).resolves.toBe(true)

    const commandRequests = client.requests.filter(
      (request): request is Extract<WebviewRequest, { readonly type: 'command.execute' }> =>
        request.type === 'command.execute',
    )
    expect(commandRequests.map((request) => request.payload.command)).toEqual(['/plan', '/plan off'])
    expect(store.promptMode).toBe('review')
    expect(store.configuration?.planMode).toBe(false)
    store.dispose()
  })

  it('applies alpha session activity timestamps without allowing an older event to reorder the list', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()
    client.emit({
      type: 'event',
      name: 'session.activity',
      sequence: 1,
      payload: { sessionId: 'session-active', updatedAt: Date.parse('2026-08-22T08:05:00.000Z') },
    })
    expect(store.sessions.find((session) => session.id === 'session-active')?.updatedAt).toBe(
      '2026-08-22T08:05:00.000Z',
    )

    client.emit({
      type: 'event',
      name: 'session.activity',
      sequence: 2,
      payload: { sessionId: 'session-active', updatedAt: Date.parse('2026-08-21T08:00:00.000Z') },
    })
    expect(store.sessions.find((session) => session.id === 'session-active')?.updatedAt).toBe(
      '2026-08-22T08:05:00.000Z',
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

  it('does not notify when the model catalog refresh is unchanged', async () => {
    const provider = { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', configurable: false, fields: [] }
    const model = {
      id: 'deepseek-chat',
      providerId: 'deepseek',
      label: 'DeepSeek Chat',
      supportsReasoning: false,
    }
    const client = new StartupClient((request) => {
      if (request.type === 'providers.list') return [provider]
      if (request.type === 'models.list') return [model]
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.refreshModelCatalog()
    await new Promise((resolve) => window.setTimeout(resolve, 24))
    const providers = store.providers
    const models = store.models
    const listener = vi.fn()
    store.subscribe(listener)

    await store.refreshModelCatalog()
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.providers).toBe(providers)
    expect(store.models).toBe(models)
    expect(listener).not.toHaveBeenCalled()
    store.dispose()
  })

  it('keeps valid live providers when one upstream directory row is malformed', async () => {
    const liveProvider = {
      id: 'deepseek-official',
      name: 'DeepSeek',
      kind: 'llm-deepseek',
      configurable: true,
      active: true,
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      fields: [],
    }
    const malformedProvider = {
      id: 'broken-catalog-row',
      name: 'Broken catalog row',
      kind: 'llm-pi-ai',
      configurable: true,
      fields: [{ key: 'api', label: 'API', secret: false, required: 'yes' }],
    }
    const client = new StartupClient((request) => {
      if (request.type === 'providers.list') return [liveProvider, malformedProvider]
      if (request.type === 'models.list') return []
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.refreshModelCatalog()

    expect(store.providers).toEqual([liveProvider])
    store.dispose()
  })
})
