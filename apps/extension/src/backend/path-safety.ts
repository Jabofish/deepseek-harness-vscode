import { realpathSync } from 'node:fs'
import path from 'node:path'

export function isManagedTemporaryWorkspacePath(root: string, candidate: string): boolean {
  return path.basename(path.normalize(candidate)).startsWith('workspace-') && isPathWithin(root, candidate)
}

export function isPathWithin(root: string, candidate: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(path.resolve(value))
    let canonical = resolved
    try {
      canonical = realpathSync.native(resolved)
    } catch {
      // The linked file may not exist yet; compare its normalized path while
      // preserving the workspace boundary check.
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  }
  const relative = path.relative(normalize(root), normalize(candidate))
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}
