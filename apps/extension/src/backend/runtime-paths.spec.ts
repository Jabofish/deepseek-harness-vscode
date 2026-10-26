import { describe, expect, it } from 'vitest'

import { isAbsoluteFilePath, isLocalRuntimePath, runtimePathEntries } from './runtime-paths.js'

describe('runtime path resolution', () => {
  it('keeps Linux package-manager paths available to a GUI-launched host', () => {
    const entries = runtimePathEntries('linux', {
      PATH: '/usr/bin',
      HOME: '/home/alice',
      NVM_BIN: '/home/alice/.nvm/versions/node/v22.19.0/bin',
      FNM_MULTISHELL_PATH: '/home/alice/.local/share/fnm_multishells/123',
    })

    expect(entries).toEqual([
      '/usr/bin',
      '/home/alice/.nvm/versions/node/v22.19.0/bin',
      '/home/alice/.local/share/fnm_multishells/123',
      '/home/alice/.local/bin',
      '/home/alice/.local/share/pnpm',
      '/home/alice/.npm-global/bin',
      '/home/alice/.local/share/fnm/aliases/default/bin',
      '/home/alice/.fnm/aliases/default/bin',
      '/home/alice/.asdf/shims',
      '/usr/local/bin',
    ])
  })

  it('adds the Windows npm-global and Node locations when a GUI PATH omits them', () => {
    expect(
      runtimePathEntries('windows', {
        PATH: 'C:\\Windows\\System32',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        ProgramFiles: 'C:\\Program Files',
      }),
    ).toEqual([
      'C:\\Windows\\System32',
      'C:\\Users\\alice\\AppData\\Roaming\\npm',
      'C:\\Program Files\\nodejs',
      'C:\\Users\\alice\\AppData\\Roaming\\fnm\\aliases\\default',
    ])
  })

  it('keeps USERPROFILE discovery stable when HOME is overridden by a launcher', () => {
    const entries = runtimePathEntries('windows', {
      PATH: '',
      HOME: 'C:\\launcher-home',
      USERPROFILE: 'C:\\Users\\alice',
    })

    expect(entries).toContain('C:\\Users\\alice\\AppData\\Roaming\\npm')
    expect(entries).toContain('C:\\launcher-home\\AppData\\Roaming\\npm')
  })
})

describe('local runtime paths', () => {
  it.each([
    '\\\\server\\share\\dsh.cmd',
    '//server/share/dsh.cmd',
    '/\\server/share/dsh.cmd',
    '\\/server/share/dsh.cmd',
    '\\\\?\\C:\\tools\\dsh.cmd',
    '//?/UNC/server/share/dsh.cmd',
    '\\\\.\\pipe\\dsh',
    'C:tools\\dsh.cmd',
    '/tools/dsh.cmd',
    '\\tools\\dsh.cmd',
    'C:\\tools\\dsh.cmd\0',
  ])('rejects network, device and non-local Windows paths: %s', (candidate) => {
    expect(isLocalRuntimePath(candidate, 'windows')).toBe(false)
  })

  it.each(['linux', 'macos'] as const)('rejects foreign and network spellings on %s', (os) => {
    for (const candidate of [
      '//server/share/dsh',
      '\\\\server\\share\\dsh',
      'C:\\tools\\dsh.cmd',
      'bin/dsh',
      '/bin/dsh\0',
    ])
      expect(isLocalRuntimePath(candidate, os), candidate).toBe(false)
  })
})

describe('absolute path detection', () => {
  it('rejects command names, relative paths and drive-relative spellings', () => {
    const relative = ['dsh', 'dsh.cmd', 'bin/dsh', './bin/dsh', '.\\bin\\dsh', 'C:tools\\dsh.cmd']
    for (const value of relative) expect(isAbsoluteFilePath(value), value).toBe(false)
  })
})
