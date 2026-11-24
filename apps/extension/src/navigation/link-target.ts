import path from 'node:path'

import { isPathWithin } from '../backend/path-safety.js'
import { isAbsoluteFilePath, isWindowsFilePath } from '../backend/runtime-paths.js'

export interface LinkTargetRequest {
  readonly href: string
  /** Absolute roots this Extension Host owns; nothing outside them may be opened. */
  readonly roots: readonly string[]
  /** Base for a workspace-relative target. */
  readonly basePath: string | undefined
  /**
   * The absolute path of the `file:` URL the href is, when it is one. The Host
   * parses URLs with the editor's own URI parser, so the pure resolver receives
   * the already-decoded path.
   */
  readonly fileUrlPath?: string
}

export type LinkTarget =
  | { readonly kind: 'external'; readonly url: string }
  | {
      readonly kind: 'file'
      readonly path: string
      readonly line?: number
      readonly endLine?: number
      readonly column?: number
    }
  | { readonly kind: 'rejected'; readonly message: string }

/**
 * Resolve one link a surface asked to open into either an external URL or a
 * file inside a workspace this Host owns.
 *
 * The target may be an absolute host path: a real DSH host states every tool
 * card, diff and read path that way, and on POSIX and UNC shares the shape
 * carries no drive letter that would give it away. Such a target has to be
 * recognized before any web-style normalization, or the leading separator that
 * makes it absolute is stripped and the file is looked up under the workspace
 * root instead of where the host said it is.
 */
