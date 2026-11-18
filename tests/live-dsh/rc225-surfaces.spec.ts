import { describe, expect, it } from 'vitest'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

/**
 * dsh-v0.2.2-rc.5 / 9c2670d3bce5275e0d1610272958121af87787bb.
 * Isolated stock npm runtime check: verifies omitted web.searchProvider default
 * (Automatic per model route), web-search-deepseek settings exposure, and clean
 * set/unset restoration without issuing model requests.
 */
const enabled = process.env.DSH_LIVE_SMOKE === '1' && process.env.DSH_LIVE_RUNTIME_VERSION === '0.2.2-rc.5'

describe.skipIf(!enabled)('native rc225 web search selection defaults', () => {
  it(
    'exposes omitted web.searchProvider and round-trips explicit set/unset mutations',
    async () => {
      const runtime = await startManagedRuntime()
      try {
        const { backend } = runtime
        expect(backend.connection.capabilities).toMatchObject({
          adapterId: 'dsh-0.2.2-rc.5',
          protocolVersion: 'rc225',
          compatibilityMode: 'exact',
        })
        const initial = await backend.settings.readSnapshot()
        const webNs = initial.schema.namespaces.find((entry) => entry.ns === 'web')!
        const searchNs = initial.schema.namespaces.find((entry) => entry.ns === 'web-search-deepseek')!
        expect(webNs).toBeDefined()
        expect(webNs.applies).toBe('live')
        expect(webNs.userFields).not.toContain('searchProvider')
        expect(initial.values['web']).toEqual({ fetchProvider: 'http' })
        expect(searchNs).toBeDefined()
        expect(searchNs.applies).toBe('live')
        expect(searchNs.secrets).toContainEqual({ field: 'apiKey', set: false })

        await backend.settings.mutate(
          'web',
          [{ op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' }],
          webNs.revision,
        )
        const overridden = await backend.settings.readSnapshot()
        expect(overridden.values['web']).toEqual({
          searchProvider: 'deepseek-search-api',
          fetchProvider: 'http',
        })
        const nextWebNs = overridden.schema.namespaces.find((entry) => entry.ns === 'web')!
        expect(nextWebNs.userFields).toContain('searchProvider')

        await backend.settings.mutate('web', [{ op: 'unset', path: ['searchProvider'] }], nextWebNs.revision)
        const restored = await backend.settings.readSnapshot()
        expect(restored.values['web']).toEqual({ fetchProvider: 'http' })
        expect(restored.schema.namespaces.find((entry) => entry.ns === 'web')?.userFields).not.toContain(
          'searchProvider',
        )
      } finally {
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
