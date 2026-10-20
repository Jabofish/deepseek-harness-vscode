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
