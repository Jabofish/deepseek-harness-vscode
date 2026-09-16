import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { isManagedTemporaryWorkspacePath, isPathWithin } from './path-safety.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-path-safety-'))
  temporaryRoots.push(root)
  return root
}

function createDirectoryLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('path safety', () => {
  it('keeps path containment checks boundary-aware', () => {
    const root = path.join(process.cwd(), 'global-storage')

    expect(isPathWithin(root, path.join(root, 'workspace-123'))).toBe(true)
    expect(isPathWithin(root, path.join(root, '..', 'global-storage-backup'))).toBe(false)
    expect(isPathWithin(root, path.join(root, 'workspace-123', '..', '..', 'outside'))).toBe(false)
  })

  it('keeps a missing leaf inside the boundary while it is being created', () => {
    const root = temporaryRoot()
    const folder = path.join(root, 'workspace')
    mkdirSync(path.join(folder, 'src'), { recursive: true })

    expect(isPathWithin(folder, path.join(folder, 'src', 'created.ts'))).toBe(true)
    expect(isPathWithin(folder, path.join(folder, 'src', 'nested', 'created.ts'))).toBe(true)
  })

  it('refuses a linked directory that carries a not-yet-created file outside the boundary', () => {
    const root = temporaryRoot()
    const folder = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    mkdirSync(folder)
    mkdirSync(outside)
    createDirectoryLink(outside, path.join(folder, 'linked'))
    // The escape must not depend on whether the leaf already exists: an
    // existing file under the link is refused because realpath resolves it,
    // and a restore target that does not exist yet must be refused too.
    writeFileSync(path.join(outside, 'present.ts'), 'export {}\n')

    expect(isPathWithin(folder, path.join(folder, 'linked', 'present.ts'))).toBe(false)
    expect(isPathWithin(folder, path.join(folder, 'linked', 'created.ts'))).toBe(false)
    expect(isPathWithin(folder, path.join(folder, 'linked', 'nested', 'created.ts'))).toBe(false)
  })

  it('still accepts a linked directory that stays inside the boundary', () => {
    const root = temporaryRoot()
    const folder = path.join(root, 'workspace')
    mkdirSync(path.join(folder, 'packages', 'app'), { recursive: true })
    createDirectoryLink(path.join(folder, 'packages'), path.join(folder, 'linked-packages'))

    expect(isPathWithin(folder, path.join(folder, 'linked-packages', 'app', 'new.ts'))).toBe(true)
  })

  it('only marks extension-created temporary workspace directories as removable', () => {
    const root = path.join(process.cwd(), 'global-storage')

    expect(isManagedTemporaryWorkspacePath(root, path.join(root, 'workspace-123'))).toBe(true)
    expect(isManagedTemporaryWorkspacePath(root, path.join(root, 'workspace-123', 'nested'))).toBe(false)
    expect(isManagedTemporaryWorkspacePath(root, path.join(root, 'project'))).toBe(false)
    expect(isManagedTemporaryWorkspacePath(root, path.join(process.cwd(), 'workspace-123'))).toBe(false)
  })
})
