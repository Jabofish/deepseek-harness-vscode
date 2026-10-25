import { describe, expect, it, vi } from 'vitest'
import type { FeatureHostMessage, HostMessage } from '@dsh-vscode/webview-protocol'
import { createHostEventPipeline, type HostEventPipelineDependencies } from './host-event-pipeline.js'

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }))

function harness(
  respond: (message: HostMessage | FeatureHostMessage) => Promise<boolean>,
  postTo = vi.fn(() => Promise.resolve(true)),
  editorContextUseCases: Record<string, unknown> = {},
): {
  readonly pipeline: ReturnType<typeof createHostEventPipeline>
  readonly posted: readonly (HostMessage | FeatureHostMessage)[]
} {
  const posted: (HostMessage | FeatureHostMessage)[] = []
  const pipeline = createHostEventPipeline({
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
})
