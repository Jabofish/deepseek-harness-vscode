import { describe, expect, it } from 'vitest'
import type { PluginBundleRepository, SessionProjectionValues } from '@dsh-vscode/domain'
import { Rc223VersionAdapter } from '../src/versions/rc223/adapter.js'
import { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { rc223ImportBundle, rc223Projection } from './fixtures/rc223-contract.js'
import { bodyText, endpoint, transportOptions, wrappedResponse } from './support/contract-harness.js'

class Adapter extends Rc223VersionAdapter {
  public normalize(value: unknown): readonly unknown[] | undefined {
    return this.createTransportOptions(endpoint).normalizeControlFrame?.(value)
  }

  public project(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
    return this.mapProjectionValues(values)
  }

  public bundles(transport: AlphaLoopbackApiClient): PluginBundleRepository {
    return this.createPluginBundleRepository(transport)
  }
}

describe('published rc223 consumed contracts', () => {
  it('retains batched catalog/continuation validation and removes private Team state', () => {
    const adapter = new Adapter(transportOptions(globalThis.fetch))
    expect(adapter.normalize(rc223Projection)).toMatchObject([
      { type: 'session/projection', key: 'subagentCatalog' },
      { type: 'session/projection', key: 'conversationContinuation', value: 4 },
      { type: 'session/projection', key: 'agentTeam' },
    ])
    expect(
      adapter.project(Object.fromEntries(rc223Projection.changes.map(({ key, val }) => [key, val]))),
    ).toMatchObject({ subagentCatalog: [{ name: 'reviewer' }], conversationContinuation: 4 })
    expect(adapter.project({ agentTeam: rc223Projection.changes[2].val })).not.toHaveProperty('agentTeam')
    expect(() =>
      adapter.normalize({
        ...rc223Projection,
        changes: rc223Projection.changes.map((change) =>
          change.key === 'conversationContinuation' ? { ...change, val: 6 } : change,
        ),
      }),
    ).toThrow()
    expect(
      adapter.normalize({ type: 'projection', sessionId: 's', seq: 5, key: 'todos', value: [] }),
    ).toBeUndefined()
  })

  it('discovers the optional importer and sends its exact package guard with bounded safe refusals', async () => {
    const requests: unknown[] = []
    const options = transportOptions((_input, init) => {
      const request = JSON.parse(bodyText(init)) as { method: string }
      requests.push(request)
      return Promise.resolve(
        wrappedResponse(
          init,
          request.method === 'pluginManager/listBundles'
            ? [rc223ImportBundle]
            : {
                stage: 'install',
                target: `${rc223ImportBundle.name}@${rc223ImportBundle.version}`,
                changed: false,
                enabled: true,
                application: 'failed',
                error: { code: 'unexpected-package', diagnostic: 'Private fixture diagnostic' },
                packageResult: { unmet: 'unexpected-package' },
              },
        ),
      )
    })
    const adapter = new Adapter(options)
    const transport = new AlphaLoopbackApiClient({ ...options, endpoint })
    try {
      const bundles = adapter.bundles(transport)
      expect(await bundles.listBundles()).toMatchObject([
        {
          name: rc223ImportBundle.name,
          version: rc223ImportBundle.version,
          optional: true,
          installed: false,
        },
      ])
      const expected = { name: rc223ImportBundle.name, version: rc223ImportBundle.version }
      const result = await bundles.installBundle(`${expected.name}@${expected.version}`, {
        requestId: 'import-fixture',
        expected,
      })
      expect(result).toMatchObject({ errorCode: 'unexpected-package', application: 'failed' })
      expect(result).not.toHaveProperty('diagnostic')
      expect(requests).toMatchObject([
        { method: 'pluginManager/listBundles', payload: { args: {} } },
        {
          method: 'pluginManager/installBundle',
          payload: { args: { options: { expected, requestId: 'import-fixture' } } },
        },
      ])
      expect(requests).toHaveLength(2)
    } finally {
      await transport.close()
    }
  })
})
