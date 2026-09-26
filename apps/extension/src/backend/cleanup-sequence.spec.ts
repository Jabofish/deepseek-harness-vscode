import { describe, expect, it, vi } from 'vitest'
import { runCleanupSequence } from './cleanup-sequence.js'

describe('runCleanupSequence', () => {
  it('continues after synchronous and asynchronous failures and returns each error in order', async () => {
    const detachError = new Error('backend detach failed')
    const disconnectError = new Error('backend disconnect failed')
    const order: string[] = []
    const disconnect = vi.fn(() => {
      order.push('disconnect')
      return Promise.reject(disconnectError)
    })
    const disposeSupervisor = vi.fn(() => {
      order.push('supervisor')
    })

    const errors = await runCleanupSequence([
      () => {
        order.push('detach')
        throw detachError
      },
      disconnect,
      disposeSupervisor,
    ])

    expect(order).toEqual(['detach', 'disconnect', 'supervisor'])
    expect(disconnect).toHaveBeenCalledOnce()
    expect(disposeSupervisor).toHaveBeenCalledOnce()
    expect(errors).toEqual([detachError, disconnectError])
  })
})
