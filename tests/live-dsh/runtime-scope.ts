import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquireManagedRuntimeLock } from './managed-lock.js'

export interface ManagedRuntimeScope {
  readonly home: string
  release(): Promise<void>
}

export interface ManagedRuntimeScopeDependencies {
  readonly environment?: NodeJS.ProcessEnv
  readonly acquireLock?: () => Promise<() => Promise<void>>
  readonly createHome?: () => Promise<string>
  /** Transfer a validated caller-supplied temp home to this scope for cleanup. */
  readonly removeRequestedHome?: boolean
  readonly removeHome?: (home: string) => Promise<void>
}

/** Acquire the cross-process lock before touching the process-wide DSH_HOME. */
export async function acquireManagedRuntimeScope(
  requestedHome?: string,
  dependencies: ManagedRuntimeScopeDependencies = {},
): Promise<ManagedRuntimeScope> {
  const environment = dependencies.environment ?? process.env
  const acquireLock = dependencies.acquireLock ?? acquireManagedRuntimeLock
  const createHome = dependencies.createHome ?? (() => mkdtemp(path.join(os.tmpdir(), 'dsh-live-home-')))
  const removeHome = dependencies.removeHome ?? ((home: string) => rm(home, { recursive: true, force: true }))
  const releaseLock = await acquireLock()
  const previousHome = environment.DSH_HOME
  let home: string | undefined
  let ownsHome = false

  try {
    if (requestedHome === undefined) {
      home = await createHome()
      ownsHome = true
    } else {
      if (!(await isTemporaryHome(requestedHome)))
        throw new Error('A live DSH home override must be a non-empty absolute temporary directory.')
      home = requestedHome
      ownsHome = dependencies.removeRequestedHome === true
    }
    environment.DSH_HOME = home
  } catch (error) {
    const failures: unknown[] = [error]
    if (ownsHome && home !== undefined) {
      try {
        await removeHome(home)
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    try {
      await releaseLock()
    } catch (releaseError) {
      failures.push(releaseError)
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'The managed DSH runtime scope could not be initialized or cleaned up.',
        {
          cause: error,
        },
      )
    }
    throw error
  }

  if (home === undefined) throw new Error('The managed DSH home was not initialized.')
  const scopedHome = home
  let environmentRestored = false
  let homeRemoved = !ownsHome
  let lockReleased = false
  let releaseComplete = false
  let releasePromise: Promise<void> | undefined
  return {
    home: scopedHome,
    release: () => {
      if (releaseComplete) return Promise.resolve()
      if (releasePromise !== undefined) return releasePromise
      const attempt = (async () => {
        const failures: unknown[] = []
        if (!environmentRestored) {
          try {
            if (previousHome === undefined) delete environment.DSH_HOME
            else environment.DSH_HOME = previousHome
            environmentRestored = true
          } catch (error) {
            failures.push(error)
          }
        }
        if (!homeRemoved && environmentRestored) {
          try {
            await removeHome(scopedHome)
            homeRemoved = true
          } catch (error) {
            failures.push(error)
          }
        }
        // Keep the lease if the process-wide environment could not be restored;
        // another scope must not begin while this one still owns DSH_HOME.
        if (environmentRestored && !lockReleased) {
          try {
            await releaseLock()
            lockReleased = true
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
          throw new AggregateError(failures, 'The managed DSH runtime scope could not be released.', {
            cause: failures[0],
          })
        }
        releaseComplete = true
      })()
      releasePromise = attempt
      void attempt.catch(() => {
        // Keep concurrent callers joined to this attempt, but let a later
        // call retry the stages that did not complete.
        if (releasePromise === attempt) releasePromise = undefined
      })
      return attempt
    },
  }
}

async function isTemporaryHome(value: string): Promise<boolean> {
  if (value.trim() === '' || !path.isAbsolute(value)) return false
  const candidate = path.resolve(value)
  const candidateInfo = await lstat(candidate).catch(() => undefined)
  if (candidateInfo === undefined || !candidateInfo.isDirectory() || candidateInfo.isSymbolicLink())
    return false
  const [temporaryRoot, actualCandidate] = await Promise.all([
    realpath(os.tmpdir()).catch(() => undefined),
    realpath(candidate).catch(() => undefined),
  ])
  if (temporaryRoot === undefined || actualCandidate === undefined) return false
  const relative = path.relative(temporaryRoot, actualCandidate)
  return relative !== '' && !path.isAbsolute(relative) && path.dirname(relative) === '.'
}
