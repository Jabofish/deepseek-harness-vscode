import { describe, expect, it, vi } from 'vitest'
import type { DynamicCommand } from '@dsh-vscode/domain'
import { createCommandDirectoryCache } from './command-directory.js'

describe('Command directory refresh ownership', () => {
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
    await expect(cache.load('active')).resolves.toEqual(recovered)
    expect(cache.peek('active')).toEqual(recovered)
  })
})
