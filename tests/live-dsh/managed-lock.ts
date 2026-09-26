import { randomUUID } from 'node:crypto'
import { open, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Owner file shared by every live spec that starts a managed DSH. */
export const MANAGED_RUNTIME_LOCK_PATH = path.join(os.tmpdir(), 'dsh-vscode-live-dsh.lock')

const GATE_FORMAT = 'dsh-live-lock-gate-v1'

export interface ManagedRuntimeLockDependencies {
  readonly lockPath?: string
  readonly timeoutMs?: number
  /** Reclaim incomplete or unknown-format owner files older than this; complete PID-only and v2 leases use PID liveness. */
  readonly staleUnwrittenMs?: number
  readonly pollIntervalMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly isProcessAlive?: (pid: number) => boolean
  /** The gate has a separate liveness hook so tests can simulate a crashed gate owner. */
  readonly isGateProcessAlive?: (pid: number) => boolean
  /** Read hook for deterministic gate ownership-change cleanup tests. */
  readonly readGateOwner?: (gatePath: string) => Promise<string>
  /** Pause a stale reclaim while its gate is held to make the cross-process race reproducible. */
  readonly afterStaleLeaseObserved?: () => Promise<void>
  /** File-operation hooks keep main-lease acquisition and release failures deterministic in tests. */
  readonly writeLeaseOwner?: (handle: ManagedLockFileHandle, owner: string) => Promise<void>
  readonly closeLockFile?: (handle: ManagedLockFileHandle) => Promise<void>
  readonly readLeaseOwner?: (lockPath: string) => Promise<string>
  readonly removeLeaseFile?: (lockPath: string) => Promise<void>
}

interface ManagedLockFileHandle {
  writeFile(data: string): Promise<void>
  close(): Promise<void>
}

interface GateFileHandle {
  writeFile(data: string): Promise<void>
  close(): Promise<void>
}

interface GateLease {
  readonly owner: string
  release(): Promise<void>
}

interface AcquiredLease {
  readonly owner: string
  readonly handle: ManagedLockFileHandle
}

interface BlockedLease {
  readonly ownerPid: number | undefined
}

/**
 * Serialize every read, creation, release, and stale reclaim of the main lease
 * with a separate atomic gate file. The gate is deliberately never recovered
 * automatically: a dead or unverifiable gate requires explicit manual review.
 */
export async function acquireManagedRuntimeLock(
  dependencies: ManagedRuntimeLockDependencies = {},
): Promise<() => Promise<void>> {
  const lockPath = dependencies.lockPath ?? MANAGED_RUNTIME_LOCK_PATH
  const gatePath = `${lockPath}.gate`
  const timeoutMs = dependencies.timeoutMs ?? 30_000
  const staleUnwrittenMs = dependencies.staleUnwrittenMs ?? 600_000
  const pollIntervalMs = dependencies.pollIntervalMs ?? 250
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? defaultSleep
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive
  const isGateProcessAlive = dependencies.isGateProcessAlive ?? defaultIsProcessAlive
  const readGateOwner = dependencies.readGateOwner ?? ((target: string) => readFile(target, 'utf8'))
  const writeLeaseOwner =
    dependencies.writeLeaseOwner ??
    ((handle: ManagedLockFileHandle, owner: string) => handle.writeFile(owner))
  const closeLockFile = dependencies.closeLockFile ?? ((handle: ManagedLockFileHandle) => handle.close())
  const readLeaseOwner = dependencies.readLeaseOwner ?? ((target: string) => readFile(target, 'utf8'))
  const removeLeaseFile = dependencies.removeLeaseFile ?? ((target: string) => rm(target, { force: true }))
  const deadline = now() + timeoutMs

  for (;;) {
    const gate = await acquireGate({
      gatePath,
      deadline,
      staleUnwrittenMs,
      pollIntervalMs,
      now,
      sleep,
      isGateProcessAlive,
      readGateOwner,
    })

    let result: AcquiredLease | BlockedLease
    try {
      result = await inspectMainLeaseUnderGate({
        lockPath,
        staleUnwrittenMs,
        now,
        isProcessAlive,
        writeLeaseOwner,
        closeLockFile,
        readLeaseOwner,
        removeLeaseFile,
        ...(dependencies.afterStaleLeaseObserved === undefined
          ? {}
          : { afterStaleLeaseObserved: dependencies.afterStaleLeaseObserved }),
      })
    } catch (error) {
      await releaseGatePreservingError(gate, error)
      throw error
    }

    try {
      await gate.release()
    } catch (error) {
      // A failed gate release means no other process may safely inspect the
      // main lease. Preserve both files and require manual recovery.
      const cleanupFailures: unknown[] = [error]
      if ('handle' in result) {
        try {
          await closeLockFile(result.handle)
        } catch (closeError) {
          cleanupFailures.push(closeError)
        }
      }
      throw new AggregateError(
        cleanupFailures,
        `The managed DSH lock gate could not be released safely; its owned lease handle was closed where possible. Preserve ${gatePath} and inspect it manually.`,
        { cause: error },
      )
    }

    if ('handle' in result) {
      return createLeaseRelease({
        lockPath,
        gatePath,
        lease: result,
        timeoutMs,
        staleUnwrittenMs,
        pollIntervalMs,
        now,
        sleep,
        isGateProcessAlive,
        readGateOwner,
        closeLockFile,
        readLeaseOwner,
        removeLeaseFile,
      })
    }

    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for the managed DSH lock at ${lockPath}${result.ownerPid === undefined ? '' : ` held by pid ${result.ownerPid}`}. ` +
          'Another live spec is still starting a runtime; stop it or delete the main lock file.',
      )
    }
    await sleep(pollIntervalMs)
  }
}

interface AcquireGateOptions {
  readonly gatePath: string
  readonly deadline: number
  readonly staleUnwrittenMs: number
  readonly pollIntervalMs: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly isGateProcessAlive: (pid: number) => boolean
  readonly readGateOwner: (gatePath: string) => Promise<string>
}

async function acquireGate(options: AcquireGateOptions): Promise<GateLease> {
  for (;;) {
    const owner = `${GATE_FORMAT}\n${randomUUID()}\n${process.pid}\n`
    let handle: GateFileHandle | undefined
    try {
      handle = await open(options.gatePath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    if (handle !== undefined) {
      try {
        await handle.writeFile(owner)
      } catch (writeError) {
        const cleanupFailures: unknown[] = []
        try {
          await handle.close()
        } catch (closeError) {
          cleanupFailures.push(closeError)
        }
        if (cleanupFailures.length === 0) {
          let current: string | undefined
          try {
            current = await readFile(options.gatePath, 'utf8')
          } catch (readError) {
            if (!isMissingFileError(readError)) cleanupFailures.push(readError)
          }
          // Only remove the gate after a complete owner write has been
          // verified. An incomplete gate is preserved for manual inspection.
          if (current === owner) {
            try {
              await rm(options.gatePath)
            } catch (removeError) {
              if (!isMissingFileError(removeError)) cleanupFailures.push(removeError)
            }
          } else if (current !== undefined) {
            cleanupFailures.push(new Error('The managed DSH gate owner could not be verified.'))
          }
        }
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [writeError, ...cleanupFailures],
            `The managed DSH lock gate could not be initialized safely; preserve ${options.gatePath} and inspect it manually.`,
            { cause: writeError },
          )
        }
        throw writeError
      }

      let closed = false
      let released = false
      let releasePromise: Promise<void> | undefined
      return {
        owner,
        release: () => {
          if (released) return Promise.resolve()
          if (releasePromise !== undefined) return releasePromise
          const attempt = (async () => {
            if (!closed) {
              await handle.close()
              closed = true
            }
            let current: string
            try {
              current = await options.readGateOwner(options.gatePath)
            } catch (error) {
              if (isMissingFileError(error))
                throw new Error(`The managed DSH lock gate disappeared before release: ${options.gatePath}`, {
                  cause: error,
                })
              throw error
            }
            if (current !== owner)
              throw new Error(`The managed DSH lock gate owner changed; preserving ${options.gatePath}.`)
            await rm(options.gatePath)
            released = true
          })()
          releasePromise = attempt
          void attempt.catch(() => {
            if (releasePromise === attempt) releasePromise = undefined
          })
          return attempt
        },
      }
    }

    let current: string | undefined
    try {
      current = await options.readGateOwner(options.gatePath)
    } catch (error) {
      if (isMissingFileError(error)) continue
      throw new Error(
        `Could not inspect the managed DSH lock gate at ${options.gatePath}; it was preserved for manual recovery.`,
        { cause: error },
      )
    }
    const ownerPid = gateOwnerPidFromText(current)
    if (ownerPid !== undefined && !options.isGateProcessAlive(ownerPid)) {
      throw staleGateError(options.gatePath, ownerPid)
    }
    if (
      ownerPid === undefined &&
      (await isUnwrittenLockStale(options.gatePath, options.now, options.staleUnwrittenMs))
    )
      throw staleGateError(options.gatePath)
    if (options.now() >= options.deadline) {
      throw new Error(
        ownerPid === undefined
          ? `Timed out waiting for the managed DSH lock gate at ${options.gatePath}; its owner is incomplete or unverifiable. The gate was preserved for manual recovery.`
          : `Timed out waiting for the managed DSH lock gate at ${options.gatePath} held by pid ${ownerPid}.`,
      )
    }
    await options.sleep(options.pollIntervalMs)
  }
}

interface InspectMainLeaseOptions {
  readonly lockPath: string
  readonly staleUnwrittenMs: number
  readonly now: () => number
  readonly isProcessAlive: (pid: number) => boolean
  readonly writeLeaseOwner: (handle: ManagedLockFileHandle, owner: string) => Promise<void>
  readonly closeLockFile: (handle: ManagedLockFileHandle) => Promise<void>
  readonly readLeaseOwner: (lockPath: string) => Promise<string>
  readonly removeLeaseFile: (lockPath: string) => Promise<void>
  readonly afterStaleLeaseObserved?: () => Promise<void>
}

async function inspectMainLeaseUnderGate(
  options: InspectMainLeaseOptions,
): Promise<AcquiredLease | BlockedLease> {
  for (;;) {
    const owner = `dsh-live-lock-v2\n${randomUUID()}\n${process.pid}\n`
    let handle: ManagedLockFileHandle | undefined
    try {
      handle = await open(options.lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    if (handle !== undefined) {
      try {
        await options.writeLeaseOwner(handle, owner)
      } catch (writeError) {
        const cleanupFailures: unknown[] = []
        try {
          await options.closeLockFile(handle)
        } catch (closeError) {
          cleanupFailures.push(closeError)
        }
        if (cleanupFailures.length === 0) {
          let current: string | undefined
          try {
            current = await options.readLeaseOwner(options.lockPath)
          } catch (readError) {
            if (!isMissingFileError(readError)) cleanupFailures.push(readError)
          }
          if (current === owner) {
            try {
              await options.removeLeaseFile(options.lockPath)
            } catch (removeError) {
              if (!isMissingFileError(removeError)) cleanupFailures.push(removeError)
            }
          } else if (current !== undefined) {
            cleanupFailures.push(
              new Error('The managed DSH lock file was preserved because its owner could not be verified.'),
            )
          }
        }
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [writeError, ...cleanupFailures],
            'The managed DSH lock owner could not be written or safely cleaned up.',
            { cause: writeError },
          )
        }
        throw writeError
      }
      return { owner, handle }
    }

    let observed: string | undefined
    try {
      observed = await options.readLeaseOwner(options.lockPath)
    } catch (error) {
      if (isMissingFileError(error)) continue
      throw error
    }
    const ownerPid = ownerPidFromText(observed)
    const reclaimable =
      ownerPid !== undefined
        ? !options.isProcessAlive(ownerPid)
        : await isUnwrittenLockStale(options.lockPath, options.now, options.staleUnwrittenMs)
    if (!reclaimable) return { ownerPid }

    await options.afterStaleLeaseObserved?.()
    try {
      // The gate prevents any conforming owner from replacing this lease
      // between stale verification and path removal.
      await options.removeLeaseFile(options.lockPath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
}

interface CreateLeaseReleaseOptions {
  readonly lockPath: string
  readonly gatePath: string
  readonly lease: AcquiredLease
  readonly timeoutMs: number
  readonly staleUnwrittenMs: number
  readonly pollIntervalMs: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly isGateProcessAlive: (pid: number) => boolean
  readonly readGateOwner: (gatePath: string) => Promise<string>
  readonly closeLockFile: (handle: ManagedLockFileHandle) => Promise<void>
  readonly readLeaseOwner: (lockPath: string) => Promise<string>
  readonly removeLeaseFile: (lockPath: string) => Promise<void>
}

function createLeaseRelease(options: CreateLeaseReleaseOptions): () => Promise<void> {
  let released = false
  let handleClosed = false
  let releasePromise: Promise<void> | undefined
  return () => {
    if (released) return Promise.resolve()
    if (releasePromise !== undefined) return releasePromise
    const attempt = (async () => {
      const gate = await acquireGate({
        gatePath: options.gatePath,
        deadline: options.now() + options.timeoutMs,
        staleUnwrittenMs: options.staleUnwrittenMs,
        pollIntervalMs: options.pollIntervalMs,
        now: options.now,
        sleep: options.sleep,
        isGateProcessAlive: options.isGateProcessAlive,
        readGateOwner: options.readGateOwner,
      })
      let error: unknown
      let failed = false
      try {
        if (!handleClosed) {
          await options.closeLockFile(options.lease.handle)
          handleClosed = true
        }
        let current: string | undefined
        try {
          current = await options.readLeaseOwner(options.lockPath)
        } catch (readError) {
          if (!isMissingFileError(readError)) throw readError
        }
        if (current === undefined || current !== options.lease.owner) {
          // A replacement outside this protocol is never unlinked. Normal
          // owners cannot replace this file while this process holds the gate.
          released = true
        } else {
          try {
            await options.removeLeaseFile(options.lockPath)
            released = true
          } catch (removeError) {
            if (isMissingFileError(removeError)) released = true
            else throw removeError
          }
        }
      } catch (caught) {
        error = caught
        failed = true
      }
      if (failed) {
        await releaseGatePreservingError(gate, error)
        throw error
      }
      await gate.release()
    })()
    releasePromise = attempt
    void attempt.catch(() => {
      if (releasePromise === attempt) releasePromise = undefined
    })
    return attempt
  }
}

async function releaseGatePreservingError(gate: GateLease, originalError: unknown): Promise<void> {
  try {
    await gate.release()
  } catch (releaseError) {
    throw new AggregateError(
      [originalError, releaseError],
      'The managed DSH operation failed and its gate could not be released safely; preserve it for manual recovery.',
      { cause: releaseError },
    )
  }
}

function gateOwnerPidFromText(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const lines = text.split(/\r?\n/u)
  if (
    lines.length !== 4 ||
    lines[0] !== GATE_FORMAT ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(lines[1] ?? '') ||
    lines[3] !== ''
  )
    return undefined
  return positiveSafePid(lines[2])
}

function staleGateError(gatePath: string, ownerPid?: number): Error {
  return new Error(
    `The managed DSH lock gate at ${gatePath}${ownerPid === undefined ? '' : ` owned by exited pid ${ownerPid}`} is stale and was preserved. ` +
      'Verify no managed DSH test is active, then remove the gate file manually.',
  )
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code === 'ENOENT'
    : false
}

function ownerPidFromText(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const lines = text.split(/\r?\n/u)
  if (
    lines.length === 4 &&
    lines[0] === 'dsh-live-lock-v2' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(lines[1] ?? '') &&
    lines[3] === ''
  ) {
    return positiveSafePid(lines[2])
  }

  // Older versions stored exactly one decimal PID line. Do not accept a PID
  // prefix followed by partial or malformed token data as a live lease.
  if (lines.length === 2 && lines[1] === '') return positiveSafePid(lines[0])
  return undefined
}

function positiveSafePid(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/u.test(value)) return undefined
  const pid = Number(value)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

async function isUnwrittenLockStale(lockPath: string, now: () => number, staleMs: number): Promise<boolean> {
  const details = await stat(lockPath).catch(() => undefined)
  return details !== undefined && now() - details.mtimeMs > staleMs
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A live process the current user may not signal is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
