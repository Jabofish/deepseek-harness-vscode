// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

class StartupClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(
    private readonly respond: (request: WebviewRequest) => unknown = startupResponse,
    private readonly connectOnReady = true,
  ) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    if (request.type === 'app.ready' && this.connectOnReady)
      this.emit({ type: 'event', name: 'connection.snapshot', sequence: 0, payload: { kind: 'connected' } })
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

// The Webview reload case: only the id survives in the persisted state, so the
// startup restore has to rebuild the view it names from the registry.
const persisted: { state: unknown } = { state: undefined }
vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: () => undefined,
  getState: () => persisted.state,
  setState: (next: unknown) => {
    persisted.state = next
  },
}))

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
      return {
        models: [],
        failures: [],
        current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        routable: true,
      }
    default:
      throw new Error(`unexpected startup request ${request.type}`)
  }
}

describe('AppStore startup session restoration', () => {
  it('replays safe connection output from snapshots and accepts live replacement without changing backend state', () => {
    const client = new StartupClient(startupResponse, false)
    const store = createAppStore(client as unknown as ProtocolClient)
    const entry = {
      id: 1,
      time: '2026-10-18T05:00:00.000Z',
      elapsedMs: 0,
      phase: 'connect',
      status: 'started',
      mode: 'auto',
    }
    try {
      client.emit({
        type: 'event',
        name: 'connection.snapshot',
        sequence: 1,
        payload: { kind: 'connecting', phase: 'verification', output: [entry] },
      })
      expect(store.getState().connectionOutput).toEqual([entry])
      const backend = store.getState().backend
      const result = { ...entry, id: 2, phase: 'discovery', status: 'succeeded', count: 2 }
      client.emit({ type: 'event', name: 'connection.output', sequence: 2, payload: [entry, result] })
      expect(store.getState().connectionOutput).toEqual([entry, result])
      expect(store.getState().backend).toBe(backend)
      client.emit({
        type: 'event',
        name: 'connection.output',
        sequence: 3,
        payload: [{ ...result, token: 'private' }],
      })
      expect(store.getState().connectionOutput).toEqual([entry, result])
      client.emit({ type: 'event', name: 'connection.output', sequence: 4, payload: [] })
      expect(store.getState().connectionOutput).toEqual([])
    } finally {
      store.dispose()
    }
  })

  it('waits for the connected snapshot before restoring and opens once across duplicate snapshots', async () => {
    const client = new StartupClient(startupResponse, false)
    const store = createAppStore(client as unknown as ProtocolClient)
    try {
      await store.initialize()
      expect(store.activeSessionId).toBeUndefined()
      expect(client.requests.filter((request) => request.type === 'session.open')).toHaveLength(0)
      for (const sequence of [1, 2])
        client.emit({
          type: 'event',
          name: 'connection.snapshot',
          sequence,
          payload: { kind: 'connected', backendInstanceId: 'fixture', connectionGeneration: 1 },
        })
      await vi.waitFor(() => expect(store.activeSessionId).toBe(activeSession.id))
      expect(client.requests.filter((request) => request.type === 'session.open')).toHaveLength(1)
    } finally {
      store.dispose()
    }
  })

  afterEach(() => {
    persisted.state = undefined
    document.body.replaceChildren()
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

  it('consumes the ordered Host window without frontend sorting', async () => {
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
                markdown: 'first',
              },
            },
            {
              sequence: 2,
              event: {
                type: 'message.user',
                sessionId: activeSession.id,
                messageId: 'user-2',
                markdown: 'second',
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
    expect(store.getState()).not.toHaveProperty('history')
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

  it('keeps a provider-local failure alongside the models that did load', async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'models.session.list')
        return {
          models: [
            { id: 'deepseek-chat', providerId: 'deepseek', label: 'DeepSeek Chat', supportsReasoning: false },
          ],
          failures: [{ providerId: 'gateway', providerName: 'Gateway', message: 'connection refused' }],
          current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          routable: true,
        }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession('session-active')

    await vi.waitFor(() => expect(store.sessionModels).toHaveLength(1))
    expect(store.sessionModelFailures).toEqual([
      { providerId: 'gateway', providerName: 'Gateway', message: 'connection refused' },
    ])
    store.dispose()
  })

  it("keeps the host's verdict that the session model is unroutable", async () => {
    const client = new StartupClient((request) => {
      if (request.type === 'models.session.list')
        return {
          models: [
            { id: 'deepseek-chat', providerId: 'deepseek', label: 'DeepSeek Chat', supportsReasoning: false },
          ],
          failures: [],
          current: { providerId: 'retired', modelId: 'retired-chat', reasoningLevel: 'high' },
          routable: false,
        }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession('session-active')
    await vi.waitFor(() => expect(store.sessionModelRoutable).toBe(false))

    // The verdict says nothing about the groups: a directory can list models
    // and still name a current selection no adapter serves. The selection still
    // has to travel — it is what the seat states and what an unroutable warning
    // is about.
    expect(store.sessionModels).toHaveLength(1)
    expect(store.sessionModelCurrent).toEqual({
      providerId: 'retired',
      modelId: 'retired-chat',
      reasoningLevel: 'high',
    })
    store.dispose()
  })

  it('keeps the last good directory when a later read is refused and replaces it on the retry', async () => {
    let refused = false
    let label = 'DeepSeek Chat'
    const client = new StartupClient((request) => {
      if (request.type === 'models.session.list') {
        if (refused) throw new Error('host busy attaching the workspace')
        return {
          models: [{ id: 'deepseek-chat', providerId: 'deepseek', label, supportsReasoning: false }],
          failures: [],
          current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          routable: true,
        }
      }
      return startupResponse(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession('session-active')
    await vi.waitFor(() => expect(store.sessionModels).toHaveLength(1))

    refused = true
    client.emit({
      type: 'event',
      name: 'remote.event',
      sequence: 9,
      payload: { name: 'llm/adapters-updated', args: [] },
    })
    await vi.waitFor(() => expect(store.sessionModelDirectoryError).toBe('host busy attaching the workspace'))

    // The rows an earlier read stated survive the refusal: dropping them would
    // move the seat onto the global fallback for a read that may succeed next.
    expect(store.sessionModels).toHaveLength(1)

    refused = false
    label = 'DeepSeek Chat (repaired)'
    await store.refreshSessionModels()

    expect(store.sessionModelDirectoryError).toBeUndefined()
    expect(store.sessionModels[0]?.label).toBe('DeepSeek Chat (repaired)')
    store.dispose()
  })
})

it('keeps the permission roster fail-closed on failure and ignores superseded reads', async () => {
  const pending: Array<(value: unknown) => void> = []
  let invalidating = false
  const client = new StartupClient((request) => {
    if (request.type === 'session.open')
      return { ...(startupResponse(request) as object), permissionPresets: ['auto'] }
    if (request.type !== 'permissions.presets.list') return startupResponse(request)
    if (!invalidating) return ['auto']
    return new Promise<unknown>((resolve) => pending.push(resolve))
  })
  const store = createAppStore(client as unknown as ProtocolClient)
  await store.openSession('session-active')
  invalidating = true
  const invalidate = (sequence: number): void =>
    client.emit({
      type: 'event',
      name: 'remote.event',
      sequence,
      payload: { name: 'permission-presets/catalog-changed', args: [] },
    })
  invalidate(100)
  expect(store.permissionPresets).toEqual([])
  invalidate(101)
  pending[1]?.(['workspace-write'])
  await vi.waitFor(() => expect(store.permissionPresets).toEqual(['workspace-write']))
  pending[0]?.(['auto'])
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  expect(store.permissionPresets).toEqual(['workspace-write'])
  invalidate(102)
  pending[2]?.({})
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  expect(store.permissionPresets).toEqual([])
  store.dispose()
})

it('tracks background-session questions and clears them on resolution and subscription reset', async () => {
  const client = new StartupClient(startupResponse)
  const store = createAppStore(client as unknown as ProtocolClient)
  await store.openSession('session-active')
  const question = {
    id: 'q-background',
    sessionId: 'session-other',
    prompt: 'Continue?',
    allowFreeText: true,
  }
  client.emit({ type: 'event', name: 'question.requested', sequence: 100, payload: { question } })
  expect(store.questions).toEqual([question])
  client.emit({
    type: 'event',
    name: 'question.resolved',
    sequence: 101,
    payload: { sessionId: 'session-other', questionId: question.id },
  })
  expect(store.questions).toEqual([])
  client.emit({ type: 'event', name: 'question.requested', sequence: 102, payload: { question } })
  client.emit({
    type: 'event',
    name: 'session.subscribed',
    sequence: 103,
    payload: { sessionId: 'session-other', lastSequence: 102 },
  })
  expect(store.questions).toEqual([])
  store.dispose()
})

it('does not resurrect a resolved batch when a delayed request is replayed', async () => {
  const client = new StartupClient(startupResponse)
  const store = createAppStore(client as unknown as ProtocolClient)
  await store.openSession('session-active')
  const question = {
    id: 'first',
    rpcId: 'rpc-batch',
    sessionId: 'session-active',
    prompt: 'First?',
    allowFreeText: true,
    items: [
      { id: 'first', prompt: 'First?', allowFreeText: true },
      { id: 'second', prompt: 'Second?', allowFreeText: true },
    ],
  }
  client.emit({ type: 'event', name: 'question.requested', sequence: 100, payload: { question } })
  client.emit({
    type: 'event',
    name: 'question.resolved',
    sequence: 101,
    payload: { sessionId: question.sessionId, questionRpcId: question.rpcId },
  })
  client.emit({ type: 'event', name: 'question.requested', sequence: 102, payload: { question } })
  expect(store.questions).toEqual([])
  store.dispose()
})
