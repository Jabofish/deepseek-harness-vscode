import { realpathSync } from 'node:fs'
import path from 'node:path'

export function isManagedTemporaryWorkspacePath(root: string, candidate: string): boolean {
  return path.basename(path.normalize(candidate)).startsWith('workspace-') && isPathWithin(root, candidate)
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(canonicalizePath(root), canonicalizePath(candidate))
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

/**
 * Canonicalize as much of one path as the filesystem can resolve. A leaf that
 * does not exist yet — a checkpoint restore target, a rename destination — has
 * no `realpath` of its own, so its deepest existing ancestor is resolved first
 * and the remaining literal segments are appended. Comparing only the lexical
 * path of a missing leaf let a linked directory inside the workspace carry it
 * across the boundary even though every existing sibling under that link was
 * already refused.
 */
function canonicalizePath(value: string): string {
  const resolved = path.normalize(path.resolve(value))
  const unresolved: string[] = []
  let current = resolved
  for (;;) {
    try {
      const canonical = realpathSync.native(current)
      return toComparable(unresolved.length === 0 ? canonical : path.join(canonical, ...unresolved))
    } catch {
      const parent = path.dirname(current)
      // The walk reached the filesystem root without resolving anything (a
      // Windows drive that is not ready, a disconnected share). Keep the
      // normalized path so the comparison stays boundary-aware.
      if (parent === current) return toComparable(resolved)
      unresolved.unshift(path.basename(current))
      current = parent
    }
  }
}

function toComparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}
