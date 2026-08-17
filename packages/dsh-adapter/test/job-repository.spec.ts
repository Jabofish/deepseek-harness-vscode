import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6JobRepository } from '../src/repositories/job-repository.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'

const transport: DshTransport = {
  request: <TResponse>() => Promise.reject<TResponse>(new Error('jobs issue no RPC')),
  remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('jobs issue no Remote')),
  openEventStream: async function* () {
    /* fixture stream */
  },
  close: () => Promise.resolve(),
}

describe('Rc6JobRepository snapshot semantics', () => {
  it('is unavailable before the mux subscription establishes a baseline', async () => {
    const repository = new Rc6JobRepository(transport)
    await expect(repository.list('session')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })

  it('treats subscribed-without-jobs as the authoritative empty snapshot', async () => {
    const repository = new Rc6JobRepository(transport)
    repository.remember({
      type: 'session.subscribed',
      sessionId: 'session',
      lastSequence: 4,
    })
    await expect(repository.list('session')).resolves.toEqual([])
  })

  it('replaces the complete snapshot and accepts the explicit transition to empty', async () => {
    const repository = new Rc6JobRepository(transport)
    repository.remember(
      rc6Mapper.event('session/jobs', {
        sessionId: 'session',
        jobs: [
          {
            id: 'bash-1',
            kind: 'bash',
            label: 'pnpm test',
            status: 'running',
            startedAt: 100,
          },
        ],
      }),
    )
    await expect(repository.list('session')).resolves.toEqual([
      {
        id: 'bash-1',
        kind: 'bash',
        label: 'pnpm test',
        status: 'running',
        startedAt: 100,
      },
    ])

    repository.remember(rc6Mapper.event('session/jobs', { sessionId: 'session', jobs: [] }))
    await expect(repository.list('session')).resolves.toEqual([])
  })

  it('clears a stale non-empty snapshot when a reconnect has no jobs baseline', async () => {
    const repository = new Rc6JobRepository(transport)
    repository.remember(
      rc6Mapper.event('session/jobs', {
        sessionId: 'session',
        jobs: [
          {
            id: 'bash-1',
            kind: 'bash',
            label: 'pnpm test',
            status: 'running',
            startedAt: 100,
          },
        ],
      }),
    )

    repository.remember({
      type: 'session.subscribed',
      sessionId: 'session',
      lastSequence: 8,
    })

    await expect(repository.list('session')).resolves.toEqual([])
  })

  it.each([
    ['missing kind', { id: 'job-1', label: 'work', status: 'running', startedAt: 1 }],
    ['unknown status', { id: 'job-1', kind: 'bash', label: 'work', status: 'cancelled', startedAt: 1 }],
    ['missing startedAt', { id: 'job-1', kind: 'bash', label: 'work', status: 'running' }],
    ['fractional startedAt', { id: 'job-1', kind: 'bash', label: 'work', status: 'running', startedAt: 1.5 }],
    [
      'malformed detail',
      { id: 'job-1', kind: 'bash', label: 'work', status: 'running', startedAt: 1, detail: 4 },
    ],
  ])('rejects a malformed %s row instead of publishing a partial snapshot', (_label, job) => {
    expect(() => rc6Mapper.event('session/jobs', { sessionId: 'session', jobs: [job] })).toThrow(
      /malformed job/i,
    )
  })
})
