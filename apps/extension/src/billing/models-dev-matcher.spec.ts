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
  const price = { text: { input: { price: 0.15 }, output: { price: 0.6 } } }
  const canonical = 'deepseek/deepseek-v4.1-flash-1017'
  const official = new ModelsDevCatalogIndex({
    ...Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `reseller-${i}`,
        {
          models: {
            'deepseek-flash': { name: 'DeepSeek V4.1 Flash', canonical_id: canonical, cost: price },
          },
        },
      ]),
    ),
    deepseek: {
      name: 'DeepSeek',
      models: {
        'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', canonical_id: canonical, cost: price },
        'deepseek-flash': { name: 'DeepSeek V4.1 Flash 1017', canonical_id: canonical, cost: price },
      },
    },
  })

  it('prefers official prices for an unspecified supplier and preserves explicit reseller routes', () => {
    expect(official.match({ providerId: 'work', modelId: 'deepseek-flash' }).selected?.providerId).toBe(
      'deepseek',
    )
    expect(official.match({ providerId: 'reseller-0', modelId: 'deepseek-flash' }).selected?.providerId).toBe(
      'reseller-0',
    )
    const result = official.match({ providerId: 'custom-proxy', modelId: 'deepseek-flash' })
    expect(result.selected).toBeUndefined()
    expect(result.candidates).toHaveLength(8)
    expect(result.candidates[0]).toMatchObject({ providerId: 'deepseek', official: true })
  })

  it('does not collapse canonical aliases when their prices differ', () => {
    const conflicting = new ModelsDevCatalogIndex({
      vendor: {
        models: {
          a: { canonical_id: 'vendor/model', cost: { price: 1 } },
          b: { canonical_id: 'vendor/model', cost: { price: 2 } },
        },
      },
    })
    expect(conflicting.match({ providerId: 'vendor', modelId: 'vendor/model' }).selected).toBeUndefined()
  })
  it('searches the complete reference catalog with case-insensitive names and paging', () => {
    const large = new ModelsDevCatalogIndex({
      vendor: {
        models: Object.fromEntries(
          Array.from({ length: 61 }, (_, i) => [
            `model-${String(i).padStart(3, '0')}`,
            { name: `Model ${String(i).padStart(3, '0')}` },
          ]),
        ),
      },
    })
    const first = large.search('')
    expect(first.entries).toHaveLength(50)
    expect(first).toMatchObject({ hasMore: true, nextOffset: 50 })
    expect(large.search('', 50).entries).toHaveLength(11)
    expect(large.search('VENDOR MODEL_055').entries[0]?.modelId).toBe('model-055')
  })

  it('never silently reprices unknown channels, ambiguous names, free variants or unlisted snapshots', () => {
    const custom = index.match({ providerId: 'custom-proxy', modelId: 'model-v2' })
    expect(custom.selected).toBeUndefined()
    expect(custom.candidates).toHaveLength(2)
    expect(index.match({ providerId: 'vendor', modelId: 'a_1_0' }).selected).toBeUndefined()
    expect(index.match({ providerId: 'vendor', modelId: 'model-v2:free' }).selected).toBeUndefined()
    expect(index.match({ providerId: 'vendor', modelId: 'model-v2-20250101' }).selected).toBeUndefined()
  })
})