export function resolveLinkTarget(request: LinkTargetRequest): LinkTarget {
  const target = request.href.trim()
  if (target === '' || target.startsWith('#'))
    return rejected('This Markdown link does not contain a file target.')

  let parsed: URL | undefined
  try {
    parsed = new URL(target)
  } catch {
    parsed = undefined
  }
  if (parsed?.protocol === 'http:' || parsed?.protocol === 'https:') return { kind: 'external', url: target }
  if (parsed?.protocol !== undefined && request.fileUrlPath === undefined && !isAbsoluteFilePath(target))
    return rejected('Only workspace files and http(s) links can be opened.')

  const basePath = request.basePath
  if (basePath === undefined) return rejected('Open a workspace before opening a relative file link.')

  const fileUrlPath = request.fileUrlPath
  let filePath: string | undefined
  let location: FileLinkLocation | undefined
  if (fileUrlPath !== undefined) {
    const fragmentIndex = target.indexOf('#')
    if (fragmentIndex >= 0) location = parseFragmentLocation(target.slice(fragmentIndex + 1))
    filePath = path.resolve(fileUrlPath)
  } else {
    const separator = target.search(/[?#]/)
    const fragmentIndex = target.indexOf('#')
    if (fragmentIndex >= 0) location = parseFragmentLocation(target.slice(fragmentIndex + 1))
    let decoded: string
    try {
      decoded = decodeURIComponent(separator === -1 ? target : target.slice(0, separator))
    } catch {
      return rejected('The file link is not valid.')
    }
    const stripped = stripColonLocation(decoded)
    decoded = stripped.path
    if (location === undefined && stripped.location !== undefined) location = stripped.location
    filePath = workspaceFilePath(decoded, basePath, request.roots)
    if (filePath === undefined) return rejected('The file link is empty.')
  }
  if (!request.roots.some((root) => isOwnedPath(root, filePath)))
    return rejected('Only files inside the current workspace can be opened.')
  return {
    kind: 'file',
    path: filePath,
    ...(location === undefined ? {} : location),
  }
}

interface FileLinkLocation {
  readonly line: number
  readonly endLine?: number
  readonly column?: number
}

function parseFragmentLocation(fragment: string): FileLinkLocation | undefined {
  const lineRange = /^L?(\d+)(?:C(\d+))?(?:-L?(\d+))?$/iu.exec(fragment.trim())
  if (lineRange === null) return undefined
  const line = Number.parseInt(lineRange[1] ?? '', 10)
  if (!Number.isSafeInteger(line) || line < 1) return undefined
  const column = lineRange[2] === undefined ? undefined : Number.parseInt(lineRange[2], 10)
  const endLine = lineRange[3] === undefined ? undefined : Number.parseInt(lineRange[3], 10)
  return {
    line,
    ...(column !== undefined && Number.isSafeInteger(column) && column >= 1 ? { column } : {}),
    ...(endLine !== undefined && Number.isSafeInteger(endLine) && endLine >= line ? { endLine } : {}),
  }
}

function stripColonLocation(decoded: string): {
  readonly path: string
  readonly location?: FileLinkLocation
} {
  const match = /^(.+?):(\d+)(?::(\d+))?$/u.exec(decoded)
  if (match === null) return { path: decoded }
  const candidatePath = match[1] ?? ''
  // Never misinterpret a bare Windows drive like `C:123` as a line suffix.
  if (candidatePath === '' || /^[A-Za-z]$/u.test(candidatePath)) return { path: decoded }
  const line = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isSafeInteger(line) || line < 1) return { path: decoded }
  const column = match[3] === undefined ? undefined : Number.parseInt(match[3], 10)
  return {
    path: candidatePath,
    location: {
      line,
      ...(column !== undefined && Number.isSafeInteger(column) && column >= 1 ? { column } : {}),
    },
  }
}

/**
 * The path one decoded target names. An absolute reading that already names a
 * file inside a root wins: that is the reading under which a host-stated
 * absolute path is openable at all, and on a POSIX host a rooted target like
 * `/home/u/ws/src/main.ts` is exactly that. An absolute reading that names a
 * file beside the workspace is a host path no root owns, and it is refused
 * rather than re-read under the base: re-reading drops the separator that made
 * it absolute and opens a path the link never named, which on a POSIX host
 * turned a target next to the workspace into a file inside it. Everything else
 * — including the Markdown convention of a `/`-prefixed workspace-root-relative
 * link, which is how `/src/main.ts` stays openable — is read relative to the
 * workspace base, the behavior every relative and root-relative link was
 * already opened with. A drive or UNC absolute path is never root-relative:
 * if no owned root contains it, preserve that path for the final rejection.
 */
function workspaceFilePath(decoded: string, basePath: string, roots: readonly string[]): string | undefined {
  if (isAbsoluteFilePath(decoded)) {
    const absolute = resolveInOwnDialect(decoded)
    if (roots.some((root) => isOwnedPath(root, absolute))) return absolute
    if (isWindowsFilePath(decoded) || isHostStatedPath(absolute, roots)) return absolute
  }
  const relative = decoded.replace(/^[/\\]+/u, '')
  return relative === '' ? undefined : path.resolve(basePath, relative)
}

/**
 * Resolve in the dialect the target is spelled in. A Windows drive or UNC path
 * written on one machine names the same file on another, and the POSIX API
 * would fold its whole spelling into the working directory as one segment.
 */
function resolveInOwnDialect(decoded: string): string {
  return isWindowsFilePath(decoded) ? path.win32.resolve(decoded) : path.resolve(decoded)
}

/**
 * Whether an absolute reading outside every root is still a path the host
 * stated. A host states absolute paths for the files it works on — a sibling
 * checkout, a file in the folder that holds the workspace — and those sit in
 * the workspace's own directory chain, which no root owns. A target that
 * shares none of that chain is left to the root-relative convention instead.
 */
function isHostStatedPath(absolute: string, roots: readonly string[]): boolean {
  return roots.some((root) => ancestorDirectories(root).some((ancestor) => isOwnedPath(ancestor, absolute)))
}

/** Every ancestor of one root except the volume root, which owns the whole drive. */
function ancestorDirectories(root: string): readonly string[] {
  const ancestors: string[] = []
  for (let parent = path.dirname(root); parent !== path.dirname(parent); parent = path.dirname(parent))
    ancestors.push(parent)
  return ancestors
}

/**
 * Whether one owned root holds a resolved target. A Windows spelling is
 * compared with Windows semantics on a POSIX Host, where the native comparison
 * reads its separators as literal characters and its root as a sibling
 * directory; on a Windows Host the native comparison already canonicalizes the
 * spelling and stays authoritative.
 */
function isOwnedPath(root: string, candidate: string): boolean {
  if (process.platform !== 'win32' && isWindowsFilePath(root) && isWindowsFilePath(candidate))
    return isWithinWindowsPath(root, candidate)
  return isPathWithin(root, candidate)
}

/** `isPathWithin` for a Windows pair on a Host whose own API cannot read it. */
function isWithinWindowsPath(root: string, candidate: string): boolean {
  const relative = path.win32.relative(
    path.win32.resolve(root).toLowerCase(),
    path.win32.resolve(candidate).toLowerCase(),
  )
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative))
  )
}

function rejected(message: string): LinkTarget {
  return { kind: 'rejected', message }
}
