import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import { Alpha211VersionAdapter } from '@dsh-vscode/dsh-adapter'
import { hostMessageSchema, type HostMessage } from '@dsh-vscode/webview-protocol'
import { createHostEventPipeline, type HostEventPipelineDependencies } from './host-event-pipeline.js'

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }))

class PreparationAdapter extends Alpha211VersionAdapter {
  public normalizer(): (value: unknown) => BackendEvent | undefined {
    return this.createSessionEventNormalizer()
  }
}

describe('alpha211 Adapter to Host preparation boundary', () => {
  it('uses one read per attempt, projects only owned relative paths and preserves serialized event order', async () => {
    const root = path.resolve('fixture-workspace')
    const get = vi.fn(() => Promise.resolve({ cwd: root }))
    const backend = { sessions: { get } } as unknown as DshBackend
    const posted: HostMessage[] = []
    const pipeline = createHostEventPipeline({
      post: (message: Parameters<HostEventPipelineDependencies['post']>[0]) => {
        posted.push(hostMessageSchema.parse(message))
        return Promise.resolve(true)
      },
      currentWorkspaceFolders: () => [{ uri: { fsPath: root } }],
      temporaryWorkspaceManager: {},
      backendService: { requireBackend: () => backend },
      runtimeUpdateProgress: {},
    } as unknown as HostEventPipelineDependencies)
    const normalize = new PreparationAdapter({
      requestTimeoutMs: 1000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: globalThis.fetch,
    }).normalizer()
    const raw = (index: number, argumentsDelta: string): unknown => ({
      type: 'session/assistant-stream',
      sessionId: 's1',
      frame: {
        type: 'chunk',
        attemptId: 'a1',
        index,
        turn: 1,
        step: 1,
        chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'write', argumentsDelta },
      },
    })
    const first = normalize(
      raw(
        0,
        JSON.stringify({
          file_path: path.join(root, 'src', 'test.ts'),
          description: 'token=fixture-secret',
          content: 'PRIVATE_BODY',
        }).slice(0, -2),
      ),
    )
    const second = normalize(raw(1, '"}'))
    if (first === undefined || second === undefined) throw new Error('missing typed preparation')
    await Promise.all([pipeline.postBackendEvent(backend, first), pipeline.postBackendEvent(backend, second)])
    expect(get).toHaveBeenCalledTimes(1)
    expect(posted.map((message) => (message.type === 'event' ? message.sequence : -1))).toEqual([1, 2])
    expect(posted[1]).toMatchObject({
      payload: { filePath: 'src/test.ts', description: 'token=[redacted]', contentCharacters: 12 },
    })
    const text = JSON.stringify(posted)
    expect(text).not.toContain(root)
    expect(text).not.toContain('PRIVATE_BODY')
    expect(text).not.toContain('fixture-secret')
    expect(text).not.toContain('argumentsDelta')
    if (second.type !== 'tool.preparing') throw new Error('missing preparation')
    await pipeline.postBackendEvent(backend, { ...second, filePath: path.resolve(root, '..', 'private.txt') })
    expect(posted.at(-1)).not.toHaveProperty('payload.filePath')
    await pipeline.postBackendEvent(backend, {
      type: 'session.subscribed',
      sessionId: 's1',
      lastSequence: 2,
      controlBaseline: false,
    })
    await pipeline.postBackendEvent(backend, second)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('keeps the preview usable when session scope lookup fails or no workspace is owned', async () => {
    const get = vi.fn(() => Promise.reject(new Error('scope unavailable')))
    const backend = { sessions: { get } } as unknown as DshBackend
    const posted: HostMessage[] = []
    const pipeline = createHostEventPipeline({
      post: (message: Parameters<HostEventPipelineDependencies['post']>[0]) => {
        posted.push(hostMessageSchema.parse(message))
        return Promise.resolve(true)
      },
      currentWorkspaceFolders: () => [],
      temporaryWorkspaceManager: {},
      runtimeUpdateProgress: {},
      backendService: { requireBackend: () => backend },
    } as unknown as HostEventPipelineDependencies)
    await pipeline.postBackendEvent(backend, {
      type: 'tool.preparing',
      sessionId: 's1',
      callId: 'c1',
      toolName: 'read',
      attemptId: 'a1',
      turn: 1,
      step: 1,
      updateIndex: 0,
      filePath: path.resolve('outside.txt'),
      description: 'Inspect file',
    })
    expect(posted[0]).toMatchObject({ payload: { description: 'Inspect file' } })
    expect(posted[0]).not.toHaveProperty('payload.filePath')
  })

  it('drops a previous backend preview if its scope read settles after connection replacement', async () => {
    let resolve!: (value: { cwd: string }) => void
    const cwd = new Promise<{ cwd: string }>((finish) => {
      resolve = finish
    })
    const get = vi.fn(() => cwd)
    const backend = { sessions: { get } } as unknown as DshBackend
    let current = backend
    const post = vi.fn(() => Promise.resolve(true))
    const pipeline = createHostEventPipeline({
      post,
      currentWorkspaceFolders: () => [],
      temporaryWorkspaceManager: {},
      runtimeUpdateProgress: {},
      backendService: { requireBackend: () => current },
    } as unknown as HostEventPipelineDependencies)
    const pending = pipeline.postBackendEvent(backend, {
      type: 'tool.preparing',
      sessionId: 's1',
      callId: 'c1',
      toolName: 'read',
      attemptId: 'a1',
      turn: 1,
      step: 1,
      updateIndex: 0,
      filePath: 'src/file.ts',
    })
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
    current = {} as DshBackend
    resolve({ cwd: path.resolve('fixture-workspace') })
    await pending
    expect(post).not.toHaveBeenCalled()
  })
})
