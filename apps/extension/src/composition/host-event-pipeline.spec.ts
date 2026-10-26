import { describe, expect, it, vi } from 'vitest'
import type { FeatureHostMessage, HostMessage } from '@dsh-vscode/webview-protocol'
import { createHostEventPipeline, type HostEventPipelineDependencies } from './host-event-pipeline.js'

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }))

function harness(
  respond: (message: HostMessage | FeatureHostMessage) => Promise<boolean>,
  postTo = vi.fn<HostEventPipelineDependencies['postTo']>(() => Promise.resolve(true)),
  editorContextUseCases: Record<string, unknown> = {},
  surfaceIds?: () => readonly string[],
): {
  readonly pipeline: ReturnType<typeof createHostEventPipeline>
  readonly posted: readonly (HostMessage | FeatureHostMessage)[]
} {
  const posted: (HostMessage | FeatureHostMessage)[] = []
  const pipeline = createHostEventPipeline({
    ...(surfaceIds === undefined ? {} : { surfaceIds }),
    transcript: { accept: () => true, dispose: vi.fn() },
    post: (message: Parameters<HostEventPipelineDependencies['post']>[0]) => {
      posted.push(message)
      return respond(message)
    },
    postTo,
    backendService: {
      requireBackend: () => ({
        connection: { backendInstanceId: 'backend-1', connectionGeneration: 1 },
      }),
    },
    diagnostics: { log: vi.fn(), connectionOutput: () => undefined },
    editorContextUseCases,
    featureOwner: () => ({}),
    currentWorkspaceFolders: () => [],
    temporaryWorkspaceManager: {},
    runtimeUpdateProgress: { current: vi.fn() },
  } as unknown as HostEventPipelineDependencies)
  return { pipeline, posted }
}

