import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'vitest'

import { acquireManagedRuntimeLock } from './managed-lock.js'
import { acquireManagedRuntimeScope } from './runtime-scope.js'

describe('acquireManagedRuntimeScope', () => {
  it('waits for the lock before replacing an inherited DSH_HOME with a private home', async () => {
    const inheritedHome = 'C:\\Users\\example\\.dsh'
    const temporaryHome = path.resolve(os.tmpdir(), 'dsh-live-isolated')
    const environment: NodeJS.ProcessEnv = { DSH_HOME: inheritedHome }
    let announceLockWait: () => void = () => undefined
    const lockRequested = new Promise<void>((resolve) => {
      announceLockWait = resolve
    })
    let acquireLock: () => void = () => undefined
    const lockAcquired = new Promise<void>((resolve) => {
      acquireLock = resolve
    })
    let releaseLockCount = 0
    let createHomeCount = 0
    const pending = acquireManagedRuntimeScope(undefined, {
      environment,
      acquireLock: () => {
        announceLockWait()
        return lockAcquired.then(() => () => {
          releaseLockCount += 1
          return Promise.resolve()
        })
      },
      createHome: () => {
        createHomeCount += 1
        return Promise.resolve(temporaryHome)
      },
    })

    await lockRequested
    expect(environment.DSH_HOME).toBe(inheritedHome)
    expect(createHomeCount).toBe(0)

    acquireLock()
    const scope = await pending
    expect(scope.home).toBe(temporaryHome)
    expect(environment.DSH_HOME).toBe(temporaryHome)
    expect(createHomeCount).toBe(1)

    await scope.release()
    await scope.release()
    expect(environment.DSH_HOME).toBe(inheritedHome)
    expect(releaseLockCount).toBe(1)
  })

  it('uses a caller-owned isolated home without deleting it', async () => {
    const environment: NodeJS.ProcessEnv = { DSH_HOME: 'C:\\Users\\example\\.dsh' }
    const home = await mkdtemp(path.join(os.tmpdir(), 'seeded-dsh-home-'))
    let removedHome: string | undefined
    try {
      const scope = await acquireManagedRuntimeScope(home, {
        environment,
        acquireLock: () => Promise.resolve(() => Promise.resolve()),
        removeHome: (value) => {
          removedHome = value
          return Promise.resolve()
        },
      })

      expect(environment.DSH_HOME).toBe(home)
      await scope.release()
      expect(environment.DSH_HOME).toBe('C:\\Users\\example\\.dsh')
      expect(removedHome).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('removes a caller home only when ownership is explicitly transferred', async () => {
    const environment: NodeJS.ProcessEnv = { DSH_HOME: 'C:\\Users\\example\\.dsh' }
    const home = await mkdtemp(path.join(os.tmpdir(), 'seeded-dsh-owned-home-'))
    let removedHome: string | undefined
    const scope = await acquireManagedRuntimeScope(home, {
      environment,
      removeRequestedHome: true,
      acquireLock: () => Promise.resolve(() => Promise.resolve()),
      removeHome: (value) => {
        removedHome = value
        return Promise.resolve()
      },
    })

    await scope.release()

    expect(environment.DSH_HOME).toBe('C:\\Users\\example\\.dsh')
    expect(removedHome).toBe(home)
  })

  it('rejects a home override outside the operating system temp directory', async () => {
    const inheritedHome = path.join(path.parse(os.tmpdir()).root, 'dsh-live-user-home-test')
    const environment: NodeJS.ProcessEnv = { DSH_HOME: inheritedHome }
    let releaseLockCount = 0

    await expect(
      acquireManagedRuntimeScope(inheritedHome, {
        environment,
        acquireLock: () =>
          Promise.resolve(() => {
            releaseLockCount += 1
            return Promise.resolve()
          }),
      }),
    ).rejects.toThrow('temporary directory')

    expect(environment.DSH_HOME).toBe(inheritedHome)
    expect(releaseLockCount).toBe(1)
  })

  it('rejects a nested temp home when the fixture contract requires a direct child', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-nested-home-'))
    const home = await mkdtemp(path.join(parent, 'nested-'))
    let releaseLockCount = 0
    try {
      await expect(
        acquireManagedRuntimeScope(home, {
          environment: {},
          acquireLock: () =>
            Promise.resolve(() => {
              releaseLockCount += 1
              return Promise.resolve()
            }),
        }),
      ).rejects.toThrow('temporary directory')
      expect(releaseLockCount).toBe(1)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked home even when its visible path is under the temp directory', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-scope-link-'))
    try {
      const target = path.join(parent, 'target')
      const linkedHome = path.join(parent, `link-${randomUUID()}`)
      await mkdir(target)
      await symlink(target, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
      let releaseLockCount = 0
      const inheritedHome = 'C:\\Users\\example\\.dsh'
      const environment: NodeJS.ProcessEnv = { DSH_HOME: inheritedHome }

      await expect(
        acquireManagedRuntimeScope(linkedHome, {
          environment,
          acquireLock: () =>
            Promise.resolve(() => {
              releaseLockCount += 1
              return Promise.resolve()
            }),
        }),
      ).rejects.toThrow('temporary directory')

      expect(environment.DSH_HOME).toBe(inheritedHome)
      expect(releaseLockCount).toBe(1)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('restores the lock and leaves the inherited home untouched when creation fails', async () => {
    const inheritedHome = 'C:\\Users\\example\\.dsh'
    const environment: NodeJS.ProcessEnv = { DSH_HOME: inheritedHome }
    let releaseLockCount = 0

    await expect(
      acquireManagedRuntimeScope(undefined, {
        environment,
        acquireLock: () =>
          Promise.resolve(() => {
            releaseLockCount += 1
            return Promise.resolve()
          }),
        createHome: () => Promise.reject(new Error('temporary storage unavailable')),
      }),
    ).rejects.toThrow('temporary storage unavailable')

    expect(environment.DSH_HOME).toBe(inheritedHome)
    expect(releaseLockCount).toBe(1)
  })

  it('retries failed home cleanup without repeating environment restoration or lock release', async () => {
    const environment: NodeJS.ProcessEnv = {}
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-release-retry-'))
    const cleanupFailure = new Error('home cleanup failed once')
    let cleanupAttempts = 0
    let releaseAttempts = 0
    try {
      const scope = await acquireManagedRuntimeScope(undefined, {
        environment,
        acquireLock: () =>
          Promise.resolve(() => {
            releaseAttempts += 1
            return Promise.resolve()
          }),
        createHome: () => Promise.resolve(home),
        removeHome: () => {
          cleanupAttempts += 1
          return cleanupAttempts === 1 ? Promise.reject(cleanupFailure) : Promise.resolve()
        },
      })

      const firstAttempt = scope.release()
      const concurrentAttempt = scope.release()
      await expect(firstAttempt).rejects.toBe(cleanupFailure)
      await expect(concurrentAttempt).rejects.toBe(cleanupFailure)
      expect(environment.DSH_HOME).toBeUndefined()
      expect(cleanupAttempts).toBe(1)
      expect(releaseAttempts).toBe(1)

      await scope.release()
      expect(cleanupAttempts).toBe(2)
      expect(releaseAttempts).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('retries failed lock release without repeating successful home cleanup', async () => {
    const inheritedHome = 'C:\\Users\\example\\.dsh'
    const environment: NodeJS.ProcessEnv = { DSH_HOME: inheritedHome }
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-lock-release-retry-'))
    const lockFailure = new Error('lock release failed once')
    let cleanupAttempts = 0
    let releaseAttempts = 0
    try {
      const scope = await acquireManagedRuntimeScope(undefined, {
        environment,
        acquireLock: () =>
          Promise.resolve(() => {
            releaseAttempts += 1
            return releaseAttempts === 1 ? Promise.reject(lockFailure) : Promise.resolve()
          }),
        createHome: () => Promise.resolve(home),
        removeHome: () => {
          cleanupAttempts += 1
          return Promise.resolve()
        },
      })

      await expect(scope.release()).rejects.toBe(lockFailure)
      expect(environment.DSH_HOME).toBe(inheritedHome)
      expect(cleanupAttempts).toBe(1)
      expect(releaseAttempts).toBe(1)

      await scope.release()
      expect(cleanupAttempts).toBe(1)
      expect(releaseAttempts).toBe(2)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports home cleanup and lock release failures together and allows both to retry', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-dual-release-failure-'))
    const cleanupFailure = new Error('home cleanup failed once')
    const lockFailure = new Error('lock release failed once')
    let cleanupAttempts = 0
    let releaseAttempts = 0
    try {
      const scope = await acquireManagedRuntimeScope(undefined, {
        environment: {},
        acquireLock: () =>
          Promise.resolve(() => {
            releaseAttempts += 1
            return releaseAttempts === 1 ? Promise.reject(lockFailure) : Promise.resolve()
          }),
        createHome: () => Promise.resolve(home),
        removeHome: () => {
          cleanupAttempts += 1
          return cleanupAttempts === 1 ? Promise.reject(cleanupFailure) : Promise.resolve()
        },
      })

      let caught: unknown
      try {
        await scope.release()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).errors).toEqual([cleanupFailure, lockFailure])

      await scope.release()
      expect(cleanupAttempts).toBe(2)
      expect(releaseAttempts).toBe(2)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('preserves initialization and lock release failures instead of hiding either one', async () => {
    const initializationFailure = new Error('temporary storage unavailable')
    const lockFailure = new Error('lock release failed')

    let caught: unknown
    try {
      await acquireManagedRuntimeScope(undefined, {
        environment: {},
        acquireLock: () => Promise.resolve(() => Promise.reject(lockFailure)),
        createHome: () => Promise.reject(initializationFailure),
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([initializationFailure, lockFailure])
  })

  it('serializes same-process scopes before changing the shared DSH_HOME', async () => {
    const inheritedHome = 'C:\\Users\\example\\.dsh'
    const environment: NodeJS.ProcessEnv = { DSH_HOME: inheritedHome }
    const lockDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-scope-lock-'))
    const lockPath = path.join(lockDirectory, 'managed.lock')
    const firstHome = path.join(os.tmpdir(), `dsh-live-first-${randomUUID()}`)
    const secondHome = path.join(os.tmpdir(), `dsh-live-second-${randomUUID()}`)
    let createHomeCount = 0
    let acquireLockCount = 0
    let announceSecondLockAttempt: () => void = () => undefined
    const secondLockAttempt = new Promise<void>((resolve) => {
      announceSecondLockAttempt = resolve
    })
    let firstScope: Awaited<ReturnType<typeof acquireManagedRuntimeScope>> | undefined
    let secondScope: Awaited<ReturnType<typeof acquireManagedRuntimeScope>> | undefined
    let secondAcquisition: Promise<Awaited<ReturnType<typeof acquireManagedRuntimeScope>>> | undefined

    const dependencies = {
      environment,
      acquireLock: () => {
        acquireLockCount += 1
        if (acquireLockCount === 2) announceSecondLockAttempt()
        return acquireManagedRuntimeLock({ lockPath, timeoutMs: 5_000, pollIntervalMs: 1 })
      },
      createHome: () => {
        createHomeCount += 1
        return Promise.resolve(createHomeCount === 1 ? firstHome : secondHome)
      },
      removeHome: () => Promise.resolve(),
    }

    try {
      firstScope = await acquireManagedRuntimeScope(undefined, dependencies)
      secondAcquisition = acquireManagedRuntimeScope(undefined, dependencies)
      await secondLockAttempt

      expect(environment.DSH_HOME).toBe(firstHome)
      expect(createHomeCount).toBe(1)

      await firstScope.release()
      secondScope = await secondAcquisition
      expect(environment.DSH_HOME).toBe(secondHome)
      expect(createHomeCount).toBe(2)

      await secondScope.release()
      expect(environment.DSH_HOME).toBe(inheritedHome)
    } finally {
      if (firstScope !== undefined) await firstScope.release()
      if (secondScope !== undefined) await secondScope.release()
      else if (secondAcquisition !== undefined) {
        try {
          secondScope = await secondAcquisition
          await secondScope.release()
        } catch {
          // Preserve the assertion or acquisition error from the test body.
        }
      }
      await rm(lockDirectory, { recursive: true, force: true })
    }
  })
})
