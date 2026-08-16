import { describe, expect, it } from 'vitest'

import { resolveWindowsShim } from './windows-shim.js'

const shim = `@ECHO off
SET dp0=%~dp0
"%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*
`

describe('Windows npm shim resolution', () => {
  it('uses an explicitly supplied Node executable instead of the shim', () => {
    const resolved = resolveWindowsShim('C:\\npm\\dsh.cmd', 'windows', () => shim, {
      nodeExecutable: 'C:\\node\\node.exe',
    })

    expect(resolved).toEqual({
      executable: 'C:\\node\\node.exe',
      prefixArgs: ['C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'],
    })
  })

  it('does not use an Electron extension-host executable as Node', () => {
    const resolved = resolveWindowsShim('C:\\npm\\dsh.cmd', 'windows', () => shim, {
      processExecutable: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      pathEntries: ['C:\\nodejs'],
      fileExists: (filePath) => filePath === 'C:\\nodejs\\node.exe',
    })

    expect(resolved?.executable).toBe('C:\\nodejs\\node.exe')
  })

  it('prefers the Node executable beside a fnm npm shim', () => {
    const resolved = resolveWindowsShim('C:\\fnm\\dsh.cmd', 'windows', () => shim, {
      processExecutable: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      pathEntries: ['C:\\nodejs'],
      fileExists: (filePath) => filePath === 'C:\\fnm\\node.exe',
    })

    expect(resolved?.executable).toBe('C:\\fnm\\node.exe')
  })
})
