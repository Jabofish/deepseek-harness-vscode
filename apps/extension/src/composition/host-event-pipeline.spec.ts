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

function deferredAvailability(): {
  availability: ReturnType<typeof vi.fn>
  resolvers: Array<(value: { availableKinds: string[] }) => void>
} {
  const resolvers: Array<(value: { availableKinds: string[] }) => void> = []
  const availability = vi.fn(
    () =>
      new Promise<{ availableKinds: string[] }>((resolve) => {
        resolvers.push(resolve)
      }),
  )
  return { availability, resolvers }
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
      expect(new Set(pending).size).toBe(2)
      await pipeline.postEventTo('fast', 'question.requested', {})
      expect(posted.filter((frame) => frame.surface === 'slow')).toHaveLength(1)
      expect(posted.filter((frame) => frame.surface === 'fast').map((frame) => frame.name)).toEqual([
        'session.status',
        'session.status',
        'question.requested',
      ])
      expect(posted.filter((frame) => frame.surface === 'fast')[1]!.payload).toMatchObject({ status: 999 })
      pipeline.forgetSurface('slow')
      await Promise.all(pending)
    } finally {
      pipeline.dispose()
    }
  })
  it('retries unchanged availability after the renderer rejected its previous event', async () => {
    const availability = vi.fn().mockResolvedValue({ availableKinds: ['file'] })
    let delivered = false
    const { pipeline, posted } = harness(() => Promise.resolve(delivered), undefined, { availability })
    await pipeline.postEditorContextAvailabilityEvent()
    delivered = true
    await pipeline.postEditorContextAvailabilityEvent()
    expect(posted.filter((message) => message.type === 'feature.event')).toHaveLength(2)
    await pipeline.postEditorContextAvailabilityEvent()
    expect(posted.filter((message) => message.type === 'feature.event')).toHaveLength(2)
    pipeline.dispose()
  })

  it('publishes unchanged availability when a connection changes during the previous receipt', async () => {
    const availability = vi.fn().mockResolvedValue({ availableKinds: ['file'] })
    let release!: (value: boolean) => void
    const receipt = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const { pipeline, posted } = harness(
      (message) => Promise.resolve(message.type === 'feature.event' ? receipt : true),
      undefined,
      { availability },
    )
    const first = pipeline.postEditorContextAvailabilityEvent()
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    pipeline.publishState({ kind: 'idle' })
    const second = pipeline.postEditorContextAvailabilityEvent()
    release(true)
    await Promise.all([first, second])
    expect(posted.filter((message) => message.type === 'feature.event')).toHaveLength(2)
    pipeline.dispose()
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
    expect(posted[0]).toMatchObject({ sequence: 1 })
    expect(postTo.mock.calls).toEqual([
      ['editor:healthy', expect.objectContaining({ name: 'session.transcript', sequence: 2 })],
      ['editor:healthy', expect.objectContaining({ name: 'question.requested', sequence: 3 })],
    ])
    release(true)
    await first
    await pipeline.postEventTo('editor:healthy', 'session.transcript.patch', {})
    expect(postTo.mock.calls.at(-1)).toEqual(['editor:healthy', expect.objectContaining({ sequence: 4 })])
    pipeline.dispose()
  })
  it('recovers a targeted control failure only on that surface and bounds a failed recovery', async () => {
    const postTo = vi.fn(() => Promise.resolve(false))
    const { pipeline, posted } = harness(() => Promise.resolve(true), postTo)
    await expect(pipeline.postEventTo('editor:s1', 'connection.snapshot', {})).resolves.toBe(false)
    expect(postTo.mock.calls).toEqual([
      ['editor:s1', expect.objectContaining({ name: 'connection.snapshot', sequence: 1 })],
      ['editor:s1', expect.objectContaining({ name: 'ui.resync', sequence: 2 })],
    ])
    expect(posted).toEqual([])
    await pipeline.postEventTo('editor:s1', 'ui.resync', {})
    expect(postTo).toHaveBeenCalledTimes(3)
    pipeline.dispose()
  })

  it('consumes the sequence and resyncs after a control event is not delivered', async () => {
    let fail = true
    const { pipeline, posted } = harness((message) => {
      if (fail && message.type === 'event' && message.name !== 'ui.resync') {
        fail = false
        return Promise.resolve(false)
      }
      return Promise.resolve(true)
    })

    await expect(pipeline.postEvent('permission.requested', { id: 'p1' })).resolves.toBe(false)
    await vi.waitFor(() => expect(posted).toHaveLength(2))
    expect(posted[0]).toMatchObject({ name: 'permission.requested', sequence: 1 })
    // The dropped frame consumed its number; the recovery frame continues the
    // stream instead of reusing it.
    expect(posted[1]).toMatchObject({ name: 'ui.resync', sequence: 2 })

    await pipeline.postEvent('queue.updated', {})
    expect(posted.at(-1)).toMatchObject({ name: 'queue.updated', sequence: 3 })
    pipeline.dispose()
  })

  it('does not broadcast a resync for a failed bulk frame', async () => {
    const { pipeline, posted } = harness(() => Promise.resolve(false))

    await expect(pipeline.postEvent('runtime.update.progress', {})).resolves.toBe(false)
    await Promise.resolve()
    expect(posted.map((message) => (message.type === 'event' ? message.name : message.type))).toEqual([
      'runtime.update.progress',
    ])
    pipeline.dispose()
  })

  it('collapses a keystroke burst of availability triggers into one computation and one event', async () => {
    const { availability, resolvers } = deferredAvailability()
    const { pipeline, posted } = harness(() => Promise.resolve(true), undefined, {
      availability,
    })

    const runs = Array.from({ length: 5 }, () => pipeline.postEditorContextAvailabilityEvent())
    // The burst arrives while the first computation is still running.
    expect(availability).toHaveBeenCalledTimes(1)
    resolvers[0]!({ availableKinds: ['file'] })
    // The queued triggers demand exactly one trailing pass with the latest
    // editor state; that pass answers the same kinds and stays unpublished.
    await vi.waitFor(() => expect(availability).toHaveBeenCalledTimes(2))
    resolvers[1]!({ availableKinds: ['file'] })
    await Promise.all(runs)
    expect(availability).toHaveBeenCalledTimes(2)
    expect(
      posted.filter(
        (message): message is Extract<FeatureHostMessage, { type: 'feature.event' }> =>
          message.type === 'feature.event' && message.name === 'editor.context.availability.changed',
      ),
    ).toHaveLength(1)
    pipeline.dispose()
  })

  it('runs a trailing pass for state that changes during a run and publishes the latest kinds', async () => {
    const { availability, resolvers } = deferredAvailability()
    const { pipeline, posted } = harness(() => Promise.resolve(true), undefined, {
      availability,
    })

    const first = pipeline.postEditorContextAvailabilityEvent()
    const second = pipeline.postEditorContextAvailabilityEvent()
    expect(second).toBe(first)
    resolvers[0]!({ availableKinds: ['file'] })
    await vi.waitFor(() => expect(availability).toHaveBeenCalledTimes(2))
    // The trailing pass answers with the latest editor state.
    resolvers[1]!({ availableKinds: ['selection'] })
    await first
    const availabilityEvents = posted.filter(
      (message): message is Extract<FeatureHostMessage, { type: 'feature.event' }> =>
        message.type === 'feature.event' && message.name === 'editor.context.availability.changed',
    )
    expect(availabilityEvents).toHaveLength(2)
    expect(availabilityEvents.at(-1)).toMatchObject({
      availableKinds: ['selection'],
    })
    pipeline.dispose()
  })

  it('skips the renderer event while the availability kinds are unchanged', async () => {
    const { availability, resolvers } = deferredAvailability()
    const { pipeline, posted } = harness(() => Promise.resolve(true), undefined, {
      availability,
    })

    const first = pipeline.postEditorContextAvailabilityEvent()
    resolvers[0]!({ availableKinds: ['file'] })
    await first
    const second = pipeline.postEditorContextAvailabilityEvent()
    resolvers[1]!({ availableKinds: ['file'] })
    await second
    expect(availability).toHaveBeenCalledTimes(2)
    expect(
      posted.filter(
        (message): message is Extract<FeatureHostMessage, { type: 'feature.event' }> =>
          message.type === 'feature.event' && message.name === 'editor.context.availability.changed',
      ),
    ).toHaveLength(1)
    pipeline.dispose()
  })

  it('recovers the availability gate publication after a failed recompute', async () => {
    // First recompute fails (backend gone), a later one succeeds: the failed
    // run must not reject the poster's promise, and the next success must
    // still publish because the failure left the last kinds unknown.
    const availability = vi
      .fn<() => Promise<{ availableKinds: string[] }>>()
      .mockRejectedValueOnce(new Error('backend gone'))
      .mockResolvedValue({ availableKinds: ['file'] })
    const { pipeline, posted } = harness(() => Promise.resolve(true), undefined, {
      availability,
    })

    await pipeline.postEditorContextAvailabilityEvent()
    expect(
      posted.filter(
        (message) =>
          message.type === 'feature.event' && message.name === 'editor.context.availability.changed',
      ),
    ).toHaveLength(0)

    await pipeline.postEditorContextAvailabilityEvent()
    expect(
      posted.filter(
        (message) =>
          message.type === 'feature.event' && message.name === 'editor.context.availability.changed',
      ),
    ).toHaveLength(1)
    pipeline.dispose()
  })

  it('coalesces overwritable control snapshots by session, type, and key while in flight without delaying idle delivery or dropping authoritative Host callbacks', async () => {
    let releaseFirst!: (value: boolean) => void
    let firstBlocked = true
    const onEvent = vi.fn()
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
      onEvent,
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

    // 1. First event enters IPC immediately while idle
    const first = pipeline.postEvent('permission.requested', { id: 'p-1' })
    await Promise.resolve()
    expect(posted).toHaveLength(1)

    // 2. While first IPC is in flight, a burst of overwritable snapshots arrives
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

    // Authoritative Host listener received every event synchronously
    expect(onEvent).toHaveBeenCalledTimes(7)

    releaseFirst(true)
    await Promise.all([first, activity1, activity2, projTodoOld, projTodoNew, projTodoStale, projPlan])

    // Only 1 permission.requested + 1 coalesced session.activity + 1 coalesced todoList + 1 plan = 4 frames posted
    expect(posted).toHaveLength(4)
    expect(posted[1]).toMatchObject({
      type: 'event',
      name: 'session.activity',
      payload: { sessionId: 's-1', updatedAt: '2026-10-20T00:00:02Z' },
    })
    expect(posted[2]).toMatchObject({
      type: 'event',
      name: 'session.projection',
      payload: { sessionId: 's-1', key: 'todoList', value: ['v2'], sequence: 12 },
    })
    expect(posted[3]).toMatchObject({
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
    expect(postTo).toHaveBeenCalledTimes(1)
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
    expect(posted).toHaveLength(3)
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
    expect(postTo).toHaveBeenCalledTimes(3)
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
