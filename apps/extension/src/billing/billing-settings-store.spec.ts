import { describe, expect, it } from 'vitest'
import { BillingSettingsStore } from './billing-settings-store.js'

describe('local billing configuration', () => {
  it('serializes conflicting windows and isolates deployment scopes', async () => {
    const values = new Map<string, unknown>()
    const store = new BillingSettingsStore({
      get: (key) => values.get(key),
      update: (key, value) => {
        values.set(key, value)
        return Promise.resolve()
      },
    })
    const port = store.scope('one', new AbortController().signal)
    const results = await Promise.allSettled([
      port.save({ enabled: true, prices: [] }, 0),
      port.save({ enabled: false, prices: [] }, 0),
    ])
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { revision: 1, enabled: true } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'SETTINGS_CONFLICT' } })
    expect(await store.scope('two', new AbortController().signal).read()).toEqual({
      revision: 0,
      enabled: false,
      prices: [],
    })
    expect(await port.read()).toMatchObject({ revision: 1, enabled: true })
  })
  it('does not overwrite corruption, cancelled writes or failed persistence', async () => {
    const corrupt = new BillingSettingsStore({
      get: () => ({ revision: -1 }),
      update: () => Promise.reject(new Error('must not write')),
    })
    expect(() => corrupt.scope('s', new AbortController().signal).read()).toThrow(
      expect.objectContaining({ code: 'STORAGE_CORRUPT' }),
    )
    let writes = 0
    const failing = new BillingSettingsStore({
      get: () => undefined,
      update: () => {
        writes += 1
        return Promise.reject(new Error('disk failure'))
      },
    })
    await expect(
      failing.scope('s', new AbortController().signal).save({ enabled: true, prices: [] }, 0),
    ).rejects.toThrow('disk failure')
    const controller = new AbortController()
    controller.abort()
    await expect(
      failing.scope('s', controller.signal).save({ enabled: true, prices: [] }, 0),
    ).rejects.toThrow()
    expect(writes).toBe(1)
  })
})
