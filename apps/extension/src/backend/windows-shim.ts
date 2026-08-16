import { existsSync } from 'node:fs'
import path from 'node:path'
import type { OperatingSystem } from '@dsh-vscode/domain'

const windowsPath = path.win32

export interface ResolvedExecutable {
  readonly executable: string
  readonly prefixArgs: readonly string[]
}

export interface WindowsShimResolutionOptions {
  /** Explicit Node executable, primarily for deterministic tests. */
  readonly nodeExecutable?: string
  /** Injectable filesystem check for deterministic tests. */
  readonly fileExists?: (filePath: string) => boolean
  /** Injectable PATH entries for deterministic tests. */
  readonly pathEntries?: readonly string[]
  /** Extension-host executable. It is deliberately not assumed to be Node. */
  readonly processExecutable?: string
}

export function resolveWindowsShim(
  executable: string,
  os: OperatingSystem,
  readFile: (filePath: string) => string,
  options: WindowsShimResolutionOptions = {},
): ResolvedExecutable | undefined {
  if (os !== 'windows') return undefined
  if (!/\.(cmd|bat)$/i.test(executable)) return undefined
  let content: string
  try {
    content = readFile(executable)
  } catch {
    return undefined
  }
  const target = extractCmdShimTarget(content, windowsPath.dirname(executable))
  if (target === undefined) return undefined
  return {
    // VS Code's extension host is an Electron process, so process.execPath is
    // commonly Code.exe rather than node.exe. npm's Windows shim uses a local
    // node.exe first and then PATH; mirror that behavior for shell:false.
    executable: options.nodeExecutable ?? findNodeExecutable(executable, options),
    prefixArgs: [target],
  }
}

export function extractCmdShimTarget(content: string, shimDir: string): string | undefined {
  const lines = content.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined) continue
    const m = line.match(/"([^"]+\.js)"/i)
    if (m === null) continue
    const jsTarget = m[1] ?? ''
    if (jsTarget === '') continue
    if (/%\w+%/i.test(jsTarget.replace(/%dp0%/gi, ''))) continue
    return windowsPath.resolve(jsTarget.replace(/%dp0%/gi, shimDir))
  }
  return undefined
}

function findNodeExecutable(shimPath: string, options: WindowsShimResolutionOptions): string {
  const fileExists = options.fileExists ?? existsSync
  const localNode = windowsPath.join(windowsPath.dirname(shimPath), 'node.exe')
  if (fileExists(localNode)) return localNode

  const processExecutable = options.processExecutable ?? process.execPath
  if (isNodeExecutable(processExecutable)) return processExecutable

  for (const entry of options.pathEntries ?? (process.env.PATH ?? '').split(windowsPath.delimiter)) {
    if (entry.trim() === '') continue
    const candidate = windowsPath.join(entry, 'node.exe')
    if (fileExists(candidate)) return candidate
  }

  // Keep the same direct, shell-free fallback as the npm shim. If PATH is
  // invalid, spawn/execFile will report the actionable process error.
  return 'node.exe'
}

function isNodeExecutable(value: string): boolean {
  const name = windowsPath.basename(value).toLowerCase()
  return name === 'node' || name === 'node.exe'
}
