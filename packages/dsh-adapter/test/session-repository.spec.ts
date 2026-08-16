import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'

describe('Rc6SessionRepository session removal', () => {
  it('maps removal to the pinned rc.6 archive RPC', async () => {
    const requestImplementation = <TResponse>(
      method: string,
      params: unknown,
      _signal?: AbortSignal,
    ): Promise<TResponse> => {
      expect(method).toBe('workspace.archiveSession')
      expect(params).toEqual({ sessionId: 'session-1' })
      return Promise.resolve({ result: { ok: true, value: undefined } } as TResponse)
    }
    const request = vi.fn(requestImplementation) as unknown as DshTransport['request']
    const transport: DshTransport = {
      request,
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }

    await new Rc6SessionRepository(transport).remove('session-1')

    expect(request).toHaveBeenCalledTimes(1)
  })
})
