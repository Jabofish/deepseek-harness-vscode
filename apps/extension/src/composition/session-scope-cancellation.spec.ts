import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AppError, type DshBackend, type SessionDetail, type WorkspaceSummary } from '@dsh-vscode/domain'
import { BackendService, WorkspaceUseCases } from '@dsh-vscode/application'
import type * as vscode from 'vscode'
import type { TemporaryWorkspaceManager } from '../backend/temporary-workspace.js'

vi.mock('vscode', () => ({ workspace: { isTrusted: true } }))

import { createSessionScope } from './session-scope.js'
import { WebviewMessageRouter } from '../view/message-router.js'

function fixture(owned = true): {
  readonly scope: ReturnType<typeof createSessionScope>
  readonly reads: readonly { readonly signal: AbortSignal; readonly release: () => void }[]
  readonly get: ReturnType<typeof vi.fn>
} {
  const root = path.resolve('fixture-project')
  const workspace: WorkspaceSummary = {
    id: 'w',
    name: 'Project',
    path: root,
    sessionIds: ['s'],
    sessionCount: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
  const detail: SessionDetail = {
    id: owned ? 's' : 'foreign',
    workspaceId: owned ? 'w' : 'foreign-workspace',
    cwd: owned ? root : path.resolve('foreign-project'),
    title: 'Session',
    blank: true,
    status: 'idle',
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    configuration: {
      preset: '',
      toolMode: 'native',
      permissionPreset: '',
      planMode: false,
      model: { providerId: '', modelId: '' },
    },
  }
  const reads: { readonly signal: AbortSignal; readonly release: () => void }[] = []
  const list = (_signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> => {
    if (_signal === undefined) throw new Error('Missing cancellation signal')
    const signal = _signal
    return new Promise((resolve, reject) => {
      const onAbort = (): void =>
        reject(new AppError({ code: 'REQUEST_CANCELLED', message: 'Read cancelled', retryable: false }))
      signal.addEventListener('abort', onAbort, { once: true })
      reads.push({
        signal,
        release: () => {
          signal.removeEventListener('abort', onAbort)
          resolve([workspace])
        },
      })
    })
  }
  const get = vi.fn(() => Promise.resolve(detail))
  const service = new BackendService()
  service.attach(
    {
      events: { subscribe: () => () => undefined },
      workspaces: { list, listArchivedSessionIds: () => Promise.resolve([]) },
      sessions: { get, open: get },
      subagents: {},
    } as unknown as DshBackend,
    () => undefined,
  )
  const folder = { uri: { fsPath: root } } as vscode.WorkspaceFolder
  return {
    scope: createSessionScope({
      backendService: service,
      workspaceUseCases: new WorkspaceUseCases(service),
      temporaryWorkspaceManager: {} as TemporaryWorkspaceManager,
      currentWorkspaceFolders: () => [folder],
      currentWorkspaceFolder: () => folder,
    }),
    reads,
    get,
  }
}

describe('session scope cancellation through real ownership guards', () => {
  it('still rejects foreign sessions when an active sibling adopts a shared read', async () => {
    const { scope, reads } = fixture(false)
    const a = scope.requireCurrentWorkspaceSession('foreign', new AbortController().signal)
    const b = scope.requireCurrentWorkspaceSession('foreign', new AbortController().signal)
    reads[0]!.release()
    await expect(a).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(b).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(reads).toHaveLength(1)
  })

  it('isolates cancellation of a later caller and aborts the read when the last caller leaves', async () => {
    const { scope, reads, get } = fixture()
    const first = new AbortController()
    const second = new AbortController()
    const a = scope.requireCurrentWorkspaceSession('s', first.signal)
    const b = scope.requireCurrentWorkspaceSession('s', second.signal)
    expect(reads).toHaveLength(1)
    second.abort()
    await expect(b).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(reads[0]?.signal.aborted).toBe(false)
    first.abort()
    await expect(a).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(reads[0]?.signal.aborted).toBe(true)
    expect(get).not.toHaveBeenCalled()

    const restarted = scope.requireCurrentWorkspaceSession('s', new AbortController().signal)
    expect(reads).toHaveLength(2)
    reads[1]!.release()
    await expect(restarted).resolves.toMatchObject({ id: 's' })
  })

  it('preserves an active sibling when feature.request.cancel interrupts workspace discovery', async () => {
    const { scope, reads, get } = fixture()
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest: async (_request, signal) => {
        const session = await scope.requireCurrentWorkspaceSession('s', signal)
        return { items: [], sessionId: session.id }
      },
    })
    const envelope = (requestId: string): unknown => ({
      protocolVersion: 1,
      message: { type: 'feedback.list', requestId, payload: { sessionId: 's' } },
    })
    const a = router.handle(envelope('a'))
    const b = router.handle(envelope('b'))
    expect(reads).toHaveLength(1)
    await router.handle({
      protocolVersion: 1,
      message: { type: 'feature.request.cancel', requestId: 'cancel-a', payload: { targetRequestId: 'a' } },
    })
    reads[0]!.release()
    await Promise.all([a, b])
    expect(
      posted.find(
        (value) =>
          typeof value === 'object' && value !== null && 'requestId' in value && value.requestId === 'a',
      ),
    ).toMatchObject({ requestId: 'a', ok: false, error: { code: 'REQUEST_CANCELLED' } })
    expect(posted).toContainEqual(expect.objectContaining({ requestId: 'b', ok: true }))
    expect(get).toHaveBeenCalledOnce()
    router.cancelAll()
  })

  it('keeps fresh session opens available to ordinary siblings after their original caller cancels', async () => {
    const { scope, reads } = fixture()
    const first = new AbortController()
    const opening = scope.requireCurrentWorkspaceSession('s', first.signal, { fresh: true })
    const sibling = scope.requireCurrentWorkspaceSession('s', new AbortController().signal)
    first.abort()
    await expect(opening).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    reads[0]!.release()
    await expect(sibling).resolves.toMatchObject({ id: 's' })
    expect(reads).toHaveLength(1)
  })
})
