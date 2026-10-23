import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INSTALL_DSH_VERSION,
  LATEST_PUBLISHED_DSH_VERSION,
  LATEST_SUPPORTED_DSH_VERSION,
  Rc202VersionAdapter,
  Rc213VersionAdapter,
  VersionedBackendProbe,
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
  it.each([401, 403])(
    'propagates HTTP %i authentication failures without trying another version',
    async (status) => {
      let requests = 0
      const adapters = createVersionAdapters(
        createAdapterOptions({
          requestTimeoutMs: () => 1_000,
          fetch: () => {
            requests++
            return Promise.resolve(new Response(null, { status }))
          },
          samePath: (left, right) => left === right,
          exportFileSystem,
          authCookie: () => 'fixture-cookie',
        }),
      )
      await expect(
        new VersionedBackendProbe(adapters).probe({
          endpoint: { host: 'remote.example', port: 443, baseUrl: 'https://remote.example:443' },
          source: 'configured',
          confidence: 100,
          runtimeVersion: '0.2.1-alpha.2',
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(requests).toBe(1)
    },
  )
  it('registers all 0.2.1 releases exactly while retaining the stable guided install default', () => {
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
    expect(adapters[0]).toBeInstanceOf(Rc213VersionAdapter)
    expect(adapters[0]?.fallback).toBe(false)
    expect(new Set(adapters.map((adapter) => adapter.supportedVersion)).size).toBe(adapters.length)
    expect(adapters.slice(0, 10).map((adapter) => adapter.supportedVersion)).toEqual([
      '0.2.1-rc.3',
      '0.2.1-rc.2',
      '0.2.1-rc.1',
      '0.2.1-alpha.5',
      '0.2.1-alpha.4',
      '0.2.1-alpha.3',
      '0.2.1-alpha.2',
      '0.2.1-alpha.1',
      '0.2.0-rc.2',
      '0.2.0-rc.1',
    ])
    expect(adapters[10]?.supportedVersion).toBe('0.1.7-rc.2')
    expect(adapters.filter((adapter) => adapter.supportedVersion === '0.2.1-alpha.1')).toHaveLength(1)
    expect(adapters.filter((adapter) => adapter.supportedVersion === '0.2.0-rc.2')).toHaveLength(1)
    expect(adapters.filter((adapter) => adapter.supportedVersion === '0.2.0-rc.1')).toHaveLength(1)
    expect(LATEST_PUBLISHED_DSH_VERSION).toBe('0.2.1-rc.3')
    expect(LATEST_SUPPORTED_DSH_VERSION).toBe('0.2.1-rc.3')
    expect(DEFAULT_INSTALL_DSH_VERSION).toBe('0.2.1-rc.2')
  })
})
