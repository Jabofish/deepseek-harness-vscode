import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INSTALL_DSH_VERSION,
  LATEST_PUBLISHED_DSH_VERSION,
  LATEST_SUPPORTED_DSH_VERSION,
  Rc202VersionAdapter,
} from '@dsh-vscode/dsh-adapter'

import { createAdapterOptions } from './adapter-options.js'
import { createVersionAdapters } from './version-adapters.js'

const exportFileSystem = {
  stat: () => Promise.reject(new Error('unused')),
  rename: () => Promise.reject(new Error('unused')),
  unlink: () => Promise.reject(new Error('unused')),
  writeFile: () => Promise.reject(new Error('unused')),
}

describe('production version adapter registry', () => {
  it('registers rc.2 as a distinct exact-only entry and the guided install default', () => {
    const adapters = createVersionAdapters(
      createAdapterOptions({
        requestTimeoutMs: () => 1_000,
        fetch: globalThis.fetch,
        samePath: (left, right) => left === right,
        exportFileSystem,
        authCookie: () => undefined,
      }),
    )
    const marker = adapters.find((adapter) => adapter.supportedVersion === '0.2.0-rc.2')

    expect(marker).toBeInstanceOf(Rc202VersionAdapter)
    expect(marker?.fallback).toBe(false)
    expect(adapters.slice(0, 2).map((adapter) => adapter.supportedVersion)).toEqual([
      '0.2.0-rc.2',
      '0.2.0-rc.1',
    ])
    expect(adapters[2]?.supportedVersion).toBe('0.1.7-rc.2')
    expect(adapters.filter((adapter) => adapter.supportedVersion === '0.2.0-rc.2')).toHaveLength(1)
    expect(adapters.filter((adapter) => adapter.supportedVersion === '0.2.0-rc.1')).toHaveLength(1)
    expect(LATEST_PUBLISHED_DSH_VERSION).toBe('0.2.0-rc.2')
    expect(LATEST_SUPPORTED_DSH_VERSION).toBe('0.2.0-rc.2')
    expect(DEFAULT_INSTALL_DSH_VERSION).toBe('0.2.0-rc.2')
  })
})
