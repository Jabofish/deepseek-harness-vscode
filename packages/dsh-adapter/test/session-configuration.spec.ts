import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import { configuration, configurationFixture } from './support/session-configuration-fixture.js'

describe('session configuration transactions', () => {
  it('honors an explicit Plan choice even while applying a model choice', async () => {
    const h = configurationFixture({ planExposed: false })
    await h.repository.setConfiguration('s1', {
      ...configuration('read-only', 'new'),
      planModeKnown: true,
    })
    expect(h.calls.filter((call) => call.line).map((call) => call.line)).toEqual(['/plan off'])
    expect(h.state.get('s1')).toMatchObject({ plan: false, provider: 'new' })
  })

  it.each(['PROTOCOL_ERROR', 'BACKEND_UNREACHABLE'] as const)(
    'compensates a committed permission command after a lost %s receipt without resending it',
    async (code) => {
      const error = new AppError({ code, message: 'Fixture receipt lost.', retryable: false })
      const h = configurationFixture({
        afterCommand: (call) =>
          call.line === '/permission danger-full-access' ? Promise.reject(error) : Promise.resolve(),
      })
      await expect(h.repository.setConfiguration('s1', configuration('danger-full-access'))).rejects.toBe(
        error,
      )
      expect(h.state.get('s1')?.permission).toBe('read-only')
      expect(h.calls.filter((call) => call.line).map((call) => call.line)).toEqual([
        '/permission danger-full-access',
        '/permission read-only',
      ])
    },
  )

  it('reports an unreadable receipt outcome and releases the lock for a later fresh update', async () => {
    let loseReceipt = true
    const error = new AppError({ code: 'PROTOCOL_ERROR', message: 'Fixture receipt lost.', retryable: false })
    const h = configurationFixture({
      afterCommand: () => {
        if (loseReceipt) {
          loseReceipt = false
          return Promise.reject(error)
        }
        return Promise.resolve()
      },
    })
    const read = h.repository.get.bind(h.repository)
    let reads = 0
    const spy = vi
      .spyOn(h.repository, 'get')
      .mockImplementation((id, signal) => (++reads === 2 ? Promise.reject(error) : read(id, signal)))
    try {
      await expect(
        h.repository.setConfiguration('s1', configuration('danger-full-access')),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
      expect(h.state.get('s1')?.permission).toBe('danger-full-access')
      await h.repository.setConfiguration('s1', configuration('workspace-write', 'new'))
      expect(h.state.get('s1')).toMatchObject({ permission: 'workspace-write', provider: 'new' })
    } finally {
      spy.mockRestore()
    }
  })

  it('does not compensate over an unrelated authoritative permission value after receipt loss', async () => {
    const error = new AppError({ code: 'PROTOCOL_ERROR', message: 'Fixture receipt lost.', retryable: false })
    const h = configurationFixture({
      afterCommand: (call) => {
        if (call.line !== '/permission danger-full-access') return Promise.resolve()
        const state = h.state.get('s1')!
        state.permission = 'workspace-write'
        state.events.push({
          event: {
            type: 'permission/preset',
            seq: state.events.length + 1,
            time: 1010,
            data: { preset: 'workspace-write' },
          },
        })
        return Promise.reject(error)
      },
    })
    await expect(
      h.repository.setConfiguration('s1', configuration('danger-full-access')),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(h.state.get('s1')?.permission).toBe('workspace-write')
    expect(h.calls.filter((call) => call.line).map((call) => call.line)).toEqual([
      '/permission danger-full-access',
    ])
  })

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

  it('does no I/O for an already cancelled request', async () => {
    const h = configurationFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      h.repository.setConfiguration('s1', configuration('workspace-write'), controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(h.calls).toEqual([])
  })
})
