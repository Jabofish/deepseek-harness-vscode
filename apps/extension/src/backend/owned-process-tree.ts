import { execFile, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { AppError } from '@dsh-vscode/domain'
import { windowsSystemToolEnvironment } from './child-environment.js'

/** Retain the child handle: a discovered PID never grants termination authority. */
export async function terminateOwnedWindowsTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const rootPid = child.pid
  // Keep the pre-stop ancestry: an intermediate process can disappear before
  // its surviving grandchild, which a post-stop parent-only check would miss.
  const before = await readWindowsProcesses()
  if (child.exitCode !== null || child.signalCode !== null) {
    if (await hasNoWindowsProcessTree(rootPid, before)) return
    throw new AppError({
      code: 'PROCESS_FAILED',
      message: 'The managed DSH process tree could not be fully stopped. Retry before updating.',
      retryable: true,
    })
  }
  return new Promise((resolve, reject) => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let terminationFinished = false
    let terminationFailure: unknown
    let verifying = false
    const finish = (cause?: unknown): void => {
      clearTimeout(timer)
      child.off('close', onClose)
      if (cause === undefined) resolve()
      else
        reject(
          new AppError({
            code: 'PROCESS_FAILED',
            message: 'The managed DSH process tree could not be fully stopped. Retry before updating.',
            retryable: true,
            cause,
          }),
        )
    }
    const settle = (): void => {
      if (verifying) return
      verifying = true
      clearTimeout(timer)
      if (terminationFailure === undefined) finish()
      else {
        // taskkill can race a descendant's exit and report an error after
        // stopping the tree. The held child's close alone cannot prove that
        // descendants exited, so require a separate read-only tree check.
        void hasNoWindowsProcessTree(rootPid, before).then(
          (gone) => finish(gone ? undefined : terminationFailure),
          () => finish(terminationFailure),
        )
      }
    }
    const onClose = (): void => {
      closed = true
      if (terminationFinished) settle()
    }
    child.once('close', onClose)
    execFile(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(rootPid), '/T', '/F'],
      { windowsHide: true, timeout: 5_000, env: windowsSystemToolEnvironment() },
      (cause) => {
        terminationFailure = cause ?? undefined
        terminationFinished = true
        if (closed) settle()
        else
          timer = setTimeout(
            () => finish(cause ?? new Error('Managed process streams did not close.')),
            2_000,
          )
      },
    )
  })
}

interface WindowsProcess {
  readonly id: number
  readonly parent: number
}

async function hasNoWindowsProcessTree(
  rootPid: number,
  before: readonly WindowsProcess[] | undefined,
): Promise<boolean> {
  if (before === undefined || !before.some((row) => row.id === rootPid)) return false
  const owned = new Set([rootPid])
  let previousSize: number
  do {
    previousSize = owned.size
    for (const row of before) if (owned.has(row.parent)) owned.add(row.id)
  } while (owned.size > previousSize)
  const after = await readWindowsProcesses()
  return after !== undefined && !after.some((row) => owned.has(row.id) || owned.has(row.parent))
}

/** Read identifiers only; this diagnostic never grants authority to signal a PID. */
function readWindowsProcesses(): Promise<readonly WindowsProcess[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference = "Stop"; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 5_000, maxBuffer: 1_048_576, env: windowsSystemToolEnvironment() },
      (cause, stdout) => {
        if (cause !== null) return resolve(undefined)
        try {
          const rows: unknown = JSON.parse(stdout)
          if (!Array.isArray(rows) || rows.length === 0) return resolve(undefined)
          const processes: WindowsProcess[] = []
          for (const row of rows) {
            if (typeof row !== 'object' || row === null) return resolve(undefined)
            const record = row as Record<string, unknown>
            if (
              typeof record.ProcessId !== 'number' ||
              !Number.isSafeInteger(record.ProcessId) ||
              record.ProcessId < 0 ||
              typeof record.ParentProcessId !== 'number' ||
              !Number.isSafeInteger(record.ParentProcessId) ||
              record.ParentProcessId < 0
            )
              return resolve(undefined)
            processes.push({ id: record.ProcessId, parent: record.ParentProcessId })
          }
          resolve(processes)
        } catch {
          resolve(undefined)
        }
      },
    )
  })
}
