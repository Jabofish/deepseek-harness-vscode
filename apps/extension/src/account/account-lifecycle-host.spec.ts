import { describe, expect, it, vi, type MockedFunction, type MockedObject } from 'vitest'

import type {
  AccountAuthorizationLaunch,
  AccountLifecycleRepository,
  AccountLifecycleSnapshot,
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
})
