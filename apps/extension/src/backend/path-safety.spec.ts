import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  isManagedTemporaryWorkspaceLocation,
  isManagedTemporaryWorkspacePath,
  isManagedTemporaryWorkspacePathMissing,
  isPathWithin,
} from './path-safety.js'

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

  it('refuses a dangling directory link instead of treating it as a missing in-bound path', () => {
    const root = temporaryRoot()
    const folder = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    const linked = path.join(folder, 'linked')
    mkdirSync(folder)
    mkdirSync(outside)
    createDirectoryLink(outside, linked)
    rmSync(outside, { recursive: true, force: true })

    expect(isPathWithin(folder, path.join(linked, 'created.ts'))).toBe(false)
  })

  it('still accepts a linked directory that stays inside the boundary', () => {
    const root = temporaryRoot()
    const folder = path.join(root, 'workspace')
    mkdirSync(path.join(folder, 'packages', 'app'), { recursive: true })
    createDirectoryLink(path.join(folder, 'packages'), path.join(folder, 'linked-packages'))

    expect(isPathWithin(folder, path.join(folder, 'linked-packages', 'app', 'new.ts'))).toBe(true)
  })

  it('only marks extension-created temporary workspace directories as removable', () => {
    const root = temporaryRoot()
    const managed = path.join(root, 'workspace-123')
    const nested = path.join(root, 'projects', 'workspace-456')
    const project = path.join(root, 'project')
    mkdirSync(managed)
    mkdirSync(nested, { recursive: true })
    mkdirSync(project)

    expect(isManagedTemporaryWorkspacePath(root, managed)).toBe(true)
    expect(isManagedTemporaryWorkspaceLocation(root, managed)).toBe(true)
    expect(isManagedTemporaryWorkspacePath(root, nested)).toBe(false)
    expect(isManagedTemporaryWorkspacePath(root, project)).toBe(false)
    expect(isManagedTemporaryWorkspacePath(root, path.join(process.cwd(), 'workspace-123'))).toBe(false)
  })

  it('does not treat a linked workspace-looking directory as extension-owned', () => {
    const root = temporaryRoot()
    const outside = path.join(root, 'outside')
    const linked = path.join(root, 'workspace-linked')
    mkdirSync(outside)
    createDirectoryLink(outside, linked)

    expect(isManagedTemporaryWorkspacePath(root, linked)).toBe(false)
  })

  it('requires the managed workspace path to be an existing directory', () => {
    const root = temporaryRoot()
    const file = path.join(root, 'workspace-file')
    const missing = path.join(root, 'workspace-missing')
    writeFileSync(file, 'not a directory')

    expect(isManagedTemporaryWorkspaceLocation(root, missing)).toBe(true)
    expect(isManagedTemporaryWorkspacePath(root, missing)).toBe(false)
    expect(isManagedTemporaryWorkspacePathMissing(root, missing)).toBe(true)
    expect(isManagedTemporaryWorkspacePath(root, file)).toBe(false)
    expect(isManagedTemporaryWorkspacePathMissing(root, file)).toBe(false)
  })

  it('does not treat a linked workspace directory as a missing path', () => {
    const root = temporaryRoot()
    const outside = path.join(root, 'outside')
    const linked = path.join(root, 'workspace-linked')
    mkdirSync(outside)
    createDirectoryLink(outside, linked)

    expect(isManagedTemporaryWorkspacePathMissing(root, linked)).toBe(false)
  })
})
