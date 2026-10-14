/* Structural storage and UI doubles intentionally infer fixture types and resolve synchronously. */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseServerOrigin, type BackendEndpoint } from '@dsh-vscode/domain'
import { EndpointNetwork } from './endpoint-network.js'
import { ExternalConnectionAccess } from './external-connection-access.js'

const endpoint = (url: string): BackendEndpoint => {
  const value = parseServerOrigin(url)
  if (value === undefined) throw new Error('Invalid fixture origin')
  return value
}
const first = endpoint('https://first.example:443')
const second = endpoint('https://second.example:443')
const legacyKey = (value: BackendEndpoint): string =>
  `dsh.connection.external.${createHash('sha256').update(value.baseUrl).digest('hex')}`
const key = (value: BackendEndpoint): string =>
  `dsh.connection.external.v2.${createHash('sha256')
    .update(JSON.stringify(['host-fixture', value.baseUrl]))
    .digest('hex')}`
const cookie = 'dsh-auth-fixture=session-fixture'
const login = (secure = true): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: './',
      'set-cookie': `${cookie}; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600${secure ? '; Secure' : ''}`,
    },
  })
const accesses: ExternalConnectionAccess[] = []
function fixture(scope = 'host-fixture', values = new Map<string, string>()) {
  const secrets = {
    get: vi.fn(async (name: string) => values.get(name)),
    store: vi.fn(async (name: string, value: string) => {
      values.set(name, value)
    }),
    delete: vi.fn(async (name: string) => {
      values.delete(name)
    }),
  }
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => login())
  const state = {
    trusted: true,
    token: 'token-fixture' as string | undefined,
    confirm: true,
    address: '10.0.0.8',
    now: 100_000,
    timeout: 1000,
  }
  const network = new EndpointNetwork({ fetch, resolve: async () => [{ address: state.address, family: 4 }] })
  const confirm = vi.fn(async () => state.confirm)
  const inputToken = vi.fn(async () => state.token)
  const credentialScope = vi.fn(async () => scope)
  const access = new ExternalConnectionAccess({
    secrets,
    credentialScope,
    network,
    confirm,
    inputToken,
    isTrusted: () => state.trusted,
    requestTimeoutMs: () => state.timeout,
    now: () => state.now,
  })
  accesses.push(access)
  return { values, secrets, fetch, state, network, access, confirm, inputToken, credentialScope }
}
afterEach(async () => {
  await Promise.all(accesses.splice(0).map((access) => access.dispose()))
})

