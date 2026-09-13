import { existsSync } from 'node:fs'
import path from 'node:path'

export interface LiveRuntimeLookup {
  readonly pathEntries: readonly string[]
  readonly fileExists: (filePath: string) => boolean
}

/**
 * Resolves the executable the live smoke launches.
 *
 * A bare command name cannot be spawned with `shell: false` on Windows: the
 * npm shim is `dsh.cmd`, and `CreateProcess` only appends `.exe`. Resolve the
 * name through PATH with the same candidate order the extension's runtime
 * locator uses, so the documented `DSH_LIVE_RUNTIME=dsh` default launches the
 * same executable the Extension Host would.
 */
export function resolveLiveRuntime(requested: string, lookup?: LiveRuntimeLookup): string {
  const value = requested.trim()
  if (value === '')
    throw new Error('DSH_LIVE_RUNTIME is empty. Set it to the DSH executable path, or unset it to scan PATH.')
  if (value.includes('/') || value.includes('\\')) return value
  const { pathEntries, fileExists } = lookup ?? {
    pathEntries: (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry.trim() !== ''),
    fileExists: existsSync,
  }
  const names =
    process.platform === 'win32' ? [`${value}.cmd`, `${value}.bat`, `${value}.exe`, value] : [value]
  const searched: string[] = []
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry, name)
      searched.push(candidate)
      if (fileExists(candidate)) return candidate
    }
  }
  throw new Error(
    `Could not find ${value} on PATH (searched ${searched.slice(0, 8).join(', ')}${searched.length > 8 ? ', …' : ''}). ` +
      'Set DSH_LIVE_RUNTIME to the DSH executable path.',
  )
}
