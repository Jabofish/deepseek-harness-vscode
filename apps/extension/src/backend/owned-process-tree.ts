import { execFile, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { AppError } from '@dsh-vscode/domain'

/** Retain the child handle: a discovered PID never grants termination authority. */
export function terminateOwnedWindowsTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve()
  return new Promise((resolve, reject) => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let terminationFinished = false
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
    const onClose = (): void => {
      closed = true
      if (terminationFinished) finish()
    }
    child.once('close', onClose)
    execFile(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5_000 },
      (cause) => {
        if (cause !== null) {
          finish(cause)
          return
        }
        terminationFinished = true
        if (closed) finish()
        else timer = setTimeout(() => finish(new Error('Managed process streams did not close.')), 2_000)
      },
    )
  })
}
