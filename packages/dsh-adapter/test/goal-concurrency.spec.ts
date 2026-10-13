import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6GoalRepository } from '../src/repositories/goal-repository.js'

function deferred(): { readonly promise: Promise<unknown>; readonly resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
function wire(request: ReturnType<typeof vi.fn>): DshTransport {
  return {
    request: request as DshTransport['request'],
    remoteRequest: vi.fn(),
    openEventStream: async function* () {},
    close: () => Promise.resolve(),
  }
}
function ok(value: unknown): { readonly result: { readonly ok: true; readonly value: unknown } } {
  return { result: { ok: true, value } }
}
function project(repository: Rc6GoalRepository, revision: number, objective: string): void {
  repository.remember({
    type: 'session.projection',
    sessionId: 's',
    key: 'goal',
    value: { goal: { id: 'g', revision, objective, phase: 'active' } },
  })
}
function history(revision: number): ReturnType<typeof ok> {
  return ok({
    events: [],
    hasMore: false,
    projections: {
      asOfSeq: revision,
      values: { goal: { goal: { id: 'g', revision, objective: 'Old', phase: 'active' } } },
    },
  })
}

describe('goal asynchronous state regressions', () => {
  it('does not replace newer CAS refs with a delayed history projection', async () => {
    const pending = deferred()
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(ok({ ref: { id: 'g', revision: 5 } }))
    const repository = new Rc6GoalRepository(wire(request))
    const reading = repository.list('s')
    project(repository, 4, 'Current')
    pending.resolve(history(1))
    await expect(reading).resolves.toMatchObject([{ title: 'Current' }])
    await repository.update('g', { title: 'Next' })
    expect(request).toHaveBeenLastCalledWith(
      'goal.edit',
      { sessionId: 's', ref: { id: 'g', revision: 4 }, objective: 'Next' },
      undefined,
    )
  })

  it('does not resurrect a removed session from its delayed history response', async () => {
    const pending = deferred()
    const repository = new Rc6GoalRepository(wire(vi.fn().mockReturnValue(pending.promise)))
    const reading = repository.list('s')
    repository.remember({ type: 'session.removed', sessionId: 's' })
    pending.resolve(history(1))
    await expect(reading).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(repository.sessionForGoal('g')).toBeUndefined()
  })

  it('preserves the newer stream view after an older mutation receipt arrives', async () => {
    const pending = deferred()
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(ok({ ref: { id: 'g', revision: 4 } }))
    const repository = new Rc6GoalRepository(wire(request))
    project(repository, 1, 'Initial')
    const updating = repository.update('g', { title: 'My edit' })
    project(repository, 3, 'Newer external edit')
    pending.resolve(ok({ ref: { id: 'g', revision: 2 } }))
    await updating
    await expect(repository.list('s')).resolves.toMatchObject([{ title: 'Newer external edit' }])
    await repository.update('g', { title: 'Next' })
    expect(request.mock.calls[1]?.[1]).toMatchObject({ ref: { id: 'g', revision: 3 } })
  })

  it('does not roll back a freshly projected revision when create acknowledgement is delayed', async () => {
    const pending = deferred()
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(ok({ ref: { id: 'g', revision: 4 } }))
    const repository = new Rc6GoalRepository(wire(request))
    const creating = repository.create('s', 'Initial')
    project(repository, 3, 'Updated during creation')
    pending.resolve(ok({ ref: { id: 'g', revision: 1 } }))
    await creating
    await repository.update('g', { title: 'Next' })
    expect(request.mock.calls[1]?.[1]).toMatchObject({ ref: { id: 'g', revision: 3 } })
  })

  it('does not register an obsolete create receipt after the session is removed', async () => {
    const pending = deferred()
    const repository = new Rc6GoalRepository(wire(vi.fn().mockReturnValue(pending.promise)))
    const creating = repository.create('s', 'Initial')
    repository.remember({ type: 'session.removed', sessionId: 's' })
    pending.resolve(ok({ ref: { id: 'g', revision: 1 } }))
    await creating
    expect(repository.sessionForGoal('g')).toBeUndefined()
  })

  it('keeps the create revision when a legacy display-only goal event arrives before its receipt', async () => {
    const pending = deferred()
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(ok({ ref: { id: 'g', revision: 2 } }))
    const repository = new Rc6GoalRepository(wire(request))
    const creating = repository.create('s', 'Initial')
    repository.remember({
      type: 'goal.updated',
      sessionId: 's',
      goals: [{ id: 'g', title: 'Host title', status: 'in-progress' }],
    })
    pending.resolve(ok({ ref: { id: 'g', revision: 1 } }))
    await creating
    await repository.update('g', { title: 'Next' })
    expect(request.mock.calls[1]?.[1]).toMatchObject({ ref: { id: 'g', revision: 1 } })
  })

  it('keeps the authoritative view when the stream and HTTP acknowledge the same revision', async () => {
    const pending = deferred()
    const repository = new Rc6GoalRepository(wire(vi.fn().mockReturnValue(pending.promise)))
    project(repository, 1, 'Initial')
    const updating = repository.update('g', { title: ' raw request ' })
    // The pinned Goal service trims the objective; it cannot publish an
    // unrelated title at the very same revision as this edit.
    project(repository, 2, 'raw request')
    pending.resolve(ok({ ref: { id: 'g', revision: 2 } }))
    await updating
    await expect(repository.list('s')).resolves.toMatchObject([{ title: 'raw request' }])
  })
})
