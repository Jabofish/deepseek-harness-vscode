import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

export function isManagedTemporaryWorkspacePath(root: string, candidate: string): boolean {
  if (!isManagedTemporaryWorkspaceLocation(root, candidate)) return false

  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)

  try {
    // The manager creates each workspace with mkdtemp directly under the
    // globalStorage root. Refuse links and other entries before any recursive
    // removal, then verify the resolved directory is still a direct child.
    const candidateStat = lstatSync(resolvedCandidate)
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return false

    const canonicalRoot = realpathSync.native(resolvedRoot)
    const canonicalCandidate = realpathSync.native(resolvedCandidate)
    return (
      toComparable(path.dirname(canonicalCandidate)) === toComparable(canonicalRoot) &&
      path.basename(canonicalCandidate).startsWith('workspace-')
    )
  } catch {
    return false
  }
}

/** Check the direct-child name and parent without requiring the directory itself to exist. */
export function isManagedTemporaryWorkspaceLocation(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (
    toComparable(path.dirname(resolvedCandidate)) !== toComparable(resolvedRoot) ||
    !path.basename(resolvedCandidate).startsWith('workspace-')
  ) {
    return false
  }

  try {
    // globalStorage is expected to be an ordinary directory. If it is replaced
    // by a symlink/junction, realpath alone would bless the external target as
    // the managed root and make its direct children appear removable.
    const rootStat = lstatSync(resolvedRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    const canonicalRoot = realpathSync.native(resolvedRoot)
    const canonicalParent = realpathSync.native(path.dirname(resolvedCandidate))
    return toComparable(canonicalParent) === toComparable(canonicalRoot)
  } catch {
    return false
  }
}

/** True only for a missing direct child; links, files and inaccessible paths are not missing. */
export function isManagedTemporaryWorkspacePathMissing(root: string, candidate: string): boolean {
  if (!isManagedTemporaryWorkspaceLocation(root, candidate)) return false
  try {
    lstatSync(path.resolve(candidate))
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}

export function isPathWithin(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalizePath(root)
  const canonicalCandidate = canonicalizePath(candidate)
  if (canonicalRoot === undefined || canonicalCandidate === undefined) return false

  const relative = path.relative(canonicalRoot, canonicalCandidate)
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
function canonicalizePath(value: string): string | undefined {
  const resolved = path.normalize(path.resolve(value))
  const unresolved: string[] = []
  let current = resolved
  for (;;) {
    try {
      const canonical = realpathSync.native(current)
      return toComparable(unresolved.length === 0 ? canonical : path.join(canonical, ...unresolved))
    } catch {
      try {
        // Only a genuinely absent path segment may be appended lexically. A
        // dangling symlink, permission failure, or unreadable mount is not
        // evidence that the unresolved suffix remains inside the boundary.
        lstatSync(current)
        return undefined
      } catch (error) {
        if (!isNotFound(error)) return undefined
      }

      const parent = path.dirname(current)
      if (parent === current) return undefined
      unresolved.unshift(path.basename(current))
      current = parent
    }
  }
}

function toComparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
