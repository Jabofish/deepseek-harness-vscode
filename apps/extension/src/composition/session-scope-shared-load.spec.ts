import { describe, expect, it, vi } from 'vitest'
import { AppError, type SessionDetail, type WorkspaceSummary } from '@dsh-vscode/domain'

import type * as RegisterWorkspaceFolders from '../backend/register-workspace-folders.js'
import type * as SessionOwnership from '../view/session-ownership.js'

vi.mock('vscode', () => ({
  workspace: { isTrusted: true },
}))

vi.mock('../view/session-ownership.js', async (load) => ({
  ...(await load<typeof SessionOwnership>()),
  ownsCurrentWorkspaceSession: (): Promise<boolean> => Promise.resolve(true),
}))

vi.mock(
  '../backend/register-workspace-folders.js',
  async (load): Promise<typeof RegisterWorkspaceFolders> => ({
    ...(await load<typeof RegisterWorkspaceFolders>()),
    registerWorkspaceFolders: (
      _paths: readonly string[],
      workspaces: readonly WorkspaceSummary[],
    ): Promise<readonly WorkspaceSummary[]> => Promise.resolve(workspaces),
  }),
)

import { createSessionScope } from './session-scope.js'

const workspace: WorkspaceSummary = { id: 'ws-1', name: 'project', path: '/project' } as WorkspaceSummary

/**
 * A gated workspace discovery read with the contract the real Host
 * repositories provide: every repository read takes the caller's signal and
 * rejects with REQUEST_CANCELLED when it aborts mid-flight (the adapter RPC
 * layer maps the upstream `cancelled` code). This isolates the shared-load
 * behavior using valid archive/session fixtures and an ownership stub. The
 * companion session-scope-cancellation spec retains the real ownership walk.
 */
function scopeWithGatedWorkspaceRead(): {
  readonly scope: ReturnType<typeof createSessionScope>
  readonly discoveryCalls: () => number
  readonly release: () => void
} {
  let release: (() => void) | undefined
  let calls = 0
  const scope = createSessionScope({
    backendService: {
      requireBackend: () => ({
        workspaces: { listArchivedSessionIds: () => Promise.resolve([]) },
        sessions: { get: (id: string) => Promise.resolve({ id, workspaceId: 'ws-1' } as SessionDetail) },
        subagents: {},
      }),
    } as never,
    workspaceUseCases: {
      list: (signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> =>
        new Promise((resolve, reject) => {
          calls += 1
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                new AppError({
                  code: 'REQUEST_CANCELLED',
                  message: 'The workspace discovery read was cancelled.',
                  retryable: false,
                }),
              ),
            { once: true },
          )
          release = () => resolve([workspace])
        }),
    } as never,
    temporaryWorkspaceManager: {} as never,
    currentWorkspaceFolders: () => [{ uri: { fsPath: '/project' } }] as never,
    currentWorkspaceFolder: () => ({ uri: { fsPath: '/project' } }) as never,
  })
  return { scope, discoveryCalls: () => calls, release: () => release?.() }
}

describe('session scope shared in-flight load', () => {
  it('reuses proven control ownership across directory changes, but never across backends or workspace roots', async () => {
    const get = vi.fn((id: string) => Promise.resolve({ id, workspaceId: 'ws-1' } as SessionDetail))
    let backend = {
      sessions: { get },
      workspaces: { listArchivedSessionIds: () => Promise.resolve([]) },
      subagents: {},
    }
    let root = '/project'
    const list = vi.fn(() => Promise.resolve([workspace]))
    const scope = createSessionScope({
      backendService: { requireBackend: () => backend } as never,
      workspaceUseCases: { list } as never,
      temporaryWorkspaceManager: {} as never,
      currentWorkspaceFolders: () => [{ uri: { fsPath: root } }] as never,
      currentWorkspaceFolder: () => ({ uri: { fsPath: root } }) as never,
    })
    const signal = new AbortController().signal
    await scope.requireCurrentWorkspaceSession('s1', signal)
    scope.invalidateCurrentWorkspaceSessionDetails()
    list.mockRejectedValue(new Error('slow advisory read'))
    await expect(
      scope.requireCurrentWorkspaceSession('s1', signal, { controlOnly: true }),
    ).resolves.toMatchObject({ id: 's1' })
    expect(list).toHaveBeenCalledOnce()
    await expect(
      scope.requireCurrentWorkspaceSession('unknown', signal, { controlOnly: true }),
    ).rejects.toThrow()
    root = '/different-project'
    await expect(scope.requireCurrentWorkspaceSession('s1', signal, { controlOnly: true })).rejects.toThrow()
    root = '/project'
    list.mockResolvedValue([workspace])
    await scope.requireCurrentWorkspaceSession('s1', signal)
    backend = { ...backend }
    list.mockRejectedValue(new Error('new backend must verify ownership'))
    await expect(scope.requireCurrentWorkspaceSession('s1', signal, { controlOnly: true })).rejects.toThrow()
    expect(get).toHaveBeenCalledTimes(2)
  })
  it('CONTROL: concurrent ordinary reads share one load and both resolve', async () => {
    const { scope, discoveryCalls, release } = scopeWithGatedWorkspaceRead()

    const first = scope.requireCurrentWorkspaceSession('s1', new AbortController().signal)
    const second = scope.requireCurrentWorkspaceSession('s1', new AbortController().signal)
    expect(discoveryCalls()).toBe(1)

    release()
    await expect(first).resolves.toMatchObject({ id: 's1' })
    await expect(second).resolves.toMatchObject({ id: 's1' })
  })

  it('RED: cancelling one caller must not cancel another caller that adopted the same load', async () => {
    // Reachable trigger: opening one session fans out concurrent advisory
    // reads (queue, goals, jobs, feedback, subagents), each a separate Host
    // request with its own signal. When one sibling is cancelled — e.g. the
    // protocol client's 30 s budget fires and it sends
    // feature.request.cancel for that request id — the shared in-flight
    // ownership load must not take the still-live siblings down with it.
    const { scope, release } = scopeWithGatedWorkspaceRead()
    const cancelledCaller = new AbortController()
    const survivingCaller = new AbortController()

    const cancelled = scope.requireCurrentWorkspaceSession('s1', cancelledCaller.signal)
    const surviving = scope.requireCurrentWorkspaceSession('s1', survivingCaller.signal)

    cancelledCaller.abort()
    release()

    await expect(cancelled).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(survivingCaller.signal.aborted).toBe(false)
    await expect(surviving).resolves.toMatchObject({ id: 's1' })
  })
})
