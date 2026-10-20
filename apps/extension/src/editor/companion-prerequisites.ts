import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { EditorIntegrationStatus } from '@dsh-vscode/domain'
import { runtimePathEntries } from '../backend/runtime-paths.js'
import { resolveWindowsShim } from '../backend/windows-shim.js'

export const PNPM_INSTALL_COMMAND = 'npm install --global pnpm@11.19.0'
export const PNPM_INSTALL_GUIDE = 'https://pnpm.io/installation'

/** Explicit user action: use Corepack's supported repair path, otherwise npm's installer. */
export async function prepareCompanionPackageManager(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if ((await checkCompanionPackageManager()) === 'ready') return
  signal.throwIfAborted()
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  const entries = runtimePathEntries(os, process.env, homedir())
  const find = (name: string): string | undefined =>
    entries
      .flatMap((entry) =>
        (os === 'windows' ? [`${name}.exe`, `${name}.cmd`] : [name]).map((file) => path.join(entry, file)),
      )
      .find(existsSync)
  const corepack = find('corepack')
  const executable = corepack ?? find('npm')
  if (executable === undefined) throw new Error('No package manager is available to prepare pnpm.')
  const resolved = resolveWindowsShim(executable, os, (file) => readFileSync(file, 'utf8'), {
    pathEntries: entries,
  })
  const environment = {
    ...process.env,
    PATH: entries.join(path.delimiter),
    COREPACK_ENABLE_PROJECT_SPEC: '0',
  }
  if (os === 'windows') Reflect.deleteProperty(environment, 'Path')
  await promisify(execFile)(
    resolved?.executable ?? executable,
    [...(resolved?.prefixArgs ?? []), 'install', '--global', 'pnpm@11.19.0'],
    { cwd: homedir(), env: environment, signal, timeout: 120_000, maxBuffer: 1_048_576, windowsHide: true },
  )
  signal.throwIfAborted()
  if ((await checkCompanionPackageManager()) !== 'ready')
    throw new Error('pnpm could not be verified after preparation.')
}

/** Read-only probe: never let Corepack download or repair anything during detection. */
export async function checkCompanionPackageManager(): Promise<
  NonNullable<EditorIntegrationStatus['packageManager']>
> {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  const entries = runtimePathEntries(os, process.env, homedir())
  const names = os === 'windows' ? ['pnpm.exe', 'pnpm.cmd', 'pnpm.bat'] : ['pnpm']
  const executable = entries.flatMap((entry) => names.map((name) => path.join(entry, name))).find(existsSync)
  if (executable === undefined) return 'missing'
  const resolved = resolveWindowsShim(executable, os, (file) => readFileSync(file, 'utf8'), {
    pathEntries: entries,
  })
  const environment = {
    ...process.env,
    PATH: entries.join(path.delimiter),
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
  }
  if (os === 'windows') Reflect.deleteProperty(environment, 'Path')
  try {
    const { stdout } = await promisify(execFile)(
      resolved?.executable ?? executable,
      [...(resolved?.prefixArgs ?? []), '--version'],
      {
        cwd: homedir(),
        env: environment,
        timeout: 5_000,
        maxBuffer: 8_192,
        windowsHide: true,
      },
    )
    return /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(stdout.trim()) ? 'ready' : 'broken'
  } catch {
    return 'broken'
  }
}
