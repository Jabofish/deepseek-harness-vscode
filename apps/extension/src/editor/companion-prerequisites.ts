import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { EditorIntegrationStatus } from '@dsh-vscode/domain'
import { runtimePathEntries } from '../backend/runtime-paths.js'
import { resolveWindowsShim } from '../backend/windows-shim.js'

export const PNPM_INSTALL_COMMAND = 'npm install --global pnpm@11.19.0 --ignore-scripts'
export const PNPM_INSTALL_GUIDE = 'https://pnpm.io/installation'

/** Explicit user action: use Corepack's supported repair path, otherwise npm's installer. */
export async function prepareCompanionPackageManager(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if ((await checkCompanionPackageManager(signal)) === 'ready') return
  signal.throwIfAborted()
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  const entries = runtimePathEntries(os, process.env, homedir())
  const find = (name: string): readonly string[] =>
    entries
      .flatMap((entry) =>
        (os === 'windows' ? [`${name}.exe`, `${name}.cmd`] : [name]).map((file) => path.join(entry, file)),
      )
      .filter(existsSync)
  const environment = {
    ...process.env,
    PATH: entries.join(path.delimiter),
    COREPACK_ENABLE_NETWORK: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
  }
  if (os === 'windows') Reflect.deleteProperty(environment, 'Path')
  const deadline = Date.now() + 120_000
  for (const name of ['corepack', 'npm']) {
    for (const executable of find(name)) {
      signal.throwIfAborted()
      if (Date.now() >= deadline) throw new Error('Timed out while preparing pnpm.')
      const resolved = resolveWindowsShim(executable, os, (file) => readFileSync(file, 'utf8'), {
        pathEntries: entries,
      })
      const run = (args: readonly string[]): Promise<unknown> =>
        promisify(execFile)(resolved?.executable ?? executable, [...(resolved?.prefixArgs ?? []), ...args], {
          cwd: homedir(),
          env: environment,
          signal,
          timeout: Math.max(1, deadline - Date.now()),
          maxBuffer: 1_048_576,
          windowsHide: true,
        })
      try {
        // npm runs package lifecycle scripts by default; suppress them so a
        // compromised pnpm tarball cannot execute code in the Host environment.
        // Corepack downloads pnpm directly and never runs npm scripts.
        await run(
          name === 'npm'
            ? ['install', '--global', 'pnpm@11.19.0', '--ignore-scripts']
            : ['install', '--global', 'pnpm@11.19.0'],
        )
        signal.throwIfAborted()
        if ((await checkCompanionPackageManager(signal)) === 'ready') return
        // Installing Corepack's cached version does not create a missing pnpm launcher.
        if (name === 'corepack') await run(['enable', 'pnpm'])
        if ((await checkCompanionPackageManager(signal)) === 'ready') return
      } catch {
        signal.throwIfAborted()
        // A stale Corepack or read-only installation directory must not prevent
        // trying the remaining known installer locations.
      }
    }
  }
  throw new Error('pnpm could not be verified after preparation.')
}

/** Read-only probe: never let Corepack download or repair anything during detection. */
export async function checkCompanionPackageManager(
  signal?: AbortSignal,
): Promise<NonNullable<EditorIntegrationStatus['packageManager']>> {
  return (await resolveCompanionPackageManager(signal)).status
}

/** Keep managed DSH's PATH consistent with the launcher that passed the read-only probe. */
export async function resolveCompanionPackageManager(signal?: AbortSignal): Promise<{
  readonly status: NonNullable<EditorIntegrationStatus['packageManager']>
  readonly directory?: string
}> {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  const entries = runtimePathEntries(os, process.env, homedir())
  const names = os === 'windows' ? ['pnpm.exe', 'pnpm.bat', 'pnpm.cmd'] : ['pnpm']
  signal?.throwIfAborted()
  // DSH also picks the first launcher in a directory. A working secondary shim
  // cannot make that directory usable when a broken executable shadows it.
  const candidates = entries
    .map((entry) => names.map((name) => path.join(entry, name)).find(existsSync))
    .filter((file): file is string => file !== undefined)
  if (candidates.length === 0) return { status: 'missing' }
  const environment = {
    ...process.env,
    PATH: entries.join(path.delimiter),
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '0',
  }
  if (os === 'windows') Reflect.deleteProperty(environment, 'Path')
  const deadline = Date.now() + 10_000
  for (const executable of candidates) {
    signal?.throwIfAborted()
    if (Date.now() >= deadline) break
    const resolved = resolveWindowsShim(executable, os, (file) => readFileSync(file, 'utf8'), {
      pathEntries: entries,
    })
    try {
      const { stdout } = await promisify(execFile)(
        resolved?.executable ?? executable,
        [...(resolved?.prefixArgs ?? []), '--version'],
        {
          cwd: homedir(),
          env: environment,
          timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
          maxBuffer: 8_192,
          windowsHide: true,
          ...(signal === undefined ? {} : { signal }),
        },
      )
      signal?.throwIfAborted()
      if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(stdout.trim()))
        return {
          status: 'ready',
          directory: path.dirname(
            resolved !== undefined && resolved.prefixArgs.length === 0 ? resolved.executable : executable,
          ),
        }
    } catch {
      signal?.throwIfAborted()
    }
  }
  return { status: 'broken' }
}
