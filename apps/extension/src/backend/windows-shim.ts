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
  const assignments = readCmdAssignments(content)
  const lines = content.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || /^\s*@?\s*set\s+/iu.test(line)) continue
    const matches = [...line.matchAll(/"([^"]+)"/gu)]
    for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
      const rawTarget = matches[matchIndex]?.[1]
      if (rawTarget === undefined) continue
      const target = expandCmdValue(rawTarget, assignments, shimDir)
      if (!/\.js$/iu.test(target) || target.includes('%')) continue
      return windowsPath.resolve(target)
    }
  }
  return undefined
}

function readCmdAssignments(content: string): ReadonlyMap<string, string> {
  const assignments = new Map<string, string>()
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*@?\s*set\s+(?:"([^"=]+)=(.*)"|([^\s=]+)=(.*))\s*$/iu)
    if (match === null) continue
    const name = (match[1] ?? match[3] ?? '').trim().toLocaleLowerCase()
    const value = (match[2] ?? match[4] ?? '').trim()
    // npm.cmd conditionally rewrites NPM_CLI_JS from a `FOR /F` result. That
    // result contains %%F and cannot be evaluated without running cmd.exe.
    // Keep the first statically resolvable assignment instead; it is the
    // portable fallback npm itself declares before the conditional rewrite.
    if (name !== '' && !assignments.has(name) && !hasDynamicCmdValue(value, assignments))
      assignments.set(name, value)
  }
  return assignments
}

function hasDynamicCmdValue(value: string, assignments: ReadonlyMap<string, string>): boolean {
  if (value.includes('%%')) return true
  for (const match of value.matchAll(/%([^%]+)%/gu)) {
    const name = match[1]?.toLocaleLowerCase()
    if (name === undefined || name === 'dp0') continue
    const assigned = assignments.get(name)
    if (assigned === undefined || assigned.includes('%%')) return true
  }
  return false
}

function expandCmdValue(
  value: string,
  assignments: ReadonlyMap<string, string>,
  shimDir: string,
  seen = new Set<string>(),
): string {
  const withShimDirectory = value.replace(/%~dp0/giu, shimDir).replace(/%dp0%/giu, shimDir)
  return withShimDirectory.replace(/%([^%]+)%/gu, (whole, name: string) => {
    const key = name.toLocaleLowerCase()
    const assigned = assignments.get(key)
    if (assigned === undefined || seen.has(key)) return whole
    const nextSeen = new Set(seen)
    nextSeen.add(key)
    return expandCmdValue(assigned, assignments, shimDir, nextSeen)
  })
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
