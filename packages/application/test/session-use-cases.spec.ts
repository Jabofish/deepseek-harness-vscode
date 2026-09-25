import { describe, expect, it, vi } from 'vitest'

import type { BackendService } from '../src/services/backend-service.js'
import { SessionUseCases } from '../src/use-cases/session-use-cases.js'

describe('SessionUseCases.initializeDefaultModel', () => {
  it('forwards cancellation to an available backend capability', async () => {
    const initializeDefaultModel = vi.fn().mockResolvedValue(undefined)
    const backendService = {
      requireBackend: () => ({ sessions: { initializeDefaultModel } }),
    } as unknown as BackendService
    const useCases = new SessionUseCases(backendService)
    const controller = new AbortController()

    await expect(useCases.initializeDefaultModel(controller.signal)).resolves.toBeUndefined()
    expect(initializeDefaultModel).toHaveBeenCalledExactlyOnceWith(controller.signal)
  })

  it('keeps the capability absent on adapters that do not expose it', () => {
    const backendService = {
      requireBackend: () => ({ sessions: {} }),
    } as unknown as BackendService
    const useCases = new SessionUseCases(backendService)

    expect(() => useCases.initializeDefaultModel()).toThrowError(
      expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }),
    )
  })
})
