import { describe, expect, it } from 'vitest'
import { ModelsDevCatalogIndex } from './models-dev-matcher.js'

const index = new ModelsDevCatalogIndex({
  vendor: {
    name: 'Vendor AI',
    models: {
      'model-v2': { name: 'Model V2', canonical_id: 'vendor/model-v2-20261001' },
      'a-1.0': { name: 'A 1.0' },
      a10: { name: 'A 10' },
    },
  },
  reseller: { name: 'Reseller', models: { 'model-v2': { name: 'Model V2' } } },
  anthropic: { name: 'Anthropic', models: { 'claude-opus-4.7': { name: 'Claude Opus 4.7' } } },
})
describe('provider-scoped model matching', () => {
  it.each([
    ['vendor', 'model-v2', 'model-v2'],
    ['Vendor AI', 'MODEL_V2', 'model-v2'],
    ['vendor-ai', 'model-v2-20261001', 'model-v2'],
    ['vendor', 'vendor/model-v2-20261001', 'model-v2'],
    ['reseller', 'model-v2', 'model-v2'],
    ['vendor', 'a10', 'a10'],
  ])('resolves %s / %s within its own channel', (providerId, modelId, expected) => {
    expect(index.match({ providerId, modelId }).selected?.modelId).toBe(expected)
  })
  it('never silently reprices unknown channels, ambiguous names, free variants or unlisted snapshots', () => {
    const custom = index.match({ providerId: 'custom-proxy', modelId: 'model-v2' })
    expect(custom.selected).toBeUndefined()
    expect(custom.candidates).toHaveLength(2)
    expect(index.match({ providerId: 'vendor', modelId: 'a_1_0' }).selected).toBeUndefined()
    expect(index.match({ providerId: 'vendor', modelId: 'model-v2:free' }).selected).toBeUndefined()
    expect(index.match({ providerId: 'vendor', modelId: 'model-v2-20250101' }).selected).toBeUndefined()
  })
  it('reuses llm-pricing name normalization as a confirmation candidate only', () => {
    const result = index.match({ providerId: 'my-proxy', modelId: 'claude-opus-4-7-20260115' })
    expect(result.selected).toBeUndefined()
    expect(result.candidates).toMatchObject([{ providerId: 'anthropic', modelId: 'claude-opus-4.7' }])
  })
})
