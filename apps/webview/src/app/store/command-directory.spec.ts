import { describe, expect, it, vi } from 'vitest'
import type { DynamicCommand } from '@dsh-vscode/domain'
import { createCommandDirectoryCache } from './command-directory.js'

describe('Command directory refresh ownership', () => {
  it('starts a fresh read on forced invalidation and retires the older result', async () => {
    let finishOld: ((commands: readonly DynamicCommand[]) => void) | undefined
    const old = new Promise<readonly DynamicCommand[]>((resolve) => {
      finishOld = resolve
    })
    const fresh = [{ name: 'fresh', description: 'Fresh command' }]
    const fetch = vi.fn<(_: string) => Promise<readonly DynamicCommand[]>>()
    fetch.mockResolvedValueOnce([{ name: 'other', description: 'Other session' }])
    fetch.mockReturnValueOnce(old)
    fetch.mockResolvedValueOnce(fresh)
    const cache = createCommandDirectoryCache(fetch)
    const other = await cache.load('other')
    const pending = cache.load('active')
    expect(cache.load('active')).toBe(pending)
    const forced = cache.load('active', true)
    expect(forced).not.toBe(pending)
    await expect(forced).resolves.toBe(fresh)
    finishOld?.([{ name: 'stale', description: 'Stale command' }])
    await expect(pending).resolves.toBeUndefined()
    expect(cache.peek('active')).toBe(fresh)
    expect(cache.peek('other')).toBe(other)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not resurrect stale commands when a forced read fails, and allows recovery', async () => {
    let finishOld: ((commands: readonly DynamicCommand[]) => void) | undefined
    const fetch = vi.fn<(_: string) => Promise<readonly DynamicCommand[]>>()
    fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve
      }),
    )
    fetch.mockRejectedValueOnce(new Error('directory unavailable'))
    const cache = createCommandDirectoryCache(fetch)
    const pending = cache.load('active')
    await expect(cache.load('active', true)).rejects.toThrow('directory unavailable')
    finishOld?.([{ name: 'stale', description: 'Stale command' }])
    await expect(pending).resolves.toBeUndefined()
    expect(cache.peek('active')).toBeUndefined()
    const recovered = [{ name: 'recovered', description: 'Recovered command' }]
    fetch.mockResolvedValueOnce(recovered)
    await expect(cache.load('active')).resolves.toBe(recovered)
    expect(cache.peek('active')).toBe(recovered)
  })
})
