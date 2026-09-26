import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import type * as PathSafety from '../backend/path-safety.js'

vi.mock('../backend/path-safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PathSafety>()
  const { default: nodePath } = await import('node:path')
  return {
    ...actual,
    isPathWithin: (root: string, candidate: string): boolean => {
      // The UNC share in this pure resolver fixture is synthetic and is not
      // mounted in the test process, so use Windows lexical containment here.
      if (root.startsWith('\\\\') && candidate.startsWith('\\\\')) {
        const relative = nodePath.win32.relative(
          nodePath.win32.resolve(root).toLowerCase(),
          nodePath.win32.resolve(candidate).toLowerCase(),
        )
        return (
          relative === '' ||
          (relative !== '..' &&
            !relative.startsWith(`..${nodePath.win32.sep}`) &&
            !nodePath.win32.isAbsolute(relative))
        )
      }
      return actual.isPathWithin(root, candidate)
    },
  }
})

import { resolveLinkTarget, type LinkTarget } from './link-target.js'

const workspace = path.resolve('/ws/root')

function open(href: string, roots: readonly string[] = [workspace], basePath = workspace): LinkTarget {
  return resolveLinkTarget({ href, roots, basePath })
}

describe('link target resolution', () => {
  it('opens http(s) links externally and refuses any other scheme', () => {
    expect(open('https://example.test/page')).toEqual({
      kind: 'external',
      url: 'https://example.test/page',
    })
    expect(open('http://example.test/page')).toEqual({
      kind: 'external',
      url: 'http://example.test/page',
    })
    expect(open('mailto:someone@example.test')).toEqual({
      kind: 'rejected',
      message: 'Only workspace files and http(s) links can be opened.',
    })
  })

  it('rejects a target that names no file', () => {
    expect(open('')).toEqual({
      kind: 'rejected',
      message: 'This Markdown link does not contain a file target.',
    })
    expect(open('#section')).toEqual({
      kind: 'rejected',
      message: 'This Markdown link does not contain a file target.',
    })
    expect(open('/')).toEqual({ kind: 'rejected', message: 'The file link is empty.' })
  })

  it('opens a workspace-relative link under the workspace base', () => {
    expect(open('src/main.ts')).toEqual({ kind: 'file', path: path.join(workspace, 'src', 'main.ts') })
    expect(open('./src/main.ts')).toEqual({ kind: 'file', path: path.join(workspace, 'src', 'main.ts') })
  })

  it('reads a root-relative link as workspace-relative', () => {
    // Markdown documents address workspace files as `/src/main.ts`; that reading
    // has to keep working now that a rooted path can also be a host path.
    expect(open('/src/main.ts')).toEqual({ kind: 'file', path: path.join(workspace, 'src', 'main.ts') })
    expect(open('/src/main.ts#L10')).toEqual({
      kind: 'file',
      path: path.join(workspace, 'src', 'main.ts'),
    })
  })

  it('opens a drive-absolute target the host stated', () => {
    const target = path.join(workspace, 'src', 'main.ts')
    expect(open(target)).toEqual({ kind: 'file', path: target })
    expect(open(target.replace(/\\/gu, '/'))).toEqual({ kind: 'file', path: target })
  })

  it('opens a rooted target the host stated on a host with no drive letter', () => {
    // A POSIX host states `/home/u/ws/src/main.ts`. Stripping the leading
    // separator reads it as workspace-relative and opens a path that exists
    // nowhere instead of the file the card named.
    const root = '/home/u/ws'
    expect(resolveLinkTarget({ href: `${root}/src/main.ts`, roots: [root], basePath: root })).toEqual({
      kind: 'file',
      path: path.join(path.resolve(root), 'src', 'main.ts'),
    })
  })

  it('opens a UNC target the host stated on a share', () => {
    const root = '\\\\server\\share\\ws'
    const target = `${root}\\src\\main.ts`
    expect(resolveLinkTarget({ href: target, roots: [root], basePath: root })).toEqual({
      kind: 'file',
      path: target,
    })
    expect(
      resolveLinkTarget({ href: '\\\\server\\share\\other\\main.ts', roots: [root], basePath: root }),
    ).toEqual({ kind: 'rejected', message: 'Only files inside the current workspace can be opened.' })
    expect(
      resolveLinkTarget({ href: '\\\\server\\other-share\\ws\\main.ts', roots: [root], basePath: root }),
    ).toEqual({ kind: 'rejected', message: 'Only files inside the current workspace can be opened.' })
  })

  it('does not reinterpret an outside drive-absolute target as workspace-relative', () => {
    const root = 'C:\\ws'
    expect(resolveLinkTarget({ href: 'C:\\other\\main.ts', roots: [root], basePath: root })).toEqual({
      kind: 'rejected',
      message: 'Only files inside the current workspace can be opened.',
    })
  })

  it('decodes the target before deciding what it names', () => {
    expect(open('src/my%20file.ts')).toEqual({
      kind: 'file',
      path: path.join(workspace, 'src', 'my file.ts'),
    })
    expect(open('src/main.ts?ref=main')).toEqual({
      kind: 'file',
      path: path.join(workspace, 'src', 'main.ts'),
    })
    expect(open('src/%zz.ts')).toEqual({ kind: 'rejected', message: 'The file link is not valid.' })
  })

  it('refuses every target outside the owned roots', () => {
    const outside = path.join(path.dirname(workspace), 'other', 'main.ts')
    expect(open(outside)).toEqual({
      kind: 'rejected',
      message: 'Only files inside the current workspace can be opened.',
    })
    expect(open('../outside.ts')).toEqual({
      kind: 'rejected',
      message: 'Only files inside the current workspace can be opened.',
    })
    expect(open('/../../etc/passwd')).toEqual({
      kind: 'rejected',
      message: 'Only files inside the current workspace can be opened.',
    })
  })

  it('refuses a relative link before a workspace is open', () => {
    expect(resolveLinkTarget({ href: 'src/main.ts', roots: [], basePath: undefined })).toEqual({
      kind: 'rejected',
      message: 'Open a workspace before opening a relative file link.',
    })
  })

  it('opens the path a file URL names, from the Host-parsed fs path', () => {
    const target = path.join(workspace, 'src', 'main.ts')
    expect(
      resolveLinkTarget({
        href: 'file:///ws/root/src/main.ts',
        roots: [workspace],
        basePath: workspace,
        fileUrlPath: target,
      }),
    ).toEqual({ kind: 'file', path: target })
    expect(
      resolveLinkTarget({
        href: 'file:///elsewhere/main.ts',
        roots: [workspace],
        basePath: workspace,
        fileUrlPath: path.join(path.dirname(workspace), 'elsewhere', 'main.ts'),
      }),
    ).toEqual({
      kind: 'rejected',
      message: 'Only files inside the current workspace can be opened.',
    })
  })
})
