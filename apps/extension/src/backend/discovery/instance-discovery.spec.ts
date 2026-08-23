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
