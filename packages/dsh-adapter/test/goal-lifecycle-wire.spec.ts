import { describe, expect, it, vi } from 'vitest'

import type { BackendEndpoint } from '@dsh-vscode/domain'

import { Rc6GoalRepository } from '../src/repositories/goal-repository.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'

/**
 * Wire shapes below are copied from the installed 0.1.6-alpha.1 host
 * (`@deepseek-ai/dsh-goal` typert declarations): the `goals` Remote namespace
 * takes `{agentId, ref}` / `{agentId, request}`, `create` answers `{ref}`, the
 * lifecycle verbs answer the whole GoalView (id/revision/objective/phase/
 * activation/roundsStarted/timestamps/maxGoalRounds), and `clear` answers the
 * cleared GoalRef. The repository only ever sees the rc.6 client-side labels
 * (`goal.create`…), so the transport is what must keep those two worlds apart.
 */

class FakeWebSocket implements AlphaWebSocket {
  public readyState = 0
  public readonly sent: string[] = []
  public constructor(
    public readonly url: string,
    public readonly options?: unknown,
  ) {}
  public send(data: string): void {
    this.sent.push(data)
  }
  public close(): void {
    this.readyState = 3
  }
  public addEventListener(): void {}
  public removeEventListener(): void {}
}

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '{}'
}

function ok(init: RequestInit | undefined, value: unknown): Response {
  const body = JSON.parse(bodyText(init)) as { readonly rpcId: string }
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function failure(init: RequestInit | undefined, code: string, message: string): Response {
  const body = JSON.parse(bodyText(init)) as { readonly rpcId: string }
  return new Response(
    JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: false, error: { code, message, details: {} } },
    }),
    { headers: { 'content-type': 'application/json' } },
  )
}

/** Real GoalView the alpha host returns for edit/complete/pause/resume. */
function liveGoal(revision: number, phase = 'active'): Record<string, unknown> {
  return {
    id: 'g-1',
    revision,
    objective: 'Ship the goal path',
    phase,
    activation: phase === 'active' ? 'armed' : 'disarmed',
    roundsStarted: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    maxGoalRounds: 8,
  }
}

function client(fetch: typeof globalThis.fetch): AlphaLoopbackApiClient {
  return new AlphaLoopbackApiClient({
    endpoint,
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
    authCookie: () => 'dsh_session=test-cookie',
    webSocket: FakeWebSocket,
  })
}

function posted(fetch: ReturnType<typeof vi.fn>, index: number): { path: string; args: unknown } {
  const call = fetch.mock.calls[index]
  const url = call?.[0] as { pathname?: string }
  const body = JSON.parse(bodyText(call?.[1] as RequestInit)) as { readonly payload?: unknown }
  return { path: url.pathname ?? '', args: (body.payload as { readonly args?: unknown })?.args }
}

/** Cache the current goal the way a live control-stream projection frame does. */
function projectGoal(repository: Rc6GoalRepository, revision: number, phase = 'active'): void {
  repository.remember({
    type: 'session.projection',
    sessionId: 's-1',
    key: 'goal',
    value: {
      goal: { id: 'g-1', revision, objective: 'Ship the goal path', phase, maxGoalRounds: 8 },
      roundsStarted: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
    },
  })
}

