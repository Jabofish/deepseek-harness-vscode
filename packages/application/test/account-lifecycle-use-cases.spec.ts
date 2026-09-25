import { describe, expect, it, vi, type MockedObject } from 'vitest'

import type { AccountLifecycleRepository, AccountLifecycleSnapshot } from '@dsh-vscode/domain'
import { AccountLifecycleUseCases } from '../src/use-cases/account-lifecycle-use-cases.js'

const client = { version: '0.2.3', locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }
const snapshot: AccountLifecycleSnapshot = {
  status: 'signed-out',
  attempt: { id: 'd80ff092-0cdd-4a34-b5fb-05503d8574d8', phase: 'initializing' },
}

function repository(
  overrides: Partial<MockedObject<AccountLifecycleRepository>> = {},
): MockedObject<AccountLifecycleRepository> {
  return {
    getState: vi.fn().mockResolvedValue(snapshot),
    startSignIn: vi.fn().mockResolvedValue(snapshot),
    cancelSignIn: vi.fn().mockResolvedValue(snapshot),
    hasRunningAccountTasks: vi.fn().mockResolvedValue(false),
    signOut: vi.fn().mockResolvedValue(snapshot),
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
    subscribeAuthorizationLaunch: vi.fn(() => () => undefined),
    getProfile: vi.fn().mockResolvedValue(null),
    getBalance: vi.fn().mockResolvedValue(null),
    getUnnotifiedBonuses: vi.fn().mockResolvedValue(null),
    ackBonusNotified: vi.fn().mockResolvedValue(false),
    getAccountPageUrl: vi.fn().mockResolvedValue('https://platform.deepseek.com/usage'),
    ...overrides,
  } satisfies MockedObject<AccountLifecycleRepository>
}

describe('AccountLifecycleUseCases', () => {
  it('validates and normalizes the Host callback origin before starting desktop sign-in', async () => {
    const backend = repository()
    const useCases = new AccountLifecycleUseCases(backend)

    await expect(useCases.startSignIn(client, 'http://localhost:3080', 'desktop')).resolves.toEqual(snapshot)
    expect(backend.startSignIn.mock.calls).toEqual([[client, 'http://localhost:3080', 'desktop', undefined]])
  })

  it.each([
    'https://127.0.0.1:3080',
    'http://example.com:3080',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:3080/path',
    'http://127.0.0.1:3080/?token=private',
  ])('rejects an unsupported callback origin %s before Remote', (callbackOrigin) => {
    const backend = repository()
    const useCases = new AccountLifecycleUseCases(backend)

    expect(() => useCases.startSignIn(client, callbackOrigin, 'desktop')).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    )
    expect(backend.startSignIn.mock.calls).toHaveLength(0)
  })

  it('uses only a valid attempt id for cancellation', async () => {
    const backend = repository()
    const useCases = new AccountLifecycleUseCases(backend)
    const id = 'd80ff092-0cdd-4a34-b5fb-05503d8574d8'

    await expect(useCases.cancelSignIn(id)).resolves.toEqual(snapshot)
    expect(backend.cancelSignIn.mock.calls).toEqual([[id, undefined]])
    expect(() => useCases.cancelSignIn('other-attempt')).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    )
    expect(backend.cancelSignIn.mock.calls).toHaveLength(1)
  })

  it('turns a running task lookup failure into unknown impact, while propagating cancellation', async () => {
    const backend = repository({ hasRunningAccountTasks: vi.fn().mockResolvedValue(true) })
    const useCases = new AccountLifecycleUseCases(backend)
    await expect(useCases.getSignOutImpact()).resolves.toBe('running')

    const unavailable = new AccountLifecycleUseCases(
      repository({ hasRunningAccountTasks: vi.fn().mockRejectedValue(new Error('DSH unavailable')) }),
    )
    await expect(unavailable.getSignOutImpact()).resolves.toBe('unknown')

    const controller = new AbortController()
    controller.abort()
    const cancelled = new AccountLifecycleUseCases(
      repository({ hasRunningAccountTasks: vi.fn().mockRejectedValue(controller.signal.reason) }),
    )
    await expect(cancelled.getSignOutImpact(controller.signal)).rejects.toBe(controller.signal.reason)
  })

  it('keeps sign-out explicit and passes current Host metadata to the repository', async () => {
    const backend = repository()
    const useCases = new AccountLifecycleUseCases(backend)

    await expect(useCases.signOut(client)).resolves.toEqual(snapshot)
    expect(backend.signOut.mock.calls).toEqual([[client, undefined]])
  })

  it('forwards account detail reads with validated Host metadata and signals', async () => {
    const controller = new AbortController()
    const backend = repository({
      getProfile: vi.fn().mockResolvedValue({ status: 'failed' }),
      getBalance: vi.fn().mockResolvedValue(null),
      getUnnotifiedBonuses: vi.fn().mockResolvedValue(null),
    })
    const useCases = new AccountLifecycleUseCases(backend)

    await expect(useCases.readProfile(client, controller.signal)).resolves.toEqual({ status: 'failed' })
    await expect(useCases.readBalance(client, controller.signal)).resolves.toBeNull()
    await expect(useCases.readUnnotifiedBonuses(client, controller.signal)).resolves.toBeNull()
    expect(backend.getProfile.mock.calls).toEqual([[client, controller.signal]])
    expect(backend.getBalance.mock.calls).toEqual([[client, controller.signal]])
    expect(backend.getUnnotifiedBonuses.mock.calls).toEqual([[client, controller.signal]])
  })

  it('validates bonus acknowledgement identifiers before Remote and forwards the opaque account scope', async () => {
    const orderId = '0bd8870d-2648-4c4c-95ca-d9e89f08095c'
    const backend = repository({ ackBonusNotified: vi.fn().mockResolvedValue(true) })
    const useCases = new AccountLifecycleUseCases(backend)

    await expect(useCases.ackBonusNotified('account-1', orderId, client)).resolves.toBe(true)
    expect(backend.ackBonusNotified.mock.calls).toEqual([['account-1', orderId, client, undefined]])
    expect(() => useCases.ackBonusNotified('bad\naccount', orderId, client)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    )
    expect(() => useCases.ackBonusNotified('account-1', 'not-an-order', client)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    )
    expect(backend.ackBonusNotified.mock.calls).toHaveLength(1)
  })

  it('forwards only the constrained account page selector', async () => {
    const backend = repository({
      getAccountPageUrl: vi.fn().mockResolvedValue('https://platform.deepseek.com/usage'),
    })
    const useCases = new AccountLifecycleUseCases(backend)

    await expect(useCases.getAccountPageUrl('usage')).resolves.toBe('https://platform.deepseek.com/usage')
    expect(backend.getAccountPageUrl.mock.calls).toEqual([['usage', undefined]])
  })

  it('forwards account state, expiry, and Host-only authorization subscriptions', async () => {
    const listener = vi.fn()
    const release = vi.fn()
    const backend = repository({ subscribeAuthorizationLaunch: vi.fn(() => release) })
    const useCases = new AccountLifecycleUseCases(backend)
    const lifetime = new AbortController().signal

    await expect(useCases.watch(lifetime)[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: snapshot,
      done: false,
    })
    await expect(useCases.watchExpiry(lifetime)[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: 'session-expired',
      done: false,
    })
    expect(useCases.subscribeAuthorizationLaunch(listener)).toBe(release)
    expect(backend.subscribeAuthorizationLaunch.mock.calls).toEqual([[listener]])
  })
})
