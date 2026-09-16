import { open, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Advisory owner file shared by every live spec that starts a managed DSH. */
export const MANAGED_RUNTIME_LOCK_PATH = path.join(os.tmpdir(), 'dsh-vscode-live-dsh.lock')

export interface ManagedRuntimeLockDependencies {
  readonly lockPath?: string
  readonly timeoutMs?: number
  /** Reclaim an unowned lock file older than this; a writer that died between create and write leaves no pid. */
  readonly staleUnwrittenMs?: number
  readonly pollIntervalMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly isProcessAlive?: (pid: number) => boolean
}

/**
 * Serialize managed DSH starts across the live spec files.
 *
 * Vitest serializes the live spec files themselves (see `vitest.config.ts`),
 * so inside one run this lock is uncontended. It stays as the cross-run guard:
 * a spec run while another shell is still starting or holding a managed
 * runtime would otherwise end in a readiness timeout that reads like a product
 * defect.
 *
 * The wait is deliberately shorter than a spec's own budget: the holder keeps
 * the lock for a whole runtime, so a wait that outlasts the lock's default is
 * reported by name instead of surfacing as a bare test timeout.
 *
 * The lock is an advisory file naming the owner pid. A run whose process is
 * gone is reclaimed instead of blocking the suite forever.
 */
export async function acquireManagedRuntimeLock(
  dependencies: ManagedRuntimeLockDependencies = {},
): Promise<() => Promise<void>> {
  const lockPath = dependencies.lockPath ?? MANAGED_RUNTIME_LOCK_PATH
  const timeoutMs = dependencies.timeoutMs ?? 30_000
  const staleUnwrittenMs = dependencies.staleUnwrittenMs ?? 600_000
  const pollIntervalMs = dependencies.pollIntervalMs ?? 250
  const now = dependencies.now ?? Date.now
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${process.pid}\n`)
      return async () => {
        await handle.close().catch(() => undefined)
        await rm(lockPath, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const owner = await readOwnerPid(lockPath)
    const reclaimable =
      owner !== undefined
        ? !isProcessAlive(owner)
        : await isUnwrittenLockStale(lockPath, now, staleUnwrittenMs)
    if (reclaimable) {
      await rm(lockPath, { force: true }).catch(() => undefined)
      continue
    }
    if (now() >= deadline)
      throw new Error(
        `Timed out waiting for the managed DSH lock at ${lockPath}${owner === undefined ? '' : ` held by pid ${owner}`}. ` +
          'Another live spec is still starting a runtime; stop it or delete the lock file.',
      )
    await sleep(pollIntervalMs)
  }
}

async function readOwnerPid(lockPath: string): Promise<number | undefined> {
  const text = await readFile(lockPath, 'utf8').catch(() => undefined)
  const owner = Number.parseInt(text?.trim() ?? '', 10)
  return Number.isSafeInteger(owner) && owner > 0 ? owner : undefined
}

async function isUnwrittenLockStale(lockPath: string, now: () => number, staleMs: number): Promise<boolean> {
  const details = await stat(lockPath).catch(() => undefined)
  return details !== undefined && now() - details.mtimeMs > staleMs
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
