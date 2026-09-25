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

  it('reads profile, normal and bonus wallets, and bonus notices through the pinned account Remotes', async () => {
    const bonus = {
      orderId: '0bd8870d-2648-4c4c-95ca-d9e89f08095c',
      campaign: 'launch',
      amount: '10.00',
      currency: 'CNY',
      grantedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z',
      message: '赠金已到账',
    }
    const remoteRequest = vi
      .fn<AccountRemoteTransport['remoteRequest']>()
      .mockResolvedValueOnce(
        remoteSuccess({
          status: 'ready',
          value: {
            id: 'account-1',
            name: '用户',
            contact: 'u***@example.test',
            avatarUrl: 'https://img.example/a',
          },
        }),
      )
      .mockResolvedValueOnce(
        remoteSuccess({
          status: 'ready',
          value: [{ currency: 'CNY', balance: '20.50' }],
          bonusWallets: [{ currency: 'CNY', balance: '3.25' }],
        }),
      )
      .mockResolvedValueOnce(remoteSuccess({ accountId: 'account-1', bonuses: [bonus] }))
      .mockResolvedValueOnce(remoteSuccess(true))
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })

    await expect(repository.getProfile(client)).resolves.toEqual({
      status: 'ready',
      value: {
        id: 'account-1',
        name: '用户',
        contact: 'u***@example.test',
        avatarUrl: 'https://img.example/a',
      },
    })
    await expect(repository.getBalance(client)).resolves.toEqual({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '20.50' }],
      bonusWallets: [{ currency: 'CNY', balance: '3.25' }],
    })
    await expect(repository.getUnnotifiedBonuses(client)).resolves.toEqual({
      accountId: 'account-1',
      bonuses: [bonus],
    })
    await expect(repository.ackBonusNotified('account-1', bonus.orderId, client)).resolves.toBe(true)
    expect(remoteRequest.mock.calls.map(([endpoint, args]) => [endpoint, args])).toEqual([
      ['account/getProfile', { client }],
      ['account/getBalance', { client }],
      ['account/getUnnotifiedBonuses', { client }],
      ['account/ackBonusNotified', { accountId: 'account-1', orderId: bonus.orderId, client }],
    ])
  })

  it('preserves independent failed and absent profile/balance outcomes', async () => {
    const remoteRequest = vi
      .fn<AccountRemoteTransport['remoteRequest']>()
      .mockResolvedValueOnce(remoteSuccess({ status: 'failed' }))
      .mockResolvedValueOnce(remoteSuccess(null))
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })

    await expect(repository.getProfile(client)).resolves.toEqual({ status: 'failed' })
    await expect(repository.getBalance(client)).resolves.toBeNull()
  })

  it('forwards request cancellation and preserves transport failures for detail calls', async () => {
    const controller = new AbortController()
    const timeout = new Error('request timeout')
    const remoteRequest = vi.fn<AccountRemoteTransport['remoteRequest']>().mockRejectedValue(timeout)
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })

    await expect(repository.getProfile(client, controller.signal)).rejects.toBe(timeout)
    expect(remoteRequest).toHaveBeenCalledExactlyOnceWith('account/getProfile', { client }, controller.signal)

    const cancelled = new AbortController()
    cancelled.abort(new DOMException('cancelled', 'AbortError'))
    const cancellation = cancelled.signal.reason as Error
    const abortingTransport = vi.fn<AccountRemoteTransport['remoteRequest']>().mockRejectedValue(cancellation)
    const abortingRepository = new Rc172AccountLifecycleRepository({
      remoteRequest: abortingTransport,
      openRemoteStream: vi.fn(),
    })

    await expect(abortingRepository.getBalance(client, cancelled.signal)).rejects.toBe(cancellation)
    expect(abortingTransport).toHaveBeenCalledExactlyOnceWith(
      'account/getBalance',
      { client },
      cancelled.signal,
    )
  })

  it.each([
    ['account/getProfile', { status: 'ready', value: { id: 'account', name: 'name' } }],
    ['account/getBalance', { status: 'ready', value: [{ currency: 'BTC', balance: '1' }], bonusWallets: [] }],
    ['account/getUnnotifiedBonuses', { accountId: 'account', bonuses: [{ orderId: 'not-an-id' }] }],
    ['account/getUnnotifiedBonuses', { accountId: 'account', bonuses: 'malformed' }],
    ['account/getUnnotifiedBonuses', { accountId: 'x'.repeat(257), bonuses: [] }],
  ] as const)('rejects malformed account response for %s', async (endpoint, value) => {
    const remoteRequest = vi
      .fn<AccountRemoteTransport['remoteRequest']>()
      .mockResolvedValue(remoteSuccess(value))
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })

    await expect(
      endpoint === 'account/getProfile'
        ? repository.getProfile(client)
        : endpoint === 'account/getBalance'
          ? repository.getBalance(client)
          : repository.getUnnotifiedBonuses(client),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('preserves the exact RC2 AccountUserId even when its string is empty', async () => {
    const remoteRequest = vi
      .fn<AccountRemoteTransport['remoteRequest']>()
      .mockResolvedValue(remoteSuccess({ accountId: '', bonuses: [] }))
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })

    await expect(repository.getUnnotifiedBonuses(client)).resolves.toEqual({ accountId: '', bonuses: [] })
  })

  it('resolves account pages from the account state but rejects destinations outside the official origin', async () => {
    const remoteRequest = vi
      .fn<AccountRemoteTransport['remoteRequest']>()
      .mockResolvedValueOnce(remoteSuccess(accountView({ status: 'credential-stored' })))
      .mockResolvedValueOnce(
        remoteSuccess(
          accountView({
            status: 'credential-stored',
            links: {
              usageUrl: 'https://platform.deepseek.com/usage',
              topUpUrl: 'https://attacker.example/top_up',
            },
          }),
        ),
      )
    const repository = new Rc172AccountLifecycleRepository({ remoteRequest, openRemoteStream: vi.fn() })

    await expect(repository.getAccountPageUrl('usage')).resolves.toBe('https://platform.deepseek.com/usage')
    await expect(repository.getAccountPageUrl('top-up')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(remoteRequest.mock.calls.map(([endpoint, args]) => [endpoint, args])).toEqual([
      ['account/getState', {}],
      ['account/getState', {}],
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
