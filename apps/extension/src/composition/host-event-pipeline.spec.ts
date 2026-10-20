import { describe, expect, it, vi } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import { createHostEventPipeline, type HostEventPipelineDependencies } from './host-event-pipeline.js'

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }))

function harness(
  respond: (message: HostMessage) => Promise<boolean>,
  postTo = vi.fn(() => Promise.resolve(true)),
): {
  readonly pipeline: ReturnType<typeof createHostEventPipeline>
  readonly posted: readonly HostMessage[]
} {
  const posted: HostMessage[] = []
  const pipeline = createHostEventPipeline({
    transcript: { accept: () => true, dispose: vi.fn() },
    post: (message: Parameters<HostEventPipelineDependencies['post']>[0]) => {
      posted.push(message as HostMessage)
      return respond(message as HostMessage)
    },
    postTo,
    backendService: { requireBackend: () => ({ connection: {} }) },
    diagnostics: { log: vi.fn(), connectionOutput: () => undefined },
    editorContextUseCases: {},
    featureOwner: () => ({}),
    currentWorkspaceFolders: () => [],
    temporaryWorkspaceManager: {},
    runtimeUpdateProgress: { current: vi.fn() },
  } as unknown as HostEventPipelineDependencies)
  return { pipeline, posted }
}

describe('Host event delivery', () => {
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
})
