import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate } from '@dsh-vscode/domain'
import { CompositeInstanceDiscovery } from './instance-discovery.js'
import { isDiscoveryCancellation } from './provider.js'

const candidate: BackendCandidate = {
  endpoint: { host: '127.0.0.1', port: 3939, baseUrl: 'http://127.0.0.1:3939' },
  source: 'default-port',
  confidence: 10,
}

describe('CompositeInstanceDiscovery cancellation', () => {
  it('recognizes abort errors from platform process APIs', () => {
    const controller = new AbortController()

    expect(isDiscoveryCancellation({ code: 'ABORT_ERR' })).toBe(true)
    expect(isDiscoveryCancellation({ name: 'AbortError' })).toBe(true)
    expect(isDiscoveryCancellation(new Error('unrelated'))).toBe(false)

    controller.abort()
    expect(isDiscoveryCancellation(new Error('wrapped abort'), controller.signal)).toBe(true)
  })

  it('does not convert cancellation during provider fan-out into an empty result', async () => {
    const controller = new AbortController()
    let release: (() => void) | undefined
    const pending = new Promise<readonly BackendCandidate[]>((resolve) => {
      release = () => resolve([candidate])
    })
    const provider = { id: 'slow', discover: vi.fn(() => pending) }
    const discovery = new CompositeInstanceDiscovery([provider])

    const operation = discovery.discover(controller.signal)
    controller.abort()
    release?.()

    await expect(operation).rejects.toBeDefined()
  })
})

describe('CompositeInstanceDiscovery phases', () => {
  it('keeps slow process providers out of the fast pass', async () => {
    const fastCandidate: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3940, baseUrl: 'http://127.0.0.1:3940' },
      source: 'known',
      confidence: 90,
    }
    const fallbackCandidate: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3941, baseUrl: 'http://127.0.0.1:3941' },
      source: 'process-scan',
      confidence: 70,
    }
    const fast = { id: 'known', discover: vi.fn(() => Promise.resolve([fastCandidate])) }
    const fallback = {
      id: 'process',
      phase: 'fallback' as const,
      discover: vi.fn(() => Promise.resolve([fallbackCandidate])),
    }
    const discovery = new CompositeInstanceDiscovery([fast, fallback])

    await expect(discovery.discoverFast()).resolves.toEqual([fastCandidate])
    expect(fast.discover).toHaveBeenCalledTimes(1)
    expect(fallback.discover).not.toHaveBeenCalled()

    await expect(discovery.discover()).resolves.toEqual([fastCandidate, fallbackCandidate])
    expect(fast.discover).toHaveBeenCalledTimes(2)
    expect(fallback.discover).toHaveBeenCalledTimes(1)
  })
})
