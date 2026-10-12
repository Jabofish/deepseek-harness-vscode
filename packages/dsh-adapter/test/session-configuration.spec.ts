import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import { configuration, configurationFixture, deferred } from './support/session-configuration-fixture.js'
import { normalizeTransportError } from '../src/transport-errors.js'

async function flushContinuations(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

describe('session configuration transactions', () => {
  it.each(['/permission danger-full-access', '/plan'])(
    'rejects the command business error from %s without applying later model changes',
    async (line) => {
      const h = configurationFixture({ commandOutcome: (call) => (call.line === line ? 'error' : 'success') })
      const result = h.repository.setConfiguration('s1', configuration('danger-full-access', 'new', true))
      await expect(result).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION', retryable: false })
      await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining('fixture-secret'))
      expect(h.state.get('s1')).toMatchObject({ permission: 'read-only', plan: false, provider: 'old' })
      expect(h.calls.some((call) => call.method === 'session.selectModel')).toBe(false)
    },
  )

  it('reports a rejected compensation as incomplete restoration and lets a later request retry', async () => {
    const h = configurationFixture({
      commandOutcome: (call) => (call.line === '/permission read-only' ? 'error' : 'success'),
    })
    await expect(
      h.repository.setConfiguration('s1', configuration('danger-full-access', 'unavailable')),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'DSH configuration failed and could not be fully restored.',
    })
    expect(h.state.get('s1')).toMatchObject({ permission: 'danger-full-access', provider: 'old' })
    await h.repository.setConfiguration('s1', configuration('workspace-write', 'new'))
    expect(h.state.get('s1')).toMatchObject({ permission: 'workspace-write', provider: 'new' })
  })

  it('finishes A compensation before B reads its baseline or commits the same session', async () => {
    const entered = deferred()
    const release = deferred()
    const h = configurationFixture({
      afterCommand: async (call) => {
        if (call.line === '/permission danger-full-access') {
          entered.resolve()
          await release.promise
        }
      },
    })
    const A = h.repository.setConfiguration('s1', configuration('danger-full-access', 'unavailable'))
    const outcomeA = A.catch((error: unknown) => error)
    await entered.promise
    const B = h.repository.setConfiguration('s1', configuration('workspace-write', 'B'))
    try {
      await flushContinuations()
      expect(h.calls.filter((call) => call.method === 'session.history')).toHaveLength(1)
      expect(h.state.get('s1')?.permission).toBe('danger-full-access')
    } finally {
      release.resolve()
      await Promise.allSettled([A, B])
    }
    expect(await outcomeA).toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await B
    expect((await h.repository.get('s1')).configuration).toMatchObject({
      permissionPreset: 'workspace-write',
      model: { providerId: 'B' },
    })
    expect(h.calls.filter((call) => call.line).map((call) => call.line)).toEqual([
      '/permission danger-full-access',
      '/permission read-only',
      '/permission workspace-write',
    ])
  })

  it('reads B baseline after A succeeds, so B can turn a newly enabled plan back off', async () => {
    const entered = deferred()
    const release = deferred()
    const h = configurationFixture({
      afterCommand: async (call) => {
        if (call.line === '/permission danger-full-access') {
          entered.resolve()
          await release.promise
        }
      },
    })
    const A = h.repository.setConfiguration('s1', configuration('danger-full-access', 'old', true))
    await entered.promise
    const B = h.repository.setConfiguration('s1', configuration('read-only'))
    release.resolve()
    await Promise.all([A, B])
    expect(h.state.get('s1')).toMatchObject({ permission: 'read-only', plan: false })
    expect(h.calls.filter((call) => call.line).map((call) => call.line)).toEqual([
      '/permission danger-full-access',
      '/plan',
      '/permission read-only',
      '/plan off',
    ])
  })

  it.each(['session', 'backend'] as const)('keeps transactions for another %s independent', async (scope) => {
    const entered = deferred()
    const release = deferred()
    const h = configurationFixture({
      afterCommand: async (call) => {
        if (call.sessionId === 's1' && call.line === '/permission danger-full-access') {
          entered.resolve()
          await release.promise
        }
      },
    })
    const other = scope === 'backend' ? configurationFixture() : h
    const A = h.repository.setConfiguration('s1', configuration('danger-full-access', 'unavailable'))
    const outcomeA = A.catch((error: unknown) => error)
    await entered.promise
    try {
      const id = scope === 'backend' ? 's1' : 's2'
      await other.repository.setConfiguration(id, configuration('workspace-write', 'B'))
      expect(other.state.get(id)).toMatchObject({ permission: 'workspace-write', provider: 'B' })
    } finally {
      release.resolve()
      await outcomeA
    }
    expect(await outcomeA).toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })

  it('cancels a queued request immediately without reading, writing, or releasing A lock', async () => {
    const entered = deferred()
    const release = deferred()
    const h = configurationFixture({
      afterCommand: async (call) => {
        if (call.line === '/permission danger-full-access') {
          entered.resolve()
          await release.promise
        }
      },
    })
    const A = h.repository.setConfiguration('s1', configuration('danger-full-access'))
    await entered.promise
    const controller = new AbortController()
    const cleanup = vi.spyOn(controller.signal, 'removeEventListener')
    const B = h.repository.setConfiguration(
      's1',
      configuration('workspace-write', 'cancelled'),
      controller.signal,
    )
    const outcomeB = B.catch((error: unknown) => error)
    controller.abort()
    try {
      expect(await outcomeB).toMatchObject({ code: 'REQUEST_CANCELLED' })
      const C = h.repository.setConfiguration('s1', configuration('read-only', 'C'))
      await flushContinuations()
      expect(h.calls.filter((call) => call.method === 'session.history')).toHaveLength(1)
      expect(cleanup).toHaveBeenCalledWith('abort', expect.any(Function))
      release.resolve()
      await Promise.all([A, C])
      expect(h.state.get('s1')).toMatchObject({ permission: 'read-only', provider: 'C' })
      expect(h.calls.some((call) => call.provider === 'cancelled')).toBe(false)
    } finally {
      release.resolve()
      await Promise.allSettled([A, B])
      cleanup.mockRestore()
    }
  })

  it.each(['success', 'error'] as const)(
    'waits for active cancellation compensation and reports its %s outcome',
    async (undoOutcome) => {
      const modelEntered = deferred()
      const modelRelease = deferred()
      const undoEntered = deferred()
      const undoRelease = deferred()
      const h = configurationFixture({
        beforeModel: async (call) => {
          if (call.provider === 'cancelled') {
            modelEntered.resolve()
            await modelRelease.promise
          }
        },
        commandOutcome: (call) => (call.line === '/permission read-only' ? undoOutcome : 'success'),
        afterCommand: async (call) => {
          if (call.line === '/permission read-only') {
            undoEntered.resolve()
            await undoRelease.promise
          }
        },
      })
      const controller = new AbortController()
      const A = h.repository.setConfiguration(
        's1',
        configuration('danger-full-access', 'cancelled'),
        controller.signal,
      )
      const outcomeA = A.catch((error: unknown) => error)
      let settledA = false
      void outcomeA.then(() => {
        settledA = true
      })
      await modelEntered.promise
      const B = h.repository.setConfiguration('s1', configuration('workspace-write', 'B'))
      try {
        controller.abort()
        await flushContinuations()
        expect(settledA).toBe(false)
        modelRelease.resolve()
        if (undoOutcome === 'success') {
          await undoEntered.promise
          await flushContinuations()
          expect(h.calls.filter((call) => call.method === 'session.history')).toHaveLength(1)
          expect(settledA).toBe(false)
        }
        undoRelease.resolve()
        expect(await outcomeA).toMatchObject({
          code: undoOutcome === 'success' ? 'REQUEST_CANCELLED' : 'INTERNAL_ERROR',
        })
        await B
        expect(h.state.get('s1')).toMatchObject({ permission: 'workspace-write', provider: 'B' })
      } finally {
        modelRelease.resolve()
        undoRelease.resolve()
        await Promise.allSettled([A, B])
      }
    },
  )

  it.each([
    {
      name: 'protocol error',
      error: new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'Fixture transport failure.',
        retryable: false,
      }),
    },
    {
      name: 'timeout',
      error: normalizeTransportError(
        'session.selectModel',
        new DOMException('Fixture timeout.', 'TimeoutError'),
      ),
    },
  ])('releases a failed $name transaction after compensation', async ({ error }) => {
    const h = configurationFixture({
      beforeModel: (call) => (call.provider === 'failing' ? Promise.reject(error) : Promise.resolve()),
    })
    await expect(
      h.repository.setConfiguration('s1', configuration('danger-full-access', 'failing')),
    ).rejects.toBe(error)
    expect(h.state.get('s1')).toMatchObject({ permission: 'read-only', provider: 'old' })
    await h.repository.setConfiguration('s1', configuration('workspace-write', 'new'))
    expect(h.state.get('s1')).toMatchObject({ permission: 'workspace-write', provider: 'new' })
  })

  it('does no I/O for an already cancelled request', async () => {
    const h = configurationFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      h.repository.setConfiguration('s1', configuration('workspace-write'), controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(h.calls).toEqual([])
  })

  it('does not mutate from a baseline that arrives after cancellation', async () => {
    const h = configurationFixture()
    const baseline = await h.repository.get('s1')
    h.calls.length = 0
    const entered = deferred()
    const release = deferred()
    const read = vi.spyOn(h.repository, 'get').mockImplementationOnce(async () => {
      entered.resolve()
      // A late read can settle successfully even after its caller has cancelled.
      await release.promise
      return baseline
    })
    const controller = new AbortController()
    const A = h.repository.setConfiguration('s1', configuration('danger-full-access'), controller.signal)
    const outcomeA = A.catch((error: unknown) => error)
    await entered.promise
    controller.abort()
    const B = h.repository.setConfiguration('s1', configuration('workspace-write', 'B'))
    try {
      await flushContinuations()
      expect(read).toHaveBeenCalledTimes(1)
      expect(h.calls).toEqual([])
      release.resolve()
      const [errorA] = await Promise.all([outcomeA, B])
      expect(errorA).toMatchObject({ code: 'REQUEST_CANCELLED' })
      expect(h.calls.some((call) => call.line === '/permission danger-full-access')).toBe(false)
      expect(h.state.get('s1')).toMatchObject({ permission: 'workspace-write', provider: 'B' })
    } finally {
      release.resolve()
      await Promise.allSettled([A, B])
      read.mockRestore()
    }
  })
})
