import path from 'node:path'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import { Alpha211VersionAdapter } from '@dsh-vscode/dsh-adapter'
import { hostMessageSchema, type HostMessage, type TranscriptWindow } from '@dsh-vscode/webview-protocol'
import { TranscriptWindowService } from '../view/transcript-window.js'
import { sanitizePublicValue } from '../view/public-value.js'
import { createHostEventPipeline, type HostEventPipelineDependencies } from './host-event-pipeline.js'

vi.mock('vscode', () => ({ commands: { executeCommand: vi.fn() } }))

class PreparationAdapter extends Alpha211VersionAdapter {
  public normalizer(): (value: unknown) => BackendEvent | undefined {
    return this.createSessionEventNormalizer()
  }
}

function fixture(roots: readonly string[] = []): {
  get: Mock<() => unknown>
  backend: DshBackend
  posted: HostMessage[]
  transcript: TranscriptWindowService
  pipeline: ReturnType<typeof createHostEventPipeline>
  replace: () => void
  view: () => Promise<TranscriptWindow>
} {
  const get = vi.fn()
  const backend = { sessions: { get } } as unknown as DshBackend
  let current = backend
  const posted: HostMessage[] = []
  const transcript = new TranscriptWindowService({
    read: () => Promise.resolve({ events: [], hasMore: false }),
    publicValue: (value, cwd) => sanitizePublicValue(value, undefined, roots, cwd),
    post: () => Promise.resolve(true),
  })
  transcript.installPage(
    's1',
    {
      events: [],
      hasMore: false,
      projection: { asOfSequence: 0, values: roots.length === 0 ? {} : { workingDirectory: roots[0] } },
    },
    transcript.begin('s1'),
  )
  const pipeline = createHostEventPipeline({
    transcript,
    post: (message: Parameters<HostEventPipelineDependencies['post']>[0]) => {
      posted.push(hostMessageSchema.parse(message))
      return Promise.resolve(true)
    },
    currentWorkspaceFolders: () => roots.map((fsPath) => ({ uri: { fsPath } })),
    temporaryWorkspaceManager: {},
    runtimeUpdateProgress: {},
    backendService: { requireBackend: () => current },
  } as unknown as HostEventPipelineDependencies)
  return {
    get,
    backend,
    posted,
    transcript,
    pipeline,
    replace: () => {
      current = {} as DshBackend
    },
    view: () => transcript.navigate('s1', 'latest', 0, new AbortController().signal),
  }
}

describe('alpha211 Adapter to Host window preparation boundary', () => {
  it('uses the native workingDirectory projection without rereading a session for every attempt', async () => {
    const root = path.resolve('fixture-workspace')
    const f = fixture([root])
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
    await f.pipeline.postBackendEvent(f.backend, first)
    await f.pipeline.postBackendEvent(f.backend, second)
    const view = await f.view()
    const tool = view.nodes.find((node) => node.kind === 'tool')
    expect(tool?.kind === 'tool' ? tool.tool.preparation : undefined).toMatchObject({
      filePath: 'src/test.ts',
      description: 'token=[redacted]',
      contentCharacters: 12,
    })
    expect(f.get).not.toHaveBeenCalled()
    expect(f.posted).toEqual([]) // No raw preparation frames cross the renderer boundary.
    const text = JSON.stringify(view)
    for (const value of [root, 'PRIVATE_BODY', 'fixture-secret', 'argumentsDelta'])
      expect(text).not.toContain(value)
    f.pipeline.dispose()
    f.transcript.dispose()
  })

  it('keeps descriptions but removes paths outside the current workspace', async () => {
    const f = fixture()
    await f.pipeline.postBackendEvent(f.backend, {
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
    const tool = (await f.view()).nodes.find((node) => node.kind === 'tool')
    expect(tool?.kind === 'tool' ? tool.tool.preparation : undefined).toMatchObject({
      description: 'Inspect file',
    })
    expect(JSON.stringify(await f.view())).not.toContain('outside.txt')
    expect(f.get).not.toHaveBeenCalled()
    f.pipeline.dispose()
    f.transcript.dispose()
  })

  it('rejects a stale backend before it can mutate the current Host view', async () => {
    const f = fixture()
    f.replace()
    expect(
      await f.pipeline.postBackendEvent(f.backend, {
        type: 'tool.preparing',
        sessionId: 's1',
        callId: 'c1',
        toolName: 'read',
        attemptId: 'a1',
        turn: 1,
        step: 1,
        updateIndex: 0,
        filePath: 'src/file.ts',
      }),
    ).toBe(false)
    expect((await f.view()).nodes).toEqual([])
    expect(f.posted).toEqual([])
    f.pipeline.dispose()
    f.transcript.dispose()
  })
})
