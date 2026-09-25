import { describe, expect, it, vi, type MockedFunction, type MockedObject } from 'vitest'

import type {
  AccountBalanceQuery,
  AccountBonusBatch,
  AccountAuthorizationLaunch,
  AccountLifecycleRepository,
  AccountLifecycleSnapshot,
  AccountProfileQuery,
} from '@dsh-vscode/domain'
import { AccountLifecycleUseCases } from '@dsh-vscode/application'
import { AccountLifecycleHost, type AccountLifecycleHostDependencies } from './account-lifecycle-host.js'

const attemptId = 'd80ff092-0cdd-4a34-b5fb-05503d8574d8'
const client = { version: '0.2.3', locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }
const snapshot: AccountLifecycleSnapshot = { status: 'signed-out', attempt: null }
const waiting: AccountLifecycleSnapshot = {
  status: 'signed-out',
  attempt: { id: attemptId, phase: 'waiting-browser', expiresAt: 1_900_000_000_000 },
}
const signedIn: AccountLifecycleSnapshot = {
  status: 'credential-stored',
  attempt: { id: attemptId, phase: 'succeeded' },
}
const authorizeUrl =
  'https://platform.deepseek.com/dsh/authorize?state=pkce-state&code_challenge=pkce-challenge'

function blockedStream<T>(signal: AbortSignal, release: () => void): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T, void> {
      let closed = false
      let wake: (() => void) | undefined
      const close = (): void => {
        if (closed) return
        closed = true
        signal.removeEventListener('abort', close)
        release()
        wake?.()
      }
      return {
        next: (): Promise<IteratorResult<T, void>> => {
          if (closed) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve) => {
            wake = () => resolve({ done: true, value: undefined })
            if (signal.aborted) close()
            else signal.addEventListener('abort', close, { once: true })
          })
        },
        return: (): Promise<IteratorResult<T, void>> => {
          close()
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}

interface AccountLifecycleHarness {
  host: AccountLifecycleHost
  readonly repo: MockedObject<AccountLifecycleRepository>
  readonly launchListeners: Set<(launch: AccountAuthorizationLaunch) => void>
  readonly streamReleases: string[]
  readonly published: AccountLifecycleSnapshot[]
  readonly errors: string[]
  readonly openExternal: MockedFunction<AccountLifecycleHostDependencies['openExternal']>
  readonly confirmSignOut: MockedFunction<AccountLifecycleHostDependencies['confirmSignOut']>
  readonly publishSessionExpired: MockedFunction<AccountLifecycleHostDependencies['publishSessionExpired']>
  readonly initializeDefaultModel: MockedFunction<
    NonNullable<AccountLifecycleHostDependencies['initializeDefaultModel']>
  >
  readonly reportDiagnostic: MockedFunction<NonNullable<AccountLifecycleHostDependencies['reportDiagnostic']>>
}

