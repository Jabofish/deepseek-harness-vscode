import path from 'node:path'

import { isPathWithin } from '../backend/path-safety.js'
import { isAbsoluteFilePath } from '../backend/runtime-paths.js'

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
  | { readonly kind: 'file'; readonly path: string }
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
  if (fileUrlPath !== undefined) {
    filePath = path.resolve(fileUrlPath)
  } else {
    const separator = target.search(/[?#]/)
    let decoded: string
    try {
      decoded = decodeURIComponent(separator === -1 ? target : target.slice(0, separator))
    } catch {
      return rejected('The file link is not valid.')
    }
    filePath = workspaceFilePath(decoded, basePath, request.roots)
    if (filePath === undefined) return rejected('The file link is empty.')
  }
  if (!request.roots.some((root) => isPathWithin(root, filePath)))
    return rejected('Only files inside the current workspace can be opened.')
  return { kind: 'file', path: filePath }
}

/**
 * The path one decoded target names. An absolute reading that already names a
 * file inside a root wins: that is the reading under which a host-stated
 * absolute path is openable at all, and on a POSIX host a rooted target like
 * `/home/u/ws/src/main.ts` is exactly that. Everything else — including the
 * Markdown convention of a `/`-prefixed workspace-root-relative link — is read
 * relative to the workspace base, which stays the behavior every relative and
 * root-relative link was already opened with.
 */
function workspaceFilePath(decoded: string, basePath: string, roots: readonly string[]): string | undefined {
  if (isAbsoluteFilePath(decoded)) {
    const absolute = path.resolve(decoded)
    if (roots.some((root) => isPathWithin(root, absolute))) return absolute
  }
  const relative = decoded.replace(/^[/\\]+/u, '')
  return relative === '' ? undefined : path.resolve(basePath, relative)
}

function rejected(message: string): LinkTarget {
  return { kind: 'rejected', message }
}
