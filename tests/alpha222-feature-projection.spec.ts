import { expect, it } from 'vitest'
import { Alpha222PluginBundleRepository } from '../packages/dsh-adapter/src/versions/alpha222/plugin-manager-repository.js'
import { Alpha222VersionAdapter } from '../packages/dsh-adapter/src/versions/alpha222/adapter.js'
import { pluginBundleChangeResultSchema } from '../packages/webview-protocol/src/feature-schemas/feature-plugin.js'
import {
  endpoint,
  transportOptions,
  wrappedResponse,
} from '../packages/dsh-adapter/test/support/contract-harness.js'
import { unsupportedPlatform } from '../packages/dsh-adapter/test/fixtures/alpha222-contract.js'

it('carries a native platform refusal through strict protocol without diagnostics', async () => {
  const transport = new Alpha222VersionAdapter(
    transportOptions((_input, init) => Promise.resolve(wrappedResponse(init, unsupportedPlatform))),
  ).createTransport(endpoint)
  try {
    const result = pluginBundleChangeResultSchema.parse(
      await new Alpha222PluginBundleRepository(transport).setBundleEnabled('fixture-bundle', true),
    )
    expect(result).toMatchObject({ application: 'failed', errorCode: 'unsupported-platform' })
    expect(JSON.stringify(result)).not.toContain('private')
  } finally {
    await transport.close()
  }
})