describe('external connection credentials', () => {
  it('does not persist a grant when execution environment identification is cancelled', async () => {
    const f = fixture()
    f.credentialScope.mockReturnValueOnce(new Promise(() => {}))
    const controller = new AbortController()
    const pending = f.access.authorize(first, controller.signal)
    await vi.waitFor(() => expect(f.credentialScope).toHaveBeenCalled())
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(f.secrets.store).not.toHaveBeenCalled()
  })
  it.each([endpoint('http://127.0.0.1:3080'), first])(
    "does not send another execution environment's credentials for $baseUrl",
    async (target) => {
      const hostA = fixture('ssh-host-a')
      await hostA.access.authorize(target)
      await hostA.access.prepare(target, new AbortController().signal)
      const hostB = fixture('container-b', hostA.values)
      const attempt = hostB.access.prepare(target, new AbortController().signal)
      if (target.host === '127.0.0.1') await attempt
      else await expect(attempt).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(hostB.fetch).not.toHaveBeenCalled()
      expect(hostB.access.cookie(target)).toBeUndefined()
      await hostB.access.clear(target)
      const reopenedA = fixture('ssh-host-a', hostA.values)
      await reopenedA.access.prepare(target, new AbortController().signal)
      expect(reopenedA.fetch).toHaveBeenCalledExactlyOnceWith(
        `${target.baseUrl}/api`,
        expect.objectContaining({ headers: { Cookie: cookie } }),
      )
    },
  )
  it('requires fresh authorization instead of adopting credentials without an environment scope', async () => {
    const f = fixture()
    f.values.set(
      legacyKey(first),
      JSON.stringify({ version: 1, approved: true, allowInsecureHttp: false, launchToken: 'old-fixture' }),
    )
    await expect(f.access.prepare(first, new AbortController().signal)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('cancels blocked secure-storage reads within the caller deadline', async () => {
    const f = fixture()
    f.secrets.get.mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = f.access.prepare(first, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does not persist credentials if configuration is cancelled during native password input', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.inputToken.mockImplementationOnce(() => {
      controller.abort()
      return Promise.resolve('fixture-token')
    })
    await expect(f.access.authorize(first, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.values.size).toBe(0)
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does no storage or network work during construction and isolates origins', async () => {
    const f = fixture()
    expect(f.secrets.get).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
    await f.access.authorize(first)
    expect(f.values.has(key(first))).toBe(true)
    expect(f.values.has(key(second))).toBe(false)
    await expect(f.access.prepare(second, new AbortController().signal)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(f.fetch).not.toHaveBeenCalled()
    await f.access.prepare(first, new AbortController().signal)
    expect(f.fetch.mock.calls[0]?.[0]).toBe(`${first.baseUrl}/?token=token-fixture`)
    expect(f.access.cookie(first)).toBe(cookie)
    expect(f.access.cookie(second)).toBeUndefined()
  })
  it('stores no token for anonymous authorization', async () => {
    const f = fixture()
    f.state.token = ''
    await f.access.authorize(first)
    await f.access.prepare(first, new AbortController().signal)
    expect(JSON.parse(f.values.get(key(first)) ?? '{}')).not.toHaveProperty('launchToken')
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each(['confirmation', 'password'] as const)(
    'cancellation at %s leaves no grant or requests',
    async (stage) => {
      const f = fixture()
      if (stage === 'confirmation') f.state.confirm = false
      else f.state.token = undefined
      await expect(f.access.authorize(first)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
      expect(f.values.size).toBe(0)
      expect(f.fetch).not.toHaveBeenCalled()
    },
  )
  it('never sends stored secrets from an untrusted workspace', async () => {
    const f = fixture()
    await f.access.authorize(first)
    f.state.trusted = false
    await expect(f.access.prepare(first, new AbortController().signal)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    await expect(f.access.authorize(first)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('refreshes a rejected persisted cookie once without retrying the failed operation', async () => {
    const f = fixture()
    await f.access.authorize(first)
    await f.access.prepare(first, new AbortController().signal)
    f.fetch.mockClear()
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(login())
    await f.access.prepare(first, new AbortController().signal)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(f.fetch.mock.calls[0]?.[0]).toBe(`${first.baseUrl}/api`)
    expect(f.fetch.mock.calls[0]?.[1]?.headers).toEqual({ Cookie: cookie })
    expect(f.fetch.mock.calls[1]?.[0]).toBe(`${first.baseUrl}/?token=token-fixture`)
    expect(f.access.cookie(first)).toBe(cookie)
  })
  it('does not send an expired cookie and allows token rotation', async () => {
    const f = fixture()
    await f.access.authorize(first)
    await f.access.prepare(first, new AbortController().signal)
    f.state.now += 3_600_001
    f.fetch.mockClear()
    await f.access.prepare(first, new AbortController().signal)
    expect(f.fetch).toHaveBeenCalledTimes(1)
    f.state.token = 'rotated-fixture'
    await f.access.authorize(first)
    expect(f.access.cookie(first)).toBeUndefined()
    await f.access.prepare(first, new AbortController().signal)
    expect(f.fetch.mock.calls.at(-1)?.[0]).toBe(`${first.baseUrl}/?token=rotated-fixture`)
  })
  it.each([
    { status: 200, headers: {} },
    {
      status: 303,
      headers: {
        location: 'https://other.example/',
        'set-cookie': `${cookie}; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600; Secure`,
      },
    },
    {
      status: 303,
      headers: { location: './', 'set-cookie': `${cookie}; Path=/; SameSite=Strict; Max-Age=3600; Secure` },
    },
    {
      status: 303,
      headers: { location: './', 'set-cookie': `${cookie}; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600` },
    },
    {
      status: 303,
      headers: { location: './', 'set-cookie': `${cookie}; HttpOnly; Path=/; Max-Age=3600; Secure` },
    },
    {
      status: 303,
      headers: {
        location: './',
        'set-cookie': `${cookie}; HttpOnly; Path=/; SameSite=Strict; Max-Age=0; Secure`,
      },
    },
  ])('rejects an invalid login response %#', async (init) => {
    const f = fixture()
    await f.access.authorize(first)
    f.fetch.mockResolvedValue(new Response(null, init))
    await expect(f.access.prepare(first, new AbortController().signal)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
    expect(f.access.cookie(first)).toBeUndefined()
    await expect(f.network.fetch(`${first.baseUrl}/api`)).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
  })
  it('reports storage failures with safe messages and never exposes a token', async () => {
    const f = fixture()
    f.secrets.store.mockRejectedValue(new Error('sensitive fixture token'))
    await expect(f.access.authorize(first)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'The connection credentials could not be saved securely.',
    })
    expect(f.access.cookie(first)).toBeUndefined()
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('drops the old in-memory cookie before credential replacement and closes the endpoint if storage fails', async () => {
    const f = fixture()
    await f.access.authorize(first)
    await f.access.prepare(first, new AbortController().signal)
    expect(f.access.cookie(first)).toBe(cookie)
    f.secrets.store.mockRejectedValueOnce(new Error('Fixture storage failure'))
    await expect(f.access.authorize(first)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(f.access.cookie(first)).toBeUndefined()
    await expect(f.network.fetch(`${first.baseUrl}/api`)).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
  })
  it('recovers corrupt storage through fresh explicit authorization', async () => {
    const f = fixture()
    f.values.set(key(first), 'invalid-json')
    await expect(f.access.prepare(first, new AbortController().signal)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    await f.access.authorize(first)
    await f.access.prepare(first, new AbortController().signal)
    expect(f.access.cookie(first)).toBe(cookie)
  })
  it('requires new plaintext approval when HTTP DNS changes', async () => {
    const f = fixture()
    const http = endpoint('http://first.example:3080')
    await f.access.authorize(http)
    expect(f.confirm).toHaveBeenCalledWith(http, true)
    f.state.address = '10.0.0.9'
    await expect(f.access.prepare(http, new AbortController().signal)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does not activate a cookie when its secure-storage write is cancelled', async () => {
    const f = fixture()
    await f.access.authorize(first)
    let finish: (() => void) | undefined
    f.secrets.store.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const abort = new AbortController()
    const pending = f.access.prepare(first, abort.signal)
    await vi.waitFor(() => expect(f.secrets.store).toHaveBeenCalledTimes(2))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    finish?.()
    expect(f.access.cookie(first)).toBeUndefined()
  })
  it('credential replacement supersedes pending authentication without stale storage overwrites', async () => {
    const f = fixture()
    await f.access.authorize(first)
    let respond: ((value: Response) => void) | undefined
    f.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve
        }),
    )
    const pending = f.access.prepare(first, new AbortController().signal)
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1))
    f.state.token = 'new-fixture'
    await f.access.authorize(first)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    respond?.(login())
    await rejected
    expect(JSON.parse(f.values.get(key(first)) ?? '{}')).toMatchObject({ launchToken: 'new-fixture' })
    expect(JSON.parse(f.values.get(key(first)) ?? '{}')).not.toHaveProperty('cookie')
    expect(f.access.cookie(first)).toBeUndefined()
  })
  it('clear removes only the chosen origin and reports secret-storage deletion failures', async () => {
    const f = fixture()
    await f.access.authorize(first)
    await f.access.authorize(second)
    await f.access.clear(first)
    expect(f.values.has(key(first))).toBe(false)
    expect(f.values.has(key(second))).toBe(true)
    f.secrets.delete.mockRejectedValue(new Error('fixture-storage-error'))
    await expect(f.access.clear(second)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(f.access.cookie(second)).toBeUndefined()
  })
})
