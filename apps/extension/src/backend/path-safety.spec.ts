import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { isManagedTemporaryWorkspacePath, isPathWithin } from './path-safety.js'

describe('path safety', () => {
  it('keeps path containment checks boundary-aware', () => {
    const root = path.join(process.cwd(), 'global-storage')

    expect(isPathWithin(root, path.join(root, 'workspace-123'))).toBe(true)
    expect(isPathWithin(root, path.join(root, '..', 'global-storage-backup'))).toBe(false)
    expect(isPathWithin(root, path.join(root, 'workspace-123', '..', '..', 'outside'))).toBe(false)
  })

  it('only marks extension-created temporary workspace directories as removable', () => {
    const root = path.join(process.cwd(), 'global-storage')

    expect(isManagedTemporaryWorkspacePath(root, path.join(root, 'workspace-123'))).toBe(true)
    expect(isManagedTemporaryWorkspacePath(root, path.join(root, 'workspace-123', 'nested'))).toBe(false)
    expect(isManagedTemporaryWorkspacePath(root, path.join(root, 'project'))).toBe(false)
    expect(isManagedTemporaryWorkspacePath(root, path.join(process.cwd(), 'workspace-123'))).toBe(false)
  })
})
