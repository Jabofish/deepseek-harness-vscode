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
})
