import { describe, expect, it } from 'vitest'
import { workspaceSafeDiagnosticText } from './diagnostic-text.js'

describe('workspaceSafeDiagnosticText', () => {
  it('turns workspace paths into relative ones', () => {
    expect(
      workspaceSafeDiagnosticText("Cannot find module '/home/me/app/src/missing'.", ['/home/me/app']),
    ).toBe("Cannot find module 'src/missing'.")
    expect(
      workspaceSafeDiagnosticText('File C:\\Users\\me\\app\\src\\a.ts is not listed', ['C:\\Users\\me\\app']),
    ).toBe('File src\\a.ts is not listed')
    expect(workspaceSafeDiagnosticText('See c:/users/me/app/src/a.ts', ['C:\\Users\\me\\app'])).toBe(
      'See src/a.ts',
    )
  })

  it('keeps only the file name of an absolute path outside the workspace', () => {
    expect(
      workspaceSafeDiagnosticText("Cannot read '/opt/sdk/lib/types.d.ts' (2 errors)", ['/home/me/app']),
    ).toBe("Cannot read '…/types.d.ts' (2 errors)")
    expect(workspaceSafeDiagnosticText('Module D:\\cache\\pkg\\index.js failed', [])).toBe(
      'Module …/index.js failed',
    )
  })

  it('leaves ordinary messages unchanged', () => {
    expect(workspaceSafeDiagnosticText("Type 'string' is not assignable to type 'number'.", ['/w'])).toBe(
      "Type 'string' is not assignable to type 'number'.",
    )
    expect(workspaceSafeDiagnosticText('Expected 1-2 arguments, but got 3.', [])).toBe(
      'Expected 1-2 arguments, but got 3.',
    )
  })
})
