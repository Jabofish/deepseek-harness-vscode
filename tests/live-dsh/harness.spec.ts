import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { startManagedProcessWithCleanup, stopManagedProcessWithRetry } from './harness.js'
import { acquireManagedRuntimeScope } from './runtime-scope.js'

describe('stopManagedProcessWithRetry', () => {
  it('does not dispose the supervisor after a clean stop', async () => {
    const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    await expect(stopManagedProcessWithRetry({ stop }, dispose)).resolves.toBeUndefined()

    expect(stop).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('asks the supervisor to retry a transient stop failure', async () => {
    const stop = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('first stop failed'))
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    await expect(stopManagedProcessWithRetry({ stop }, dispose)).resolves.toBeUndefined()

    expect(stop).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('surfaces both failures when the supervisor still cannot stop its process', async () => {
    const firstFailure = new Error('first stop failed')
    const retryFailure = new Error('retry stop failed')
    const stop = vi.fn<() => Promise<void>>().mockRejectedValueOnce(firstFailure)
    const dispose = vi.fn<() => Promise<void>>().mockRejectedValueOnce(retryFailure)

    await expect(stopManagedProcessWithRetry({ stop }, dispose)).rejects.toMatchObject({
      errors: [firstFailure, retryFailure],
    })
  })
})

describe('managed startup cleanup', () => {
  it('keeps the scope and disposable home while a failed child stop is unconfirmed', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-startup-home-'))
    const environment: NodeJS.ProcessEnv = { DSH_HOME: 'inherited-profile' }
    const scope = await acquireManagedRuntimeScope(home, {
      environment,
      removeRequestedHome: true,
      acquireLock: () => Promise.resolve(() => Promise.resolve()),
    })
    const startupFailure = new Error('readiness timed out')
    const childStillAlive = new Error('owned child stop is not confirmed')
    const dispose = vi.fn<() => Promise<void>>().mockRejectedValue(childStillAlive)
    const cleanupScope = vi.fn(() => scope.release())

    try {
      await expect(
        startManagedProcessWithCleanup(() => Promise.reject(startupFailure), dispose, cleanupScope),
      ).rejects.toMatchObject({ errors: [startupFailure, childStillAlive] })

      expect(dispose).toHaveBeenCalledOnce()
      expect(cleanupScope).not.toHaveBeenCalled()
      expect(environment.DSH_HOME).toBe(home)
      await expect(stat(home)).resolves.toBeDefined()

      // Once the owner confirms the process has stopped, the same scope can
      // restore DSH_HOME and remove only the explicitly transferred fixture.
      dispose.mockResolvedValueOnce(undefined)
      await dispose()
      await cleanupScope()
      expect(cleanupScope).toHaveBeenCalledOnce()
      expect(environment.DSH_HOME).toBe('inherited-profile')
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('removes an explicitly owned home after failed startup cleanup succeeds', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-startup-clean-home-'))
    const environment: NodeJS.ProcessEnv = { DSH_HOME: 'inherited-profile' }
    const scope = await acquireManagedRuntimeScope(home, {
      environment,
      removeRequestedHome: true,
      acquireLock: () => Promise.resolve(() => Promise.resolve()),
    })

    try {
      await expect(
        startManagedProcessWithCleanup(
          () => Promise.reject(new Error('readiness timed out')),
          () => Promise.resolve(),
          () => scope.release(),
        ),
      ).rejects.toThrow('readiness timed out')

      expect(environment.DSH_HOME).toBe('inherited-profile')
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
