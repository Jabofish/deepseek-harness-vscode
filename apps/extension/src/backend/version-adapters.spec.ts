import { describe, expect, it } from 'vitest'

import { VersionedBackendProbe } from '@dsh-vscode/dsh-adapter'

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
})
