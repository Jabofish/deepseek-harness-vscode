import type { BackendEndpoint } from '@dsh-vscode/domain'
import { describe, expect, it, vi } from 'vitest'

import { createAdapterOptions } from './adapter-options.js'

const exportFileSystem = {
  stat: () => Promise.reject(new Error('unused')),
  rename: () => Promise.reject(new Error('unused')),
  unlink: () => Promise.reject(new Error('unused')),
  writeFile: () => Promise.reject(new Error('unused')),
}

describe('createAdapterOptions', () => {
  it('never reads settings while the options are constructed', () => {
    // The Extension Host builds every version adapter during activation. A
    // read here runs the settings validator, so one invalid setting would
    // abort activation instead of failing the operation that needed it.
    const requestTimeoutMs = vi.fn(() => {
      throw new Error('settings must not be read while adapters are built')
    })

    const options = createAdapterOptions({
      requestTimeoutMs,
      fetch: globalThis.fetch,
      samePath: (left, right) => left === right,
      exportFileSystem,
      authCookie: () => undefined,
    })

    expect(requestTimeoutMs).not.toHaveBeenCalled()
    expect(() => options.requestTimeoutMs).toThrowError('settings must not be read while adapters are built')
  })

  it('reads the request timeout again for every use', () => {
    const values = [30_000, 5_000]
    const requestTimeoutMs = vi.fn(() => values.shift() ?? 0)
    const options = createAdapterOptions({
      requestTimeoutMs,
      fetch: globalThis.fetch,
      samePath: (left, right) => left === right,
      exportFileSystem,
      authCookie: () => undefined,
    })

    expect(options.requestTimeoutMs).toBe(30_000)
    expect(options.requestTimeoutMs).toBe(5_000)
    expect(requestTimeoutMs).toHaveBeenCalledTimes(2)
  })

  it('keeps the shared retry policy and host callbacks', async () => {
    const endpoint: BackendEndpoint = { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' }
    const options = createAdapterOptions({
      requestTimeoutMs: () => 1_000,
      fetch: globalThis.fetch,
      samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
      exportFileSystem,
      authCookie: (asked) => (asked.baseUrl === endpoint.baseUrl ? 'dsh_session=token' : undefined),
    })

    expect(options.retryPolicy).toEqual({ maximumAttempts: 2, baseDelayMs: 100, maximumDelayMs: 500 })
    expect(options.fetch).toBe(globalThis.fetch)
    expect(options.exportFileSystem).toBe(exportFileSystem)
    expect(options.samePath?.('C:\\Work\\Repo', 'c:\\work\\repo')).toBe(true)
    expect(options.authCookie?.(endpoint)).toBe('dsh_session=token')
    expect(options.authCookie?.({ ...endpoint, baseUrl: 'http://127.0.0.1:9999' })).toBeUndefined()
    await expect(options.exportFileSystem?.stat('unused')).rejects.toThrowError('unused')
  })
})
