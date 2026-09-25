import { describe, expect, it, vi } from 'vitest'

import {
  Rc172AccountLifecycleRepository,
  type AccountRemoteTransport,
} from '../src/versions/rc172/account-repository.js'

const attemptId = 'd80ff092-0cdd-4a34-b5fb-05503d8574d8'
const client = { version: '0.2.3', locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }
const authorizeUrl =
  'https://platform.deepseek.com/dsh/authorize?state=private-state&code_challenge=private-challenge&code_challenge_method=S256'

function accountView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-out',
    links: {
      usageUrl: 'https://platform.deepseek.com/usage',
      topUpUrl: 'https://platform.deepseek.com/top_up',
    },
    attempt: null,
    ...overrides,
  }
}

function remoteSuccess(value: unknown): unknown {
  return { ok: true, value }
}

describe('Rc172AccountLifecycleRepository', () => {
  it('uses pinned account RPC names and keeps the authorization URL out of snapshots', async () => {
    const remoteRequest = vi.fn<AccountRemoteTransport['remoteRequest']>().mockResolvedValue(
      remoteSuccess(
        accountView({
          attempt: { id: attemptId, phase: 'waiting-browser', authorizeUrl, expiresAt: 1_900_000_000_000 },
        }),
      ),
    )
    const transport = { remoteRequest, openRemoteStream: vi.fn() }
    const repository = new Rc172AccountLifecycleRepository(transport)
    const launches: Array<{ attemptId: string; url: string }> = []
    repository.subscribeAuthorizationLaunch((launch) => launches.push(launch))

    const snapshot = await repository.startSignIn(client, 'http://127.0.0.1:3080', 'desktop')

    expect(remoteRequest).toHaveBeenCalledExactlyOnceWith(
      'account/startSignIn',
      { client, callbackOrigin: 'http://127.0.0.1:3080', loginSource: 'desktop' },
      undefined,
    )
    expect(snapshot).toEqual({
      status: 'signed-out',
      attempt: { id: attemptId, phase: 'waiting-browser', expiresAt: 1_900_000_000_000 },
    })
    expect(snapshot.attempt).not.toHaveProperty('authorizeUrl')
    expect(launches).toEqual([{ attemptId, url: authorizeUrl }])
  })

  it('routes cancel by the exact attempt id and preserves a committing outcome', async () => {
    const remoteRequest = vi.fn().mockResolvedValue(
      remoteSuccess(
        accountView({
          attempt: { id: attemptId, phase: 'committing' },
        }),
      ),
    )
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })

    await expect(repository.cancelSignIn(attemptId)).resolves.toEqual({
      status: 'signed-out',
      attempt: { id: attemptId, phase: 'committing' },
    })
    expect(remoteRequest).toHaveBeenCalledExactlyOnceWith('account/cancelSignIn', { attemptId }, undefined)
  })

  it('performs the running task check and signs out with Host client metadata', async () => {
    const remoteRequest = vi
      .fn<AccountRemoteTransport['remoteRequest']>()
      .mockResolvedValueOnce(remoteSuccess(true))
      .mockResolvedValueOnce(remoteSuccess(accountView()))
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })

    await expect(repository.hasRunningAccountTasks()).resolves.toBe(true)
    await expect(repository.signOut(client)).resolves.toEqual({ status: 'signed-out', attempt: null })
    expect(remoteRequest.mock.calls.map(([endpoint, args]) => [endpoint, args])).toEqual([
      ['account/hasRunningAccountTasks', {}],
      ['account/signOut', { client }],
    ])
  })

  it('subscribes to reconnect-safe account state and expiry streams and releases on abort', async () => {
    const closed: string[] = []
    const openRemoteStream = vi
      .fn<AccountRemoteTransport['openRemoteStream']>()
      .mockImplementation((endpoint, args, signal) => {
        if (Object.keys(args).length !== 0) throw new Error('Account streams must not receive arguments.')
        return {
          async *[Symbol.asyncIterator]() {
            try {
              if (endpoint === 'account/watch') yield accountView()
              else yield 'session-expired'
              await new Promise<void>((resolve) => {
                if (signal === undefined || signal.aborted) resolve()
                else signal.addEventListener('abort', () => resolve(), { once: true })
              })
            } finally {
              closed.push(endpoint)
            }
          },
        }
      })
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest: vi.fn(), openRemoteStream })
    const stateLifetime = new AbortController()
    const expiryLifetime = new AbortController()
    const stateIterator = repository.watch(stateLifetime.signal)[Symbol.asyncIterator]()
    const expiryIterator = repository.watchExpiry(expiryLifetime.signal)[Symbol.asyncIterator]()

    await expect(stateIterator.next()).resolves.toEqual({
      value: { status: 'signed-out', attempt: null },
      done: false,
    })
    await expect(expiryIterator.next()).resolves.toEqual({ value: 'session-expired', done: false })
    stateLifetime.abort()
    expiryLifetime.abort()
    await Promise.all([stateIterator.return?.(), expiryIterator.return?.()])

    expect(openRemoteStream.mock.calls.map(([endpoint, args]) => [endpoint, args])).toEqual([
      ['account/watch', {}],
      ['account/watchExpiry', {}],
    ])
    expect(closed.sort()).toEqual(['account/watch', 'account/watchExpiry'])
  })

  it('rejects malformed states and authorization destinations outside the Host-validated DSH origin', async () => {
    const remoteRequest = vi
      .fn()
      .mockResolvedValueOnce(remoteSuccess(accountView({ status: 'signed-in' })))
      .mockResolvedValueOnce(
        remoteSuccess(
          accountView({
            attempt: {
              id: attemptId,
              phase: 'waiting-browser',
              authorizeUrl: 'https://attacker.example/dsh/authorize?code_challenge=private',
            },
          }),
        ),
      )
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })
    const launch = vi.fn()
    repository.subscribeAuthorizationLaunch(launch)

    await expect(repository.getState()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(repository.getState()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(launch).not.toHaveBeenCalled()
  })

  it.each([
    'https://platform.deepseek.com/not-authorize?code_challenge=private',
    'https://platform.deepseek.com/dsh/authorized?state=private',
    'http://example.test/dsh/authorize?code_challenge=private',
    'https://user:password@platform.deepseek.com/dsh/authorize?code_challenge=private',
  ])('rejects an authorization URL outside the pinned browser destination: %s', async (url) => {
    const repository = new Rc172AccountLifecycleRepository({
      remoteRequest: vi.fn().mockResolvedValue(
        remoteSuccess(
          accountView({
            attempt: { id: attemptId, phase: 'waiting-browser', authorizeUrl: url },
          }),
        ),
      ),
      openRemoteStream: vi.fn(),
    })
    const launch = vi.fn()
    repository.subscribeAuthorizationLaunch(launch)

    await expect(repository.getState()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(launch).not.toHaveBeenCalled()
  })

  it('rejects unsupported expiry frames and propagates the stream failure', async () => {
    const openRemoteStream = vi.fn<AccountRemoteTransport['openRemoteStream']>(() => ({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve()
        yield { type: 'expired', token: 'must-not-be-read' }
      },
    }))
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest: vi.fn(), openRemoteStream })

    await expect(async () => {
      for await (const event of repository.watchExpiry(new AbortController().signal)) {
        expect(event).toBe('never-emitted')
      }
    }).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('unsubscribes Host-only launch effects without retaining listeners', async () => {
    const repository = new Rc172AccountLifecycleRepository({
      remoteRequest: vi
        .fn()
        .mockResolvedValue(
          remoteSuccess(accountView({ attempt: { id: attemptId, phase: 'waiting-browser', authorizeUrl } })),
        ),
      openRemoteStream: vi.fn(),
    })
    const listener = vi.fn()
    const release = repository.subscribeAuthorizationLaunch(listener)
    release()

    await repository.getState()

    expect(listener).not.toHaveBeenCalled()
  })
})