function harness(
  overrides: Partial<MockedObject<AccountLifecycleRepository>> = {},
  enableDefaultModelInitialization = true,
  now: () => number = Date.now,
): AccountLifecycleHarness {
  const launchListeners = new Set<(launch: AccountAuthorizationLaunch) => void>()
  const streamReleases: string[] = []
  const published: AccountLifecycleSnapshot[] = []
  const errors: string[] = []
  const publishSessionExpired = vi.fn()
  const repo = {
    getState: vi.fn().mockResolvedValue(snapshot),
    startSignIn: vi.fn().mockResolvedValue(waiting),
    cancelSignIn: vi
      .fn()
      .mockResolvedValue({ ...waiting, attempt: { ...waiting.attempt!, phase: 'cancelled' } }),
    hasRunningAccountTasks: vi.fn().mockResolvedValue(false),
    signOut: vi.fn().mockResolvedValue(snapshot),
    watch: vi.fn((signal: AbortSignal): AsyncIterable<AccountLifecycleSnapshot> =>
      blockedStream<AccountLifecycleSnapshot>(signal, () => streamReleases.push('state')),
    ),
    watchExpiry: vi.fn((signal: AbortSignal): AsyncIterable<'session-expired'> =>
      blockedStream<'session-expired'>(signal, () => streamReleases.push('expiry')),
    ),
    subscribeAuthorizationLaunch: vi.fn((listener: (launch: AccountAuthorizationLaunch) => void) => {
      launchListeners.add(listener)
      return () => {
        launchListeners.delete(listener)
      }
    }),
    getProfile: vi.fn().mockResolvedValue(null),
    getBalance: vi.fn().mockResolvedValue(null),
    getUnnotifiedBonuses: vi.fn().mockResolvedValue(null),
    ackBonusNotified: vi.fn().mockResolvedValue(false),
    getAccountPageUrl: vi.fn().mockResolvedValue('https://platform.deepseek.com/usage'),
    ...overrides,
  } satisfies MockedObject<AccountLifecycleRepository>
  const useCases = new AccountLifecycleUseCases(repo)
  const openExternal = vi.fn().mockResolvedValue(true)
  const confirmSignOut = vi.fn().mockResolvedValue(true)
  const initializeDefaultModel = vi.fn().mockResolvedValue(undefined)
  const reportDiagnostic = vi.fn()
  const host = new AccountLifecycleHost({
    useCases,
    endpoint: () => ({ host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' }),
    client: () => client,
    openExternal,
    ...(enableDefaultModelInitialization ? { initializeDefaultModel, reportDiagnostic } : {}),
    publishSnapshot: (value) => published.push(value),
    publishSessionExpired,
    reportError: (code) => errors.push(code),
    confirmSignOut,
    now,
  })
  return {
    host,
    repo,
    launchListeners,
    streamReleases,
    published,
    errors,
    openExternal,
    confirmSignOut,
    publishSessionExpired,
    initializeDefaultModel,
    reportDiagnostic,
  }
}

describe('AccountLifecycleHost', () => {
  it('uses only a validated DSH loopback baseUrl as callbackOrigin', async () => {
    const active = harness()
    active.host.start()
    await active.host.startSignIn()
    expect(active.repo.startSignIn.mock.calls).toEqual([
      [client, 'http://127.0.0.1:3080', 'desktop', expect.any(AbortSignal)],
    ])
    await active.host.dispose()

    const invalid = harness()
    invalid.host = new AccountLifecycleHost({
      useCases: new AccountLifecycleUseCases(invalid.repo),
      endpoint: () => ({
        host: '127.0.0.1',
        port: 3080,
        baseUrl: 'http://127.0.0.1:3080/?token=host-secret',
      }),
      client: () => client,
      openExternal: invalid.openExternal,
      publishSnapshot: () => undefined,
      publishSessionExpired: () => undefined,
      reportError: () => undefined,
      confirmSignOut: () => Promise.resolve(true),
    })
    invalid.host.start()
    await expect(invalid.host.startSignIn()).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
    expect(invalid.repo.startSignIn.mock.calls).toHaveLength(0)
    await invalid.host.dispose()
  })

  it('opens the Host-only authorization effect only for a user-started attempt and preserves its query', async () => {
    let resolveStart!: (value: AccountLifecycleSnapshot) => void
    const startSignIn = vi.fn(
      () =>
        new Promise<AccountLifecycleSnapshot>((resolve) => {
          resolveStart = resolve
        }),
    )
    const active = harness({ startSignIn })
    active.host.start()
    const start = active.host.startSignIn()
    const listener = [...active.launchListeners][0]
    if (listener === undefined) throw new Error('missing authorization listener')
    listener({ attemptId, url: authorizeUrl })
    resolveStart(waiting)
    await expect(start).resolves.toEqual(waiting)
    await vi.waitFor(() => expect(active.openExternal).toHaveBeenCalledExactlyOnceWith(authorizeUrl))
    expect(active.repo.startSignIn.mock.calls).toEqual([
      [client, 'http://127.0.0.1:3080', 'desktop', expect.any(AbortSignal)],
    ])
    expect(active.published).not.toContainEqual(expect.objectContaining({ authorizeUrl }))

    listener({ attemptId, url: authorizeUrl })
    await Promise.resolve()
    expect(active.openExternal).toHaveBeenCalledTimes(1)
    await active.host.dispose()
  })

  it('does not launch authorization URLs from a replayed state without a matching local sign-in request', async () => {
    const active = harness()
    active.host.start()
    const listener = [...active.launchListeners][0]
    if (listener === undefined) throw new Error('missing authorization listener')
    listener({ attemptId, url: authorizeUrl })
    await Promise.resolve()

    expect(active.openExternal).not.toHaveBeenCalled()
    await active.host.dispose()
  })

  it('publishes the reconnect-safe account baseline and forwards session-expired notifications', async () => {
    const active = harness({
      watch: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          yield snapshot
        },
      })),
      watchExpiry: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          yield 'session-expired' as const
        },
      })),
    })
    active.host.start()

    await vi.waitFor(() => expect(active.published).toEqual([snapshot]))
    await vi.waitFor(() => expect(active.publishSessionExpired).toHaveBeenCalledOnce())
    expect(active.published[0]).not.toHaveProperty('authorizeUrl')
    await active.host.dispose()
  })

  it('initializes the default model once on the successful account-state edge', async () => {
    const active = harness({
      watch: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          yield waiting
          yield signedIn
          yield signedIn
        },
      })),
    })
    active.host.start()

    await vi.waitFor(() => expect(active.initializeDefaultModel).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(active.initializeDefaultModel).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal)),
    )
    await active.host.dispose()
  })

  it('does not repeat initialization when a reconnected stream starts from an already-succeeded attempt', async () => {
    const active = harness({
      watch: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          yield signedIn
        },
      })),
    })
    active.host.start()

    await vi.waitFor(() => expect(active.published).toEqual([signedIn]))
    expect(active.initializeDefaultModel).not.toHaveBeenCalled()
    await active.host.dispose()
  })

  it('handles a successful sign-in response even if the state stream has not delivered its edge yet', async () => {
    const active = harness({ startSignIn: vi.fn().mockResolvedValue(signedIn) })
    active.host.start()

    await expect(active.host.startSignIn()).resolves.toEqual(signedIn)
    expect(active.initializeDefaultModel).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    await active.host.dispose()
  })

  it('keeps default-model initialization failure Host-only and non-fatal to account state', async () => {
    const active = harness({
      watch: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve()
          yield waiting
          yield signedIn
        },
      })),
    })
    active.initializeDefaultModel.mockRejectedValue(new Error('private Remote diagnostic'))
    active.host.start()

    await vi.waitFor(() => expect(active.reportDiagnostic).toHaveBeenCalledOnce())
    expect(active.reportDiagnostic).toHaveBeenCalledExactlyOnceWith()
    expect(active.errors).toEqual([])
    expect(active.published).toContainEqual(signedIn)
    await active.host.dispose()
  })

  it('keeps the optional default-model operation absent for older adapter profiles', async () => {
    const active = harness(
      {
        watch: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve()
            yield waiting
            yield signedIn
          },
        })),
      },
      false,
    )
    active.host.start()

    await vi.waitFor(() => expect(active.published).toContainEqual(signedIn))
    expect(active.initializeDefaultModel).not.toHaveBeenCalled()
    await active.host.dispose()
  })

  it('cancels only the named DSH attempt when the system browser cannot open', async () => {
    const active = harness({ startSignIn: vi.fn().mockResolvedValue(waiting) })
    active.openExternal.mockResolvedValue(false)
    active.host.start()
    await active.host.startSignIn()
    const listener = [...active.launchListeners][0]
    if (listener === undefined) throw new Error('missing authorization listener')
    listener({ attemptId, url: authorizeUrl })
    await vi.waitFor(() =>
      expect(active.repo.cancelSignIn.mock.calls).toEqual([[attemptId, expect.any(AbortSignal)]]),
    )
    expect(active.errors).toContain('browser-open-failed')
    await active.host.dispose()
  })

  it('re-checks sign-out impact and never signs out until Host confirmation succeeds', async () => {
    const active = harness({ hasRunningAccountTasks: vi.fn().mockResolvedValue(true) })
    active.confirmSignOut.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    active.host.start()

    await expect(active.host.signOut()).resolves.toBeUndefined()
    expect(active.confirmSignOut).toHaveBeenNthCalledWith(1, 'running')
    expect(active.repo.signOut.mock.calls).toHaveLength(0)

    await expect(active.host.signOut()).resolves.toEqual(snapshot)
    expect(active.confirmSignOut).toHaveBeenNthCalledWith(2, 'running')
    expect(active.repo.signOut.mock.calls).toEqual([[client, expect.any(AbortSignal)]])
    await active.host.dispose()
  })

  it('keeps an unavailable impact as unknown and fails closed when the Host prompt is declined', async () => {
    const active = harness({
      hasRunningAccountTasks: vi.fn().mockRejectedValue(new Error('private backend error')),
    })
    active.confirmSignOut.mockResolvedValue(false)
    active.host.start()

    await expect(active.host.signOut()).resolves.toBeUndefined()
    expect(active.confirmSignOut).toHaveBeenCalledExactlyOnceWith('unknown')
    expect(active.repo.signOut.mock.calls).toHaveLength(0)
    await active.host.dispose()
  })

  it('releases both DSH streams and the authorization listener on disposal', async () => {
    const active = harness()
    active.host.start()
    await active.host.dispose()

    expect([...active.launchListeners]).toHaveLength(0)
    expect(active.streamReleases.sort()).toEqual(['expiry', 'state'])
    expect(active.repo.watch.mock.calls).toEqual([[expect.any(AbortSignal)]])
    expect(active.repo.watchExpiry.mock.calls).toEqual([[expect.any(AbortSignal)]])
  })

  it('projects profile, normal/bonus balances, and a notice without account identity or avatar URL', async () => {
    const profile: AccountProfileQuery = {
      status: 'ready',
      value: {
        id: null,
        name: '用户甲',
        contact: 'u***@example.test',
        avatarUrl: 'https://images.example.test/private-avatar.png',
      },
    }
    const balance: AccountBalanceQuery = {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '20.50' }],
      bonusWallets: [{ currency: 'CNY', balance: '3.25' }],
    }
    const batch: AccountBonusBatch = {
      accountId: 'account-1',
      bonuses: [
        {
          orderId: '0bd8870d-2648-4c4c-95ca-d9e89f08095c',
          campaign: 'launch',
          amount: '10.00',
          currency: 'CNY',
          grantedAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2099-10-01T00:00:00.000Z',
          message: '赠金已到账',
        },
      ],
    }
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi.fn().mockResolvedValue(profile),
      getBalance: vi.fn().mockResolvedValue(balance),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue(batch),
    })
    active.host.start()

    await expect(active.host.readDetails()).resolves.toEqual({
      profile: { status: 'ready', value: { name: '用户甲', contact: 'u***@example.test' } },
      balance: {
        status: 'ready',
        value: {
          wallets: [{ currency: 'CNY', balance: '20.50' }],
          bonusWallets: [{ currency: 'CNY', balance: '3.25' }],
        },
      },
      bonus: {
        status: 'ready',
        value: {
          orderId: '0bd8870d-2648-4c4c-95ca-d9e89f08095c',
          message: '赠金已到账',
          amount: '10.00',
          currency: 'CNY',
          expiresAt: '2099-10-01T00:00:00.000Z',
        },
      },
      accountScopeRevision: 1,
    })
    const serialized = JSON.stringify(await active.host.readDetails())
    expect(serialized).not.toContain('account-1')
    expect(serialized).not.toContain('private-avatar')
    await active.host.dispose()
  })

  it('filters bonus expiry with the Host clock', async () => {
    const active = harness(
      {
        getState: vi.fn().mockResolvedValue(signedIn),
        getUnnotifiedBonuses: vi.fn().mockResolvedValue({
          accountId: 'account-1',
          bonuses: [
            {
              orderId: '0bd8870d-2648-4c4c-95ca-d9e89f08095c',
              campaign: 'launch',
              amount: '1',
              currency: 'USD',
              grantedAt: '1969-12-31T00:00:00.000Z',
              expiresAt: '1970-01-01T00:00:01.000Z',
              message: 'bonus',
            },
          ],
        }),
      },
      true,
      () => 0,
    )
    active.host.start()

    await expect(active.host.readDetails()).resolves.toMatchObject({
      bonus: { status: 'ready', value: { orderId: '0bd8870d-2648-4c4c-95ca-d9e89f08095c' } },
    })
    await active.host.dispose()
  })

  it('keeps account identity in the Host and acknowledges only a notice returned by its current read', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi
        .fn()
        .mockResolvedValue({ status: 'ready', value: { id: 'account-1', name: null, contact: null } }),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue({
        accountId: 'account-1',
        bonuses: [
          {
            orderId,
            campaign: 'launch',
            amount: '1',
            currency: 'USD',
            grantedAt: '2026-09-01',
            expiresAt: '2099-10-01',
            message: 'bonus',
          },
        ],
      }),
      ackBonusNotified: vi.fn().mockResolvedValue(true),
    })
    active.host.start()
    await active.host.readDetails()

    await expect(active.host.acknowledgeBonus('unknown-order')).resolves.toBe(false)
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(true)
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(false)
    expect(active.repo.ackBonusNotified.mock.calls).toEqual([
      ['account-1', orderId, client, expect.any(AbortSignal)],
    ])
    await active.host.dispose()
  })

  it('retains an empty but valid RC2 AccountUserId only inside the Host acknowledgement scope', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue({
        accountId: '',
        bonuses: [
          {
            orderId,
            campaign: 'launch',
            amount: '1',
            currency: 'USD',
            grantedAt: '2026-09-01',
            expiresAt: '2099-10-01',
            message: 'bonus',
          },
        ],
      }),
      ackBonusNotified: vi.fn().mockResolvedValue(true),
    })
    active.host.start()

    await expect(active.host.readDetails()).resolves.toMatchObject({
      accountScopeRevision: 1,
      bonus: { status: 'ready', value: { orderId } },
    })
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(true)
    expect(active.repo.ackBonusNotified.mock.calls[0]?.[0]).toBe('')
    await active.host.dispose()
  })

  it('retains the account scope through a transient bonus-read failure so the ack can retry', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const batch: AccountBonusBatch = {
      accountId: 'account-1',
      bonuses: [
        {
          orderId,
          campaign: 'launch',
          amount: '1',
          currency: 'USD',
          grantedAt: '2026-09-01',
          expiresAt: '2099-10-01',
          message: 'bonus',
        },
      ],
    }
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi.fn().mockResolvedValue({
        status: 'ready',
        value: { id: 'account-1', name: null, contact: null },
      }),
      getUnnotifiedBonuses: vi.fn().mockResolvedValueOnce(batch).mockRejectedValueOnce(new Error('offline')),
      ackBonusNotified: vi.fn().mockResolvedValue(true),
    })
    active.host.start()
    await expect(active.host.readDetails()).resolves.toMatchObject({ accountScopeRevision: 1 })
    await expect(active.host.readDetails()).resolves.toMatchObject({
      bonus: { status: 'failed' },
      accountScopeRevision: 1,
    })
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(true)
    expect(active.repo.ackBonusNotified.mock.calls).toHaveLength(1)
    await active.host.dispose()
  })

  it('changes account scope when profile proves an account switch during a failed bonus read', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi
        .fn()
        .mockResolvedValueOnce({ status: 'ready', value: { id: 'account-1', name: null, contact: null } })
        .mockResolvedValueOnce({ status: 'ready', value: { id: 'account-2', name: null, contact: null } }),
      getUnnotifiedBonuses: vi
        .fn()
        .mockResolvedValueOnce({
          accountId: 'account-1',
          bonuses: [
            {
              orderId,
              campaign: 'launch',
              amount: '1',
              currency: 'USD',
              grantedAt: '2026-09-01',
              expiresAt: '2099-10-01',
              message: 'old account bonus',
            },
          ],
        })
        .mockRejectedValueOnce(new Error('temporary bonus query failure')),
    })
    active.host.start()

    await expect(active.host.readDetails()).resolves.toMatchObject({ accountScopeRevision: 1 })
    await expect(active.host.readDetails()).resolves.toMatchObject({
      bonus: { status: 'failed' },
      accountScopeRevision: 2,
    })
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(false)
    expect(active.repo.ackBonusNotified.mock.calls).toHaveLength(0)
    await active.host.dispose()
  })

  it('does not infer an account switch from a profile without a stable identity during bonus failure', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi
        .fn()
        .mockResolvedValueOnce({ status: 'ready', value: { id: 'account-1', name: null, contact: null } })
        .mockResolvedValueOnce({ status: 'failed' }),
      getUnnotifiedBonuses: vi
        .fn()
        .mockResolvedValueOnce({
          accountId: 'account-1',
          bonuses: [
            {
              orderId,
              campaign: 'launch',
              amount: '1',
              currency: 'USD',
              grantedAt: '2026-09-01',
              expiresAt: '2099-10-01',
              message: 'same account bonus',
            },
          ],
        })
        .mockRejectedValueOnce(new Error('temporary bonus query failure')),
      ackBonusNotified: vi.fn().mockResolvedValue(true),
    })
    active.host.start()

    await expect(active.host.readDetails()).resolves.toMatchObject({ accountScopeRevision: 1 })
    await expect(active.host.readDetails()).resolves.toMatchObject({
      bonus: { status: 'failed' },
      accountScopeRevision: 1,
    })
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(true)
    expect(active.repo.ackBonusNotified.mock.calls[0]?.[0]).toBe('account-1')
    await active.host.dispose()
  })

  it('increments the safe account scope revision once when a known scope is cleared', async () => {
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue({ accountId: 'account-1', bonuses: [] }),
    })
    active.host.start()

    await expect(active.host.readDetails()).resolves.toMatchObject({ accountScopeRevision: 1 })
    active.repo.getUnnotifiedBonuses.mockResolvedValue(null)
    await expect(active.host.readDetails()).resolves.toMatchObject({
      bonus: { status: 'unavailable' },
      accountScopeRevision: 2,
    })
    await expect(active.host.readDetails()).resolves.toMatchObject({
      bonus: { status: 'unavailable' },
      accountScopeRevision: 2,
    })
    await active.host.dispose()
  })

  it('drops a prior notice acknowledgement scope when a complete read names another account', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi.fn().mockResolvedValue({
        status: 'ready',
        value: { id: 'account-1', name: null, contact: null },
      }),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue({
        accountId: 'account-1',
        bonuses: [
          {
            orderId,
            campaign: 'launch',
            amount: '1',
            currency: 'USD',
            grantedAt: '2026-09-01',
            expiresAt: '2099-10-01',
            message: 'bonus',
          },
        ],
      }),
    })
    active.host.start()
    await active.host.readDetails()
    active.repo.getProfile.mockResolvedValue({
      status: 'ready',
      value: { id: 'account-2', name: null, contact: null },
    })
    active.repo.getUnnotifiedBonuses.mockResolvedValue({ accountId: 'account-2', bonuses: [] })

    await expect(active.host.readDetails()).resolves.toMatchObject({
      bonus: { status: 'ready', value: null },
    })
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(false)
    expect(active.repo.ackBonusNotified.mock.calls).toHaveLength(0)
    await active.host.dispose()
  })

  it('retains a displayed notice scope when the same account has no remaining unnotified bonus', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi.fn().mockResolvedValue({
        status: 'ready',
        value: { id: 'account-1', name: null, contact: null },
      }),
      getUnnotifiedBonuses: vi.fn().mockResolvedValueOnce({
        accountId: 'account-1',
        bonuses: [
          {
            orderId,
            campaign: 'launch',
            amount: '1',
            currency: 'USD',
            grantedAt: '2026-09-01',
            expiresAt: '2099-10-01',
            message: 'bonus',
          },
        ],
      }),
    })
    active.host.start()
    await active.host.readDetails()
    active.repo.getUnnotifiedBonuses.mockResolvedValue({ accountId: 'account-1', bonuses: [] })
    await expect(active.host.readDetails()).resolves.toMatchObject({
      bonus: { status: 'ready', value: null },
    })
    active.repo.ackBonusNotified.mockResolvedValue(true)
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(true)
    expect(active.repo.ackBonusNotified.mock.calls).toEqual([
      ['account-1', orderId, client, expect.any(AbortSignal)],
    ])
    await active.host.dispose()
  })

  it('deduplicates concurrent acknowledgement requests for the same bonus', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi.fn().mockResolvedValue({
        status: 'ready',
        value: { id: 'account-1', name: null, contact: null },
      }),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue({
        accountId: 'account-1',
        bonuses: [
          {
            orderId,
            campaign: 'launch',
            amount: '1',
            currency: 'USD',
            grantedAt: '2026-09-01',
            expiresAt: '2099-10-01',
            message: 'bonus',
          },
        ],
      }),
    })
    let resolveAcknowledgement!: (accepted: boolean) => void
    active.repo.ackBonusNotified.mockImplementation(
      () => new Promise<boolean>((resolve) => (resolveAcknowledgement = resolve)),
    )
    active.host.start()
    await active.host.readDetails()

    const first = active.host.acknowledgeBonus(orderId)
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(false)
    expect(active.repo.ackBonusNotified.mock.calls).toHaveLength(1)
    resolveAcknowledgement(true)
    await expect(first).resolves.toBe(true)
    await active.host.dispose()
  })

  it.each(['accepted', 'failed'] as const)(
    'discards a stale %s acknowledgement after its account scope changes',
    async (outcome) => {
      const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
      const bonusBatch = (accountId: string): AccountBonusBatch => ({
        accountId,
        bonuses: [
          {
            orderId,
            campaign: 'launch',
            amount: '1',
            currency: 'USD',
            grantedAt: '2026-09-01',
            expiresAt: '2099-10-01',
            message: 'bonus',
          },
        ],
      })
      const active = harness({
        getState: vi.fn().mockResolvedValue(signedIn),
        getProfile: vi
          .fn()
          .mockResolvedValueOnce({ status: 'ready', value: { id: 'account-1', name: null, contact: null } })
          .mockResolvedValueOnce({ status: 'ready', value: { id: 'account-2', name: null, contact: null } }),
        getUnnotifiedBonuses: vi
          .fn()
          .mockResolvedValueOnce(bonusBatch('account-1'))
          .mockResolvedValueOnce(bonusBatch('account-2')),
      })
      let settleFirstAcknowledgement!: {
        readonly resolve: (accepted: boolean) => void
        readonly reject: (reason?: unknown) => void
      }
      active.repo.ackBonusNotified
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve, reject) => {
              settleFirstAcknowledgement = { resolve, reject }
            }),
        )
        .mockResolvedValueOnce(true)
      active.host.start()
      await expect(active.host.readDetails()).resolves.toMatchObject({ accountScopeRevision: 1 })

      const staleAcknowledgement = active.host.acknowledgeBonus(orderId)
      await expect(active.host.readDetails()).resolves.toMatchObject({ accountScopeRevision: 2 })
      const currentAcknowledgement = active.host.acknowledgeBonus(orderId)
      if (outcome === 'accepted') settleFirstAcknowledgement.resolve(true)
      else settleFirstAcknowledgement.reject(new Error('stale account request failed'))

      await expect(staleAcknowledgement).resolves.toBe(false)
      await expect(currentAcknowledgement).resolves.toBe(true)
      expect(active.repo.ackBonusNotified.mock.calls.map(([accountId]) => accountId)).toEqual([
        'account-1',
        'account-2',
      ])
      await active.host.dispose()
    },
  )

  it('keeps a current-scope bonus eligible for retry after an acknowledgement error', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue({
        accountId: 'account-1',
        bonuses: [
          {
            orderId,
            campaign: 'launch',
            amount: '1',
            currency: 'USD',
            grantedAt: '2026-09-01',
            expiresAt: '2099-10-01',
            message: 'bonus',
          },
        ],
      }),
    })
    const failure = new Error('temporary acknowledgement failure')
    active.repo.ackBonusNotified.mockRejectedValueOnce(failure).mockResolvedValueOnce(true)
    active.host.start()
    await active.host.readDetails()

    await expect(active.host.acknowledgeBonus(orderId)).rejects.toBe(failure)
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(true)
    expect(active.repo.ackBonusNotified.mock.calls.map(([accountId]) => accountId)).toEqual([
      'account-1',
      'account-1',
    ])
    await active.host.dispose()
  })

  it('does not make account detail requests while signed out and clears bonus scope', async () => {
    const active = harness({ getState: vi.fn().mockResolvedValue(snapshot) })
    active.host.start()

    await expect(active.host.readDetails()).resolves.toEqual({
      profile: { status: 'unavailable' },
      balance: { status: 'unavailable' },
      bonus: { status: 'unavailable' },
      accountScopeRevision: 0,
    })
    expect(active.repo.getProfile.mock.calls).toHaveLength(0)
    expect(active.repo.getBalance.mock.calls).toHaveLength(0)
    expect(active.repo.getUnnotifiedBonuses.mock.calls).toHaveLength(0)
    await active.host.dispose()
  })

  it('does not let a stale signed-out details read clear a newer account scope', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    let resolveStaleState!: (value: AccountLifecycleSnapshot) => void
    let stateCalls = 0
    const active = harness({
      getState: vi.fn().mockImplementation(() => {
        stateCalls += 1
        if (stateCalls === 1)
          return new Promise<AccountLifecycleSnapshot>((resolve) => {
            resolveStaleState = resolve
          })
        return Promise.resolve(signedIn)
      }),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue({
        accountId: 'account-2',
        bonuses: [
          {
            orderId,
            campaign: 'launch',
            amount: '1',
            currency: 'USD',
            grantedAt: '2026-09-01',
            expiresAt: '2099-10-01',
            message: 'current account bonus',
          },
        ],
      }),
      ackBonusNotified: vi.fn().mockResolvedValue(true),
    })
    active.host.start()

    const staleRead = active.host.readDetails()
    const currentRead = await active.host.readDetails()
    expect(currentRead).toMatchObject({
      accountScopeRevision: 1,
      bonus: { status: 'ready', value: { orderId } },
    })

    resolveStaleState(snapshot)
    await expect(staleRead).resolves.toMatchObject({ accountScopeRevision: 1 })
    await expect(active.host.acknowledgeBonus(orderId)).resolves.toBe(true)
    expect(active.repo.ackBonusNotified.mock.calls[0]?.[0]).toBe('account-2')
    await active.host.dispose()
  })

  it('keeps profile, wallet, and bonus query failures independent and propagates cancellation', async () => {
    const active = harness({
      getState: vi.fn().mockResolvedValue(signedIn),
      getProfile: vi.fn().mockRejectedValue(new Error('profile offline')),
      getBalance: vi.fn().mockResolvedValue({
        status: 'ready',
        value: [{ currency: 'USD', balance: '2.50' }],
        bonusWallets: [],
      }),
      getUnnotifiedBonuses: vi.fn().mockRejectedValue(new Error('bonus offline')),
    })
    active.host.start()

    await expect(active.host.readDetails()).resolves.toEqual({
      profile: { status: 'failed' },
      balance: {
        status: 'ready',
        value: { wallets: [{ currency: 'USD', balance: '2.50' }], bonusWallets: [] },
      },
      bonus: { status: 'failed' },
      accountScopeRevision: 0,
    })
    await active.host.dispose()

    const cancelled = harness({ getState: vi.fn().mockResolvedValue(signedIn) })
    cancelled.host.start()
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(cancelled.host.readDetails(controller.signal)).rejects.toBe(controller.signal.reason)
    expect(cancelled.repo.getProfile.mock.calls).toHaveLength(0)
    await cancelled.host.dispose()
  })

  it('opens only the validated official Usage or Top Up page through the Host', async () => {
    const active = harness({
      getAccountPageUrl: vi.fn().mockResolvedValue('https://platform.deepseek.com/top_up'),
    })
    active.host.start()

    await active.host.openAccountPage('top-up')
    expect(active.openExternal).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/top_up')
    expect(active.repo.getAccountPageUrl.mock.calls).toEqual([['top-up', expect.any(AbortSignal)]])
    await active.host.dispose()

    const rejected = harness({
      getAccountPageUrl: vi.fn().mockResolvedValue('https://attacker.example/top_up'),
    })
    rejected.host.start()
    await expect(rejected.host.openAccountPage('top-up')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(rejected.openExternal).not.toHaveBeenCalled()
    await rejected.host.dispose()
  })
})
