import { describe, expect, it } from 'vitest'

import { isCanonicalWorkspaceRelativePath } from '../packages/domain/src/feature-contracts.js'

describe('staged feature domain contracts', () => {
  it('accepts only canonical workspace-relative paths', () => {
    for (const value of ['src/main.ts', '.vscode/settings.json', 'folder/file name.md']) {
      expect(isCanonicalWorkspaceRelativePath(value)).toBe(true)
    }
    for (const value of [
      '',
      '/src/main.ts',
      'C:/src/main.ts',
      'file:///src/main.ts',
      '../main.ts',
      'src/../main.ts',
      'src\\main.ts',
      'src/main.ts:secret',
      'src//main.ts',
      'src/./main.ts',
      'src/\u0000main.ts',
    ]) {
      expect(isCanonicalWorkspaceRelativePath(value)).toBe(false)
    }
  })
})
