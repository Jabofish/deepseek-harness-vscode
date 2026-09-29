import { describe, expect, it } from 'vitest'

import { resolveVscodeExecutable } from './vscode-executable.ts'

describe('resolveVscodeExecutable', () => {
  it('refuses to run without an explicit executable so the runner cannot download VS Code', () => {
    for (const requested of [undefined, '', '   ']) {
      expect(() => resolveVscodeExecutable(requested)).toThrow(/DSH_VSCODE_E2E_EXECUTABLE/u)
    }
  })

  it('returns the configured path so the override reaches runTests', () => {
    expect(resolveVscodeExecutable(' C:\\tools\\Code.exe ')).toBe('C:\\tools\\Code.exe')
  })
})
