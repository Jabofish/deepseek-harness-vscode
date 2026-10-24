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
  it.each(['deepseek', 'deepseek-official', 'deepseek-account', 'DeepSeek_Official'])(
    'defaults %s to official prices, including canonical and case variants',
    (providerId) => {
      for (const modelId of ['deepseek-flash', 'DEEPSEEK_FLASH', canonical, canonical.toUpperCase()])
        expect(official.match({ providerId, modelId }).selected).toMatchObject({
          providerId: 'deepseek',
          modelId: 'deepseek-flash',
          official: true,
        })
    },
  )
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
  it('suggests close spellings without silently changing a model variant', () => {
    const result = official.match({ providerId: 'deepseek-account', modelId: 'deepseek-flahs' })
    expect(result.selected).toBeUndefined()
    expect(result.candidates.some((candidate) => candidate.providerId === 'deepseek')).toBe(true)
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
