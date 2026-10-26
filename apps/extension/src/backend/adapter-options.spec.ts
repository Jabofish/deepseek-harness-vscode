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

    expect(() => options.requestTimeoutMs).toThrowError('settings must not be read while adapters are built')
  })
})
