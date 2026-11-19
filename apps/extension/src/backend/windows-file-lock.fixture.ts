import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const fileLockScript = [
  '$stream = [IO.File]::Open($env:DSH_TEST_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)',
  '[Console]::WriteLine("locked")',
  'try { Start-Sleep -Seconds 120 } finally { $stream.Dispose() }',
].join('; ')

export function spawnFileLocker(file: string): ChildProcess {
  return spawn(
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoProfile', '-NonInteractive', '-Command', fileLockScript],
    {
      windowsHide: true,
      shell: false,
      env: { ...process.env, DSH_TEST_LOCK_FILE: file },
    },
  )
}

/** Light-weight Node process whose current directory prevents renaming `directory` on Windows. */
export function spawnDirectoryLocker(directory: string): ChildProcess {
  return spawn(process.execPath, ['-e', "console.log('locked'); setInterval(() => {}, 60_000)"], {
    cwd: directory,
    windowsHide: true,
    shell: false,
  })
}

export function waitForFixtureOutput(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => finish(new Error('file-lock fixture did not become ready')), 10_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.includes('locked')) finish()
    }
    const onExit = (): void => finish(new Error('file-lock fixture exited before becoming ready'))
    const finish = (cause?: Error): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('error', finish)
      child.off('exit', onExit)
      if (cause === undefined) resolve()
      else reject(cause)
    }
    child.stdout?.on('data', onData)
    child.once('error', finish)
    child.once('exit', onExit)
  })
}

export async function stopFixtureChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

/** Returns the errno code when renaming a locked path fails, or `undefined` if rename succeeded. */
export async function readRenameBlockCode(from: string, to: string): Promise<string | undefined> {
  return fs.rename(from, to).then(
    () => undefined,
    (cause: unknown) => (cause instanceof Error && 'code' in cause ? String(cause.code) : undefined),
  )
}
