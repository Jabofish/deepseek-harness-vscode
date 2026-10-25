import { describe, expect, it, vi } from 'vitest'
import type { DshBackend, SessionDetail, WorkspaceSummary, QuestionRequestIdentity } from '@dsh-vscode/domain'

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

import { createSessionScope, requireCatalogOwnedSession } from './session-scope.js'

const workspace: WorkspaceSummary = { id: 'ws-1', name: 'project', path: '/project' } as WorkspaceSummary

describe('fork ownership without migration', () => {
  it('checks the catalog and durable parents without reading or opening history', async () => {
    const get = vi.fn()
    const open = vi.fn()
    const backend = {
      sessions: {
        get,
        open,
        list: vi.fn(() =>
          Promise.resolve({
            items: [
              { id: 'old', workspaceId: 'ws-1', formatStatus: 'migration-required' },
              { id: 'foreign', workspaceId: 'ws-2' },
            ],
          }),
        ),
      },
      workspaces: { listArchivedSessionIds: vi.fn(() => Promise.resolve(['archived'])) },
      subagents: { parentOf: (id: string) => (id === 'child' ? 'old' : undefined) },
    } as unknown as DshBackend
    const signal = new AbortController().signal
    await expect(requireCatalogOwnedSession(backend, 'old', [workspace], [], signal)).resolves.toBeUndefined()
    await expect(
      requireCatalogOwnedSession(backend, 'child', [workspace], [], signal),
    ).resolves.toBeUndefined()
    for (const id of ['foreign', 'missing', 'archived'])
      await expect(requireCatalogOwnedSession(backend, id, [workspace], [], signal)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      })
    expect(get).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})

function scopeWith(overrides: {
  readonly archivedSessionIds?: readonly string[]
  readonly get?: ReturnType<typeof vi.fn>
  readonly interactionOwner?: string
  readonly questionOwner?: (id: string, identity?: QuestionRequestIdentity) => string | undefined
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
        interactions: {
          sessionForPermission: () => overrides.interactionOwner,
          sessionForQuestion: overrides.questionOwner ?? (() => overrides.interactionOwner),
        },
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
  it('resolves an exact question identity through the repository before applying workspace ownership', async () => {
    const questionOwner = vi.fn((id: string, identity?: QuestionRequestIdentity) =>
      id === 'same' && identity?.sessionId === 's1' && identity.rpcId === 'owned' ? 's1' : undefined,
    )
    const { scope, get } = scopeWith({ archivedSessionIds: [], questionOwner })
    const signal = new AbortController().signal
    await expect(
      scope.requireOwnedQuestion('same', signal, { sessionId: 's2', rpcId: 'owned' }),
    ).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
    expect(get).not.toHaveBeenCalled()
    await scope.requireOwnedQuestion('same', signal, { sessionId: 's1', rpcId: 'owned' })
    expect(questionOwner).toHaveBeenLastCalledWith('same', { sessionId: 's1', rpcId: 'owned' })
    expect(get).toHaveBeenCalledOnce()
  })
  it.each(['permission', 'question'] as const)(
    'reports an unknown %s as stale without claiming workspace denial',
    async (kind) => {
      const { scope, get } = scopeWith({})
      const guard = kind === 'permission' ? scope.requireOwnedPermission : scope.requireOwnedQuestion
      await expect(guard('unknown', new AbortController().signal)).rejects.toMatchObject({
        code: 'STALE_INTERACTION',
      })
      expect(get).not.toHaveBeenCalled()
    },
  )

  it('still applies normal session scope checks when the interaction owner is known', async () => {
    const { scope } = scopeWith({ interactionOwner: 's1' })
    await expect(
      scope.requireOwnedPermission('permission', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

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
