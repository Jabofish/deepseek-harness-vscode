import { describe, expect, it } from 'vitest'

import { resolveWindowsShim } from './windows-shim.js'

const shim = `@ECHO off
SET dp0=%~dp0
"%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*
`

const npmShim = `@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
"%NODE_EXE%" "%NPM_CLI_JS%" %*
`

const actualNpmShim = `:: Created by npm, please don't edit manually.
@ECHO OFF

SETLOCAL

SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)

SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"
)
IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (
  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"
)

"%NODE_EXE%" "%NPM_CLI_JS%" %*
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

  it('resolves the variable-based npm.cmd shim without invoking a shell', () => {
    const resolved = resolveWindowsShim('C:\\Program Files\\nodejs\\npm.cmd', 'windows', () => npmShim, {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    })

    expect(resolved).toEqual({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
    })
  })

  it('keeps npm.cmd on npm-cli.js when the shim has a dynamic prefix rewrite', () => {
    const resolved = resolveWindowsShim(
      'C:\\Program Files\\nodejs\\npm.cmd',
      'windows',
      () => actualNpmShim,
      { nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe' },
    )

    expect(resolved).toEqual({
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
    })
  })
})
