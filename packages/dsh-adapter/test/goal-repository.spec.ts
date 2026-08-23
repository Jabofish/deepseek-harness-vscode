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

    repository.remember({ type: 'session.projection', sessionId: 'session-3', key: 'goal', value: null })
    await expect(repository.list('session-3')).resolves.toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})
