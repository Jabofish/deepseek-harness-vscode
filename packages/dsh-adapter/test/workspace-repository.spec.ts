import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'

interface Call {
  readonly method: string
  readonly params: unknown
}

function transportFor(responses: Readonly<Record<string, unknown>>, calls: Call[] = []): DshTransport {
  return {
    request: <TResponse>(method: string, params: unknown) => {
      calls.push({ method, params })
      const response = responses[method]
      if (response === undefined) return Promise.reject(new Error(`unexpected RPC ${method}`))
      return Promise.resolve({ result: { ok: true, value: response } } as TResponse)
    },
    remoteRequest: <TResponse>() =>
      Promise.reject<TResponse>(new Error('the Remote carrier is not part of this contract')),
    openEventStream: async function* () {
      /* fixture */
    },
    close: () => Promise.resolve(),
  }
}

const WORKSPACE = {
  workspaceId: 'w1',
  path: '/workspace',
  title: 'Workspace',
  sessionIds: ['s1', 's2'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('Rc6WorkspaceRepository ordering', () => {
  it('moves a workspace before an anchor and supports append payloads', async () => {
    const calls: Call[] = []
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.insertBefore': { workspaceIds: ['w2', 'w1'] } }, calls),
    )

    await repository.insertBefore('w2', 'w1')
    await repository.insertBefore('w1')

    expect(calls).toEqual([
      { method: 'workspace.insertBefore', params: { workspaceId: 'w2', beforeWorkspaceId: 'w1' } },
      { method: 'workspace.insertBefore', params: { workspaceId: 'w1' } },
    ])
  })

  it('maps the full workspace response for a session move', async () => {
    const calls: Call[] = []
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.insertSessionBefore': { workspace: WORKSPACE } }, calls),
    )

    await repository.insertSessionBefore('w1', 's2', 's1')

    expect(calls).toEqual([
      {
        method: 'workspace.insertSessionBefore',
        params: { workspaceId: 'w1', sessionId: 's2', beforeSessionId: 's1' },
      },
    ])
  })

  it('rejects malformed ordering responses', async () => {
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.insertBefore': { workspaceIds: [''] } }),
    )

    await expect(repository.insertBefore('w1')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('does not turn a successful create into a failure when the display refresh is unavailable', async () => {
    const calls: Call[] = []
    const repository = new Rc6WorkspaceRepository(
      transportFor(
        {
          'workspace.create': { workspace: WORKSPACE, created: true },
          'workspace.rename': { workspace: { ...WORKSPACE, title: 'Renamed' } },
        },
        calls,
      ),
    )

    await expect(repository.create({ path: '/workspace', name: 'Renamed' })).resolves.toMatchObject({
      id: 'w1',
    })
    expect(calls.map((call) => call.method)).toEqual([
      'workspace.create',
      'workspace.rename',
      'workspace.list',
    ])
  })
})

describe('Rc6WorkspaceRepository archive state', () => {
  it('rejects restore before transport when the selected contract lacks it', async () => {
    const calls: Call[] = []
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.unarchiveSession': { archivedSessionIds: [] } }, calls),
    )

    await expect(repository.unarchiveSession('s1')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(calls).toEqual([])
  })

  it('forgets the archive memory a restore proves stale', async () => {
    const calls: Call[] = []
    const repository = new Rc6WorkspaceRepository(
      transportFor(
        {
          'workspace.archiveSession': { archivedSessionIds: ['s1'] },
          'workspace.unarchiveSession': { archivedSessionIds: [] },
          // The host's own post-restore set: the read that follows must agree
          // with it rather than re-hiding the row from local memory.
          'workspace.list': { items: [], archivedSessionIds: [] },
        },
        calls,
      ),
      { supportsSessionRestore: true },
    )

    await repository.archiveSession('s1')
    expect(repository.isArchived('s1')).toBe(true)

    await repository.unarchiveSession('s1')

    // Both the echo and the local archive memory must let the id go: the union
    // in every later archive-set read would otherwise hide the restored row.
    expect(repository.isArchived('s1')).toBe(false)
    await expect(repository.listArchivedSessionIds()).resolves.toEqual([])
    expect(calls.map((call) => call.method)).toEqual([
      'workspace.archiveSession',
      'workspace.unarchiveSession',
      'workspace.list',
    ])
    expect(calls[1]?.params).toEqual({ sessionId: 's1' })
  })

  it('keeps a refused restore archived instead of guessing from the error', async () => {
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.archiveSession': { archivedSessionIds: ['s1'] } }),
      { supportsSessionRestore: true },
    )
    await repository.archiveSession('s1')

    await expect(repository.unarchiveSession('s1')).rejects.toThrow(
      /unexpected RPC workspace\.unarchiveSession/u,
    )

    expect(repository.isArchived('s1')).toBe(true)
  })

  it('refuses a malformed archive-set echo from either direction', async () => {
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.unarchiveSession': { archivedSessionIds: [''] } }),
      { supportsSessionRestore: true },
    )

    await expect(repository.unarchiveSession('s1')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})

it('accepts an external restore after an acknowledged local archive', async () => {
  const responses = {
    'workspace.archiveSession': { archivedSessionIds: ['s1'] },
    'workspace.list': { items: [WORKSPACE], archivedSessionIds: ['s1'] as string[] },
  }
  const repository = new Rc6WorkspaceRepository(transportFor(responses))
  await repository.archiveSession('s1')
  expect((await repository.listWithArchiveState()).archivedSessionIds.has('s1')).toBe(true)
  responses['workspace.list'].archivedSessionIds = []
  expect((await repository.listWithArchiveState()).archivedSessionIds.has('s1')).toBe(false)
})

it('fences a list begun before archive without making that archive permanent', async () => {
  let resolveList: ((value: unknown) => void) | undefined
  const oldList = new Promise<unknown>((resolve) => {
    resolveList = resolve
  })
  const base = transportFor({
    'workspace.archiveSession': { archivedSessionIds: ['s1'] },
    'workspace.list': { items: [WORKSPACE], archivedSessionIds: [] },
  })
  let first = true
  const transport: DshTransport = {
    ...base,
    request: <T>(method: string, params: unknown, signal?: AbortSignal) => {
      if (method === 'workspace.list' && first) {
        first = false
        return oldList as Promise<T>
      }
      return base.request<T>(method, params, signal)
    },
  }
  const repository = new Rc6WorkspaceRepository(transport)
  const pending = repository.listWithArchiveState()
  await repository.archiveSession('s1')
  resolveList?.({ result: { ok: true, value: { items: [WORKSPACE], archivedSessionIds: [] } } })
  expect((await pending).archivedSessionIds.has('s1')).toBe(true)
  expect((await repository.listWithArchiveState()).archivedSessionIds.has('s1')).toBe(false)
})
