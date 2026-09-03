import { describe, expect, it, vi } from 'vitest'

import type { DshTransport } from '../src/contracts.js'
import { Rc6GoalRepository } from '../src/repositories/goal-repository.js'

function transport(request: DshTransport['request']): DshTransport {
  return {
    request,
    remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

describe('Rc6GoalRepository live cache', () => {
  it('serves goal.list from the latest goal.updated event without replaying history', async () => {
    const requestImplementation = <TResponse>(_method: string, _params: unknown): Promise<TResponse> =>
      Promise.reject<TResponse>(new Error('history should not be requested'))
    const request = vi.fn(requestImplementation) as unknown as DshTransport['request']
    const repository = new Rc6GoalRepository(transport(request))
    const goals = [{ id: 'goal-1', title: 'Ship compatibility', status: 'in-progress' as const }]

    repository.remember({ type: 'goal.updated', sessionId: 'session-1', goals })

    await expect(repository.list('session-1')).resolves.toEqual(goals)
    expect(request).not.toHaveBeenCalled()
  })

  it('reads the current goal from the history projection before scanning older pages', async () => {
    const request = vi.fn(
      <TResponse>() =>
        ({
          result: {
            ok: true,
            value: {
              events: [],
              hasMore: true,
              projections: {
                asOfSeq: 18,
                values: {
                  goal: {
                    goal: { id: 'goal-2', revision: 4, objective: 'Finish the adapter', phase: 'active' },
                    roundsStarted: 2,
                  },
                },
              },
            },
          },
        }) as TResponse,
    ) as unknown as DshTransport['request']
    const repository = new Rc6GoalRepository(transport(request))

    await expect(repository.list('session-2')).resolves.toEqual([
      { id: 'goal-2', title: 'Finish the adapter', status: 'in-progress' },
    ])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('uses a live goal projection as the session cache, including a cleared goal', async () => {
    const request = vi.fn(<TResponse>(): Promise<TResponse> =>
      Promise.reject<TResponse>(new Error('goal projection should avoid history')),
    ) as unknown as DshTransport['request']
    const repository = new Rc6GoalRepository(transport(request))

    repository.remember({
      type: 'session.projection',
      sessionId: 'session-3',
      key: 'goal',
      value: {
        goal: { id: 'goal-3', revision: 1, objective: 'Review', phase: 'paused' },
      },
    })
    await expect(repository.list('session-3')).resolves.toEqual([
      { id: 'goal-3', title: 'Review', status: 'pending' },
    ])
    expect(repository.sessionForGoal('goal-3')).toBe('session-3')

    repository.remember({ type: 'session.projection', sessionId: 'session-3', key: 'goal', value: null })
    await expect(repository.list('session-3')).resolves.toEqual([])
    expect(repository.sessionForGoal('goal-3')).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps usable goal state on malformed projections and clears revision refs on removal', async () => {
    const request = vi.fn(<TResponse>(): Promise<TResponse> =>
      Promise.reject<TResponse>(new Error('cached goal state should avoid history')),
    ) as unknown as DshTransport['request']
    const repository = new Rc6GoalRepository(transport(request))

    repository.remember({
      type: 'session.projection',
      sessionId: 'session-4',
      key: 'goal',
      value: { goal: { id: 'goal-4', revision: 2, objective: 'Keep state', phase: 'active' } },
    })
    expect(repository.sessionForGoal('goal-4')).toBe('session-4')

    repository.remember({
      type: 'session.projection',
      sessionId: 'session-4',
      key: 'goal',
      value: { unrelated: { id: 'forged-goal', revision: 99 } },
    })
    expect(repository.sessionForGoal('forged-goal')).toBeUndefined()
    await expect(repository.list('session-4')).resolves.toEqual([
      { id: 'goal-4', title: 'Keep state', status: 'in-progress' },
    ])

    repository.remember({ type: 'session.removed', sessionId: 'session-4' })
    expect(repository.sessionForGoal('goal-4')).toBeUndefined()
  })
})

describe('Rc6GoalRepository concurrent cache writes', () => {
  it('keeps live event state that arrives while the history walk is in flight', async () => {
    let releaseHistory: ((value: unknown) => void) | undefined
    const request = vi.fn(
      (_method: string, _params: unknown) =>
        new Promise<unknown>((resolve) => {
          releaseHistory = (value) => resolve({ result: { ok: true, value } })
        }),
    ) as unknown as DshTransport['request']
    const repository = new Rc6GoalRepository(transport(request))
    const pending = repository.list('session-1')
    const live = [{ id: 'goal-live', title: 'Fresh from the stream', status: 'in-progress' as const }]
    repository.remember({ type: 'goal.updated', sessionId: 'session-1', goals: live })

    await vi.waitFor(() => expect(releaseHistory).toBeDefined())
    releaseHistory!({ events: [], hasMore: false, projections: { asOfSeq: 1, values: {} } })
    // The walk started before the event arrived, so its history-derived
    // result is staler than the state the mux observer already cached.
    await expect(pending).resolves.toEqual(live)
  })

  it('does not duplicate a created goal that the live stream already delivered', async () => {
    const request = vi.fn(
      <TResponse>() =>
        ({
          result: { ok: true, value: { ref: { id: 'goal-3', revision: 1 } } },
        }) as TResponse,
    ) as unknown as DshTransport['request']
    const repository = new Rc6GoalRepository(transport(request))
    // The host can deliver the goal.updated event over the mux before the
    // goal.create HTTP receipt resolves; ordering across the two channels is
    // not guaranteed.
    const delivered = [{ id: 'goal-3', title: 'Host goal', status: 'in-progress' as const }]
    repository.remember({ type: 'goal.updated', sessionId: 'session-1', goals: delivered })

    const created = await repository.create('session-1', 'Host goal')
    expect(created.id).toBe('goal-3')
    await expect(repository.list('session-1')).resolves.toEqual(delivered)
  })
})

describe('Rc6GoalRepository optimistic-concurrency tokens', () => {
  it('sends the revision observed from live goal projections with goal edits', async () => {
    const edits: unknown[] = []
    const request = vi.fn((method: string, params: unknown) => {
      if (method === 'goal.edit') {
        edits.push(params)
        return Promise.resolve({
          result: { ok: true, value: { ref: { id: 'goal-1', revision: 8 } } },
        } as never)
      }
      return Promise.resolve({
        result: {
          ok: true,
          value: {
            events: [],
            hasMore: false,
            projections: {
              asOfSeq: 5,
              values: { goal: { goal: { id: 'goal-1', revision: 5, objective: 'T', phase: 'active' } } },
            },
          },
        } as never,
      })
    }) as unknown as DshTransport['request']
    const repository = new Rc6GoalRepository(transport(request))
    await repository.list('session-1')

    // A live projection delivered after the history walk carries the host's
    // bumped revision; the edit must use it, not the stale walk-time token.
    repository.remember({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'goal',
      value: { goal: { goal: { id: 'goal-1', revision: 7, objective: 'T', phase: 'active' } } },
    })

    await repository.update('goal-1', { title: 'T2' })
    expect(edits).toEqual([{ sessionId: 'session-1', ref: { id: 'goal-1', revision: 7 }, objective: 'T2' }])
  })

  it('forwards maxGoalRounds through create and edit without changing status mutations', async () => {
    const calls: { method: string; params: unknown }[] = []
    const request = vi.fn((method: string, params: unknown) => {
      calls.push({ method, params })
      return Promise.resolve({
        result: {
          ok: true,
          value:
            method === 'goal.create'
              ? { ref: { id: 'goal-cap', revision: 1 } }
              : { ref: { id: 'goal-cap', revision: 2 } },
        },
      } as never)
    }) as unknown as DshTransport['request']
    const repository = new Rc6GoalRepository(transport(request))

    await expect(repository.create('session-cap', 'Bounded work', undefined, 7)).resolves.toMatchObject({
      id: 'goal-cap',
      maxGoalRounds: 7,
    })
    await repository.update('goal-cap', { maxGoalRounds: 9 })

    expect(calls).toEqual([
      {
        method: 'goal.create',
        params: { sessionId: 'session-cap', objective: 'Bounded work', maxGoalRounds: 7 },
      },
      {
        method: 'goal.edit',
        params: { sessionId: 'session-cap', ref: { id: 'goal-cap', revision: 1 }, maxGoalRounds: 9 },
      },
    ])
  })
})
