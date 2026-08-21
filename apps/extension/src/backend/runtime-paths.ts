import { existsSync } from 'node:fs'
import path from 'node:path'
import type { OperatingSystem } from '@dsh-vscode/domain'

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

/**
 * Return the PATH entries that a GUI-launched Extension Host can safely use.
 *
 * VS Code started from a desktop launcher does not always source the user's
 * shell profile. Keep the fallback list bounded to well-known package-manager
 * locations instead of scanning the filesystem or invoking a shell.
 */
export function runtimePathEntries(
  os: OperatingSystem,
  environment: RuntimeEnvironment = process.env,
  fallbackHome?: string,
): readonly string[] {
  const pathApi = os === 'windows' ? path.win32 : path.posix
  const delimiter = os === 'windows' ? ';' : ':'
  const entries: string[] = []
  const seen = new Set<string>()
  const add = (value: string | undefined): void => {
    const normalized = value?.trim()
    if (normalized === undefined || normalized === '') return
    const key = os === 'windows' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) return
    seen.add(key)
    entries.push(normalized)
  }
  for (const entry of (environment.PATH ?? '').split(delimiter)) add(entry)

  if (os === 'windows') {
    // A GUI-launched VS Code often does not inherit the terminal's npm-global
    // PATH entry. npm's default Windows prefix is `%APPDATA%\\npm`; include
    // the bounded well-known locations so the runtime can be found without a
    // shell lookup or a filesystem scan.
    add(environment.NPM_CONFIG_PREFIX ?? environment.npm_config_prefix)
    if (environment.APPDATA !== undefined) add(pathApi.join(environment.APPDATA, 'npm'))
    // HOME can be overridden by a shell or an IDE launcher. Keep USERPROFILE
    // as an independent candidate; using `HOME ?? USERPROFILE` made discovery
    // depend on which process launched VS Code.
    for (const home of [environment.USERPROFILE, environment.HOME, fallbackHome]) {
      if (home !== undefined) add(pathApi.join(home, 'AppData', 'Roaming', 'npm'))
    }
    if (environment.ProgramFiles !== undefined) add(pathApi.join(environment.ProgramFiles, 'nodejs'))
    const programFilesX86 = environment['ProgramFiles(x86)']
    if (programFilesX86 !== undefined) add(pathApi.join(programFilesX86, 'nodejs'))
    add(environment.FNM_MULTISHELL_PATH)
    add(environment.NVM_HOME)
    if (environment.VOLTA_HOME !== undefined) add(pathApi.join(environment.VOLTA_HOME, 'bin'))
    return entries
  }

  const home = environment.HOME ?? environment.USERPROFILE
  add(environment.NVM_BIN)
  add(environment.FNM_MULTISHELL_PATH)
  if (environment.VOLTA_HOME !== undefined) add(pathApi.join(environment.VOLTA_HOME, 'bin'))
  if (environment.NODENV_ROOT !== undefined) add(pathApi.join(environment.NODENV_ROOT, 'shims'))
  if (environment.ASDF_DATA_DIR !== undefined) add(pathApi.join(environment.ASDF_DATA_DIR, 'shims'))
  if (home !== undefined) {
    add(pathApi.join(home, '.local', 'bin'))
    add(pathApi.join(home, '.npm-global', 'bin'))
    add(pathApi.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'))
    add(pathApi.join(home, '.fnm', 'aliases', 'default', 'bin'))
    if (environment.ASDF_DATA_DIR === undefined) add(pathApi.join(home, '.asdf', 'shims'))
  }
  add('/usr/local/bin')
  add('/usr/bin')
  return entries
}

export function resolveNpmExecutable(
  os: OperatingSystem,
  entries: readonly string[],
  fileExists: (filePath: string) => boolean = existsSync,
): string {
  const pathApi = os === 'windows' ? path.win32 : path.posix
  const executableName = os === 'windows' ? 'npm.cmd' : 'npm'
  for (const entry of entries) {
    const candidate = pathApi.join(entry, executableName)
    if (fileExists(candidate)) return candidate
  }
  // Let execFile perform the final PATH lookup so a custom shell environment
  // still works when its npm path cannot be inspected ahead of time.
  return executableName
}
