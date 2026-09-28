import { describe, expect, it } from 'vitest'

import { LATEST_PUBLISHED_DSH_VERSION } from '@dsh-vscode/dsh-adapter'
import { Master21638VersionAdapter } from '@dsh-vscode/dsh-adapter'

import { createAdapterOptions } from './adapter-options.js'
import { createVersionAdapters } from './version-adapters.js'

const exportFileSystem = {
  stat: () => Promise.reject(new Error('unused')),
  rename: () => Promise.reject(new Error('unused')),
  unlink: () => Promise.reject(new Error('unused')),
  writeFile: () => Promise.reject(new Error('unused')),
}

describe('production version adapter registry', () => {
  it('registers the temporary master label as one exact-only entry without changing the installer default', () => {
    const adapters = createVersionAdapters(
      createAdapterOptions({
        requestTimeoutMs: () => 1_000,
        fetch: globalThis.fetch,
        samePath: (left, right) => left === right,
        exportFileSystem,
        authCookie: () => undefined,
      }),
    )
    const marker = adapters.find(
      (adapter) => adapter.supportedVersion === '0.1.7-master.21638c56315ae6a2b552d6091945d3144c9af32e',
    )

    expect(marker).toBeInstanceOf(Master21638VersionAdapter)
    expect(marker?.fallback).toBe(false)
    expect(adapters.slice(0, 2).map((adapter) => adapter.supportedVersion)).toEqual([
      '0.1.7-master.21638c56315ae6a2b552d6091945d3144c9af32e',
      '0.1.7-rc.2',
    ])
    expect(
      adapters.filter(
        (adapter) => adapter.supportedVersion === '0.1.7-master.21638c56315ae6a2b552d6091945d3144c9af32e',
      ),
    ).toHaveLength(1)
    expect(LATEST_PUBLISHED_DSH_VERSION).toBe('0.1.5-rc.3')
  })
})
