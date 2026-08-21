import { describe, expect, it } from 'vitest'

import { resolveNpmExecutable, runtimePathEntries } from './runtime-paths.js'

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
      '/home/alice/.npm-global/bin',
      '/home/alice/.local/share/fnm/aliases/default/bin',
      '/home/alice/.fnm/aliases/default/bin',
      '/home/alice/.asdf/shims',
      '/usr/local/bin',
    ])
  })

  it('resolves npm from an explicit Linux PATH entry', () => {
    expect(
      resolveNpmExecutable('linux', ['/opt/node/bin'], (candidate) => candidate === '/opt/node/bin/npm'),
    ).toBe('/opt/node/bin/npm')
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
    ])
  })

  it('uses the Windows npm shim name when no inspected path exists', () => {
    expect(resolveNpmExecutable('windows', [], () => false)).toBe('npm.cmd')
  })
})