describe('goal lifecycle over the alpha wire', () => {
  it('creates through goals/create and keeps the receipt ref for later CAS mutations', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(ok(init, { ref: { id: 'g-1', revision: 1 } })),
    )
    const transport = client(fetch)
    const repository = new Rc6GoalRepository(transport)

    await expect(repository.create('s-1', 'Ship the goal path', undefined, 8)).resolves.toEqual({
      id: 'g-1',
      title: 'Ship the goal path',
      status: 'in-progress',
      maxGoalRounds: 8,
    })
    expect(posted(fetch, 0)).toEqual({
      path: '/api/goals/create',
      args: { agentId: 's-1', request: { objective: 'Ship the goal path', maxGoalRounds: 8 } },
    })
    expect(repository.sessionForGoal('g-1')).toBe('s-1')

    projectGoal(repository, 1)
    await expect(repository.list('s-1')).resolves.toEqual([
      { id: 'g-1', title: 'Ship the goal path', status: 'in-progress', maxGoalRounds: 8 },
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
    await transport.close()
  })

  it('resumes, pauses, completes and edits through the real Remote verbs and revisions', async () => {
    let revision = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      revision += 1
      const path = (_input as { pathname: string }).pathname
      return Promise.resolve(
        path === '/api/goals/create'
          ? ok(init, { ref: { id: 'g-1', revision } })
          : ok(init, liveGoal(revision)),
      )
    })
    const transport = client(fetch)
    const repository = new Rc6GoalRepository(transport)
    await repository.create('s-1', 'Ship the goal path')

    await repository.update('g-1', { status: 'in-progress' })
    await repository.update('g-1', { status: 'pending' })
    await repository.update('g-1', { status: 'completed' })
    await repository.update('g-1', { title: 'Ship it well', maxGoalRounds: 12 })

    expect(fetch.mock.calls.map((call) => (call[0] as { pathname: string }).pathname)).toEqual([
      '/api/goals/create',
      '/api/goals/resume',
      '/api/goals/pause',
      '/api/goals/complete',
      '/api/goals/edit',
    ])
    expect(posted(fetch, 1).args).toEqual({ agentId: 's-1', ref: { id: 'g-1', revision: 1 } })
    expect(posted(fetch, 2).args).toEqual({ agentId: 's-1', ref: { id: 'g-1', revision: 2 } })
    expect(posted(fetch, 3).args).toEqual({ agentId: 's-1', ref: { id: 'g-1', revision: 3 } })
    expect(posted(fetch, 4).args).toEqual({
      agentId: 's-1',
      ref: { id: 'g-1', revision: 4 },
      request: { objective: 'Ship it well', maxGoalRounds: 12 },
    })
    await transport.close()
  })

  it('clears through goals/clear and drops the goal from the cache and the ref map', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(ok(init, { id: 'g-1', revision: 5 })),
    )
    const transport = client(fetch)
    const repository = new Rc6GoalRepository(transport)
    projectGoal(repository, 4)

    await repository.clear('g-1')

    expect(posted(fetch, 0)).toEqual({
      path: '/api/goals/clear',
      args: { agentId: 's-1', ref: { id: 'g-1', revision: 4 } },
    })
    expect(repository.sessionForGoal('g-1')).toBeUndefined()
    await expect(repository.list('s-1')).resolves.toEqual([])
    await transport.close()
  })

  it('prefers the live projection revision over a stale receipt for the next mutation', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        (_input as { pathname: string }).pathname === '/api/goals/create'
          ? ok(init, { ref: { id: 'g-1', revision: 4 } })
          : ok(init, liveGoal(8, 'paused')),
      ),
    )
    const transport = client(fetch)
    const repository = new Rc6GoalRepository(transport)
    await repository.create('s-1', 'Ship the goal path')

    // The host bumped the revision by an external mutation; the projection is
    // the read side and must re-arm the CAS ref before the next write.
    projectGoal(repository, 7, 'paused')

    await repository.update('g-1', { status: 'in-progress' })

    expect(posted(fetch, 1).args).toEqual({ agentId: 's-1', ref: { id: 'g-1', revision: 7 } })
    await transport.close()
  })

  it('surfaces a rejected mutation instead of patching local goal state', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const path = (_input as { pathname: string }).pathname
      return Promise.resolve(
        path === '/api/goals/create'
          ? ok(init, { ref: { id: 'g-1', revision: 1 } })
          : failure(init, 'gateway/internal', 'stale goal ref "g-1" revision 1; current is "g-1" revision 2'),
      )
    })
    const transport = client(fetch)
    const repository = new Rc6GoalRepository(transport)
    await repository.create('s-1', 'Ship the goal path')
    projectGoal(repository, 1)

    await expect(repository.update('g-1', { status: 'pending' })).rejects.toMatchObject({
      message: expect.stringContaining('stale goal ref') as unknown,
    })
    await expect(repository.list('s-1')).resolves.toEqual([
      { id: 'g-1', title: 'Ship the goal path', status: 'in-progress', maxGoalRounds: 8 },
    ])
    await transport.close()
  })
})

it.each([undefined, {}, { id: 'other', revision: 5 }, { id: 'g-1', revision: 4 }])(
  'rejects a clear acknowledgement without the expected tombstone: %j',
  async (receipt) => {
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(ok(init, receipt))),
    )
    const repository = new Rc6GoalRepository(transport)
    projectGoal(repository, 4)
    try {
      await expect(repository.clear('g-1')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
      expect(repository.sessionForGoal('g-1')).toBe('s-1')
    } finally {
      await transport.close()
    }
  },
)
