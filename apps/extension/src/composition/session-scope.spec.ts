import { describe, expect, it, vi } from 'vitest'
import type { SessionDetail, WorkspaceSummary } from '@dsh-vscode/domain'

import type * as SessionOwnership from '../view/session-ownership.js'
import type * as RegisterWorkspaceFolders from '../backend/register-workspace-folders.js'

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

function scopeWith(overrides: {
  readonly archivedSessionIds?: readonly string[]
  readonly get?: ReturnType<typeof vi.fn>
}): {
  readonly scope: ReturnType<typeof createSessionScope>
  readonly get: ReturnType<typeof vi.fn>
  readonly gate: Promise<void>
  readonly release: () => void
} {
  const get =
    overrides.get ??
    vi.fn((_sessionId: string, _signal: AbortSignal) => Promise.resolve({ id: 's1' } as SessionDetail))
  let resolveGate: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve
  })
  const scope = createSessionScope({
    backendService: {
      requireBackend: () => ({
        workspaces: {
          listArchivedSessionIds: () => Promise.resolve(overrides.archivedSessionIds ?? ['s1']),
        },
        sessions: { get },
        subagents: {},
      }),
    } as never,
    workspaceUseCases: { list: () => Promise.resolve([workspace]) } as never,
    temporaryWorkspaceManager: {} as never,
    currentWorkspaceFolders: () => [{ uri: { fsPath: '/project' } }] as never,
    currentWorkspaceFolder: () => ({ uri: { fsPath: '/project' } }) as never,
  })
  return { scope, get, gate, release: () => resolveGate?.() }
}

describe('session scope pending-load reuse', () => {
  it('never hands a pending recovery load to an ordinary route', async () => {
    // The two `allowArchived` routes are the only callers that may reach an
    // archived session. If an ordinary route adopts the in-flight recovery
    // read, the archived-session refusal is decided by whichever route
    // happened to start the load, not by the route's own contract.
    const { scope, gate, release } = scopeWith({})
    const signal = new AbortController().signal

    const recovery = scope.requireCurrentWorkspaceSession('s1', signal, { allowArchived: true })
    const ordinary = scope.requireCurrentWorkspaceSession('s1', signal)
    release()
    await gate

    await expect(recovery).resolves.toMatchObject({ id: 's1' })
    await expect(ordinary).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      cause: { message: 'The requested session is archived.' },
    })
  })

  it('does not inherit an ordinary load refusal on a recovery route', async () => {
    const { scope, gate, release } = scopeWith({})
    const signal = new AbortController().signal

    const ordinary = scope.requireCurrentWorkspaceSession('s1', signal)
    const recovery = scope.requireCurrentWorkspaceSession('s1', signal, { allowArchived: true })
    release()
    await gate

    await expect(ordinary).rejects.toMatchObject({
      cause: { message: 'The requested session is archived.' },
    })
    await expect(recovery).resolves.toMatchObject({ id: 's1' })
  })
})