describe('Host event delivery', () => {
  it('uses independent consumer ACKs per surface in the production path', async () => {
    const posted: Array<{ surface: string; name: string; sequence: number; payload: unknown }> = []
    const postTo: HostEventPipelineDependencies['postTo'] = (surface, message) => {
      if (message.type === 'event') {
        posted.push({ surface, name: message.name, sequence: message.sequence, payload: message.payload })
        if (surface === 'fast') pipeline.acknowledgeEvents(surface, message.sequence)
      }
      return Promise.resolve(true)
    }
    const { pipeline } = harness(
      () => Promise.resolve(true),
      vi.fn(postTo),
      {},
      () => ['slow', 'fast'],
    )
    try {
      const pending = Array.from({ length: 1000 }, (_, index) =>
        pipeline.postEvent('session.status', { sessionId: 's', status: index }),
      )
      await pipeline.postEventTo('fast', 'question.requested', {})
      expect(
        posted.filter((frame) => frame.surface === 'fast' && frame.name === 'session.status').at(-1)?.payload,
      ).toMatchObject({ status: 999 })
      expect(posted).toContainEqual(expect.objectContaining({ surface: 'fast', name: 'question.requested' }))
      pipeline.forgetSurface('slow')
      await Promise.all(pending)
    } finally {
      pipeline.dispose()
    }
  })

  it('delivers text and control events while a different surface broadcast receipt is stalled', async () => {
    let release!: (value: boolean) => void
    const stalled = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const postTo = vi.fn(() => Promise.resolve(true))
    const { pipeline, posted } = harness(() => stalled, postTo)
    const first = pipeline.postEvent('session.status', {})
    await Promise.resolve()
    await pipeline.postEventTo('editor:healthy', 'session.transcript', {})
    await pipeline.postEventTo('editor:healthy', 'question.requested', {})
    expect(posted).toContainEqual(expect.objectContaining({ name: 'session.status' }))
    expect(postTo).toHaveBeenCalledWith(
      'editor:healthy',
      expect.objectContaining({ name: 'session.transcript' }),
    )
    expect(postTo).toHaveBeenCalledWith(
      'editor:healthy',
      expect.objectContaining({ name: 'question.requested' }),
    )
    release(true)
    await first
    await pipeline.postEventTo('editor:healthy', 'session.transcript.patch', {})
    expect(postTo).toHaveBeenCalledWith(
      'editor:healthy',
      expect.objectContaining({ name: 'session.transcript.patch' }),
    )
    pipeline.dispose()
  })
  it('recovers a targeted control failure only on that surface and bounds a failed recovery', async () => {
    const postTo = vi.fn(() => Promise.resolve(false))
    const { pipeline, posted } = harness(() => Promise.resolve(true), postTo)
    await expect(pipeline.postEventTo('editor:s1', 'connection.snapshot', {})).resolves.toBe(false)
    expect(postTo).toHaveBeenCalledWith('editor:s1', expect.objectContaining({ name: 'connection.snapshot' }))
    expect(postTo).toHaveBeenCalledWith('editor:s1', expect.objectContaining({ name: 'ui.resync' }))
    expect(posted).toEqual([])
    await pipeline.postEventTo('editor:s1', 'ui.resync', {})
    pipeline.dispose()
  })

  it('delivers the latest state for each key and retains permission requests when a panel is slow', async () => {
    let releaseFirst!: (value: boolean) => void
    let firstBlocked = true
    const posted: (HostMessage | FeatureHostMessage)[] = []
    const pipeline = createHostEventPipeline({
      transcript: { accept: () => false, dispose: vi.fn() },
      post: (message: Parameters<HostEventPipelineDependencies['post']>[0]) => {
        posted.push(message)
        if (firstBlocked) {
          firstBlocked = false
          return new Promise<boolean>((resolve) => {
            releaseFirst = resolve
          })
        }
        return Promise.resolve(true)
      },
      postTo: vi.fn<HostEventPipelineDependencies['postTo']>(() => Promise.resolve(true)),
      backendService: {
        requireBackend: () => ({
          connection: { backendInstanceId: 'backend-1', connectionGeneration: 1 },
        }),
      },
      diagnostics: { log: vi.fn(), connectionOutput: () => undefined },
      editorContextUseCases: {},
      featureOwner: () => ({}),
      currentWorkspaceFolders: () => [],
      temporaryWorkspaceManager: {},
      runtimeUpdateProgress: { current: vi.fn() },
    } as unknown as HostEventPipelineDependencies)

    const first = pipeline.postEvent('permission.requested', { id: 'p-1' })
    await Promise.resolve()

    // A slow panel receives interleaved updates for several state keys.
    const activity1 = pipeline.postEvent('session.activity', {
      type: 'session.activity',
      sessionId: 's-1',
      updatedAt: '2026-10-20T00:00:01Z',
    })
    const activity2 = pipeline.postEvent('session.activity', {
      type: 'session.activity',
      sessionId: 's-1',
      updatedAt: '2026-10-20T00:00:02Z',
    })
    const projTodoOld = pipeline.postEvent('session.projection', {
      type: 'session.projection',
      sessionId: 's-1',
      key: 'todoList',
      value: ['v1'],
      sequence: 10,
    })
    const projTodoNew = pipeline.postEvent('session.projection', {
      type: 'session.projection',
      sessionId: 's-1',
      key: 'todoList',
      value: ['v2'],
      sequence: 12,
    })
    // Stale sequence (11 < 12) must not overwrite sequence 12
    const projTodoStale = pipeline.postEvent('session.projection', {
      type: 'session.projection',
      sessionId: 's-1',
      key: 'todoList',
      value: ['v-stale'],
      sequence: 11,
    })
    const projPlan = pipeline.postEvent('session.projection', {
      type: 'session.projection',
      sessionId: 's-1',
      key: 'plan',
      value: { active: true },
      sequence: 13,
    })

    releaseFirst(true)
    await Promise.all([first, activity1, activity2, projTodoOld, projTodoNew, projTodoStale, projPlan])

    expect(posted).toContainEqual(
      expect.objectContaining({ name: 'permission.requested', payload: { id: 'p-1' } }),
    )
    expect(
      posted.findLast((message) => message.type === 'event' && message.name === 'session.activity'),
    ).toMatchObject({
      type: 'event',
      name: 'session.activity',
      payload: { sessionId: 's-1', updatedAt: '2026-10-20T00:00:02Z' },
    })
    expect(
      posted.findLast(
        (message) =>
          message.type === 'event' &&
          message.name === 'session.projection' &&
          (message.payload as { key?: string }).key === 'todoList',
      ),
    ).toMatchObject({
      type: 'event',
      name: 'session.projection',
      payload: { sessionId: 's-1', key: 'todoList', value: ['v2'], sequence: 12 },
    })
    expect(
      posted.findLast(
        (message) =>
          message.type === 'event' &&
          message.name === 'session.projection' &&
          (message.payload as { key?: string }).key === 'plan',
      ),
    ).toMatchObject({
      type: 'event',
      name: 'session.projection',
      payload: { sessionId: 's-1', key: 'plan', value: { active: true }, sequence: 13 },
    })
    pipeline.dispose()
  })

  it('narrows active-session-only backend events to matching surfaces and skips background sessions', async () => {
    const posted: (HostMessage | FeatureHostMessage)[] = []
    const postTo = vi.fn(() => Promise.resolve(true))
    let backend = {
      connection: { backendInstanceId: 'backend-1', connectionGeneration: 1 },
    }
    const pipeline = createHostEventPipeline({
      transcript: {
        accept: () => false,
        dispose: vi.fn(),
        surfacesForSession: (sessionId: string) => (sessionId === 's-visible' ? ['sidebar'] : []),
      },
      post: (message: Parameters<HostEventPipelineDependencies['post']>[0]) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      postTo,
      backendService: {
        requireBackend: () => backend,
      },
      diagnostics: { log: vi.fn(), connectionOutput: () => undefined },
      editorContextUseCases: {},
      featureOwner: () => ({}),
      currentWorkspaceFolders: () => [],
      temporaryWorkspaceManager: {},
      runtimeUpdateProgress: { current: vi.fn() },
    } as unknown as HostEventPipelineDependencies)

    await pipeline.postBackendEvent(backend as never, {
      type: 'jobs.updated',
      sessionId: 's-background',
      jobs: [],
    })
    expect(posted).toHaveLength(0)
    expect(postTo).not.toHaveBeenCalled()

    await pipeline.postBackendEvent(backend as never, {
      type: 'jobs.updated',
      sessionId: 's-visible',
      jobs: [],
    })
    expect(posted).toHaveLength(0)
    expect(postTo).toHaveBeenCalledWith(
      'sidebar',
      expect.objectContaining({ name: 'jobs.updated', sequence: 1 }),
    )
    // These background-session facts update the global switcher or settle
    // interactions. Restricting all projections to the opened session loses them.
    for (const key of ['title', 'sessionListMetadata', 'userQuestions']) {
      await pipeline.postBackendEvent(backend as never, {
        type: 'session.projection',
        sessionId: 's-background',
        key,
        value: null,
      })
    }
    for (const key of ['title', 'sessionListMetadata', 'userQuestions'])
      expect(posted).toContainEqual(
        expect.objectContaining({
          name: 'session.projection',
          payload: expect.objectContaining({ key }) as unknown,
        }),
      )
    expect(posted.every((message) => message.type === 'event' && message.name === 'session.projection')).toBe(
      true,
    )
    let release!: (delivered: boolean) => void
    postTo.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    )
    const oldBackend = pipeline.postBackendEvent(backend as never, {
      type: 'jobs.updated',
      sessionId: 's-visible',
      jobs: [],
      sequence: 100,
    })
    backend = { connection: { backendInstanceId: 'backend-2', connectionGeneration: 2 } }
    const newBackend = pipeline.postBackendEvent(backend as never, {
      type: 'jobs.updated',
      sessionId: 's-visible',
      jobs: [],
      sequence: 1,
    })
    await newBackend
    expect(postTo).toHaveBeenLastCalledWith(
      'sidebar',
      expect.objectContaining({
        name: 'jobs.updated',
        payload: expect.objectContaining({ sequence: 1 }) as unknown,
      }),
    )
    release(true)
    await oldBackend
    pipeline.dispose()
  })

  it('does not broadcast a global ui.resync when the bulk lane overflows', async () => {
    const releases: Array<(value: boolean) => void> = []
    const postTo = vi.fn<HostEventPipelineDependencies['postTo']>((_surfaceId, _message) => {
      return new Promise<boolean>((resolve) => {
        releases.push(resolve)
      })
    })
    const { pipeline, posted } = harness(() => Promise.resolve(true), postTo)

    const pending: Array<Promise<boolean>> = []
    for (let i = 0; i < 140; i += 1) {
      pending.push(pipeline.postEventTo('sidebar', 'session.transcript.patch', { revision: i + 1 }))
    }
    await Promise.resolve()
    while (releases.length > 0) releases.shift()?.(true)
    await Promise.all(pending)

    expect(posted.filter((msg) => msg.type === 'event' && msg.name === 'ui.resync')).toHaveLength(0)
    pipeline.dispose()
  })
})
