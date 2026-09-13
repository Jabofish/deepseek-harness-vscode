import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { resolveLiveRuntime } from './runtime.js'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-live-runtime-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('resolveLiveRuntime', () => {
  it('resolves a bare command name to a spawnable PATH entry', () => {
    // The failure this guards: `DSH_LIVE_RUNTIME` defaults to `dsh`, and
    // spawning that name with `shell: false` fails with ENOENT on Windows
    // because the npm shim is `dsh.cmd`. The smoke then reports a readiness
    // timeout for a process that never started.
    const shim = path.join(scratch, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    writeFileSync(shim, '')
    const resolved = resolveLiveRuntime('dsh', {
      pathEntries: [path.join(scratch, 'missing'), scratch],
      fileExists: (filePath) => filePath === shim,
    })

    expect(resolved).toBe(shim)
  })

  it('keeps an explicit path untouched', () => {
    expect(resolveLiveRuntime(' C:\\tools\\dsh.cmd ', { pathEntries: [], fileExists: () => false })).toBe(
      'C:\\tools\\dsh.cmd',
    )
    expect(resolveLiveRuntime('/usr/local/bin/dsh', { pathEntries: [], fileExists: () => false })).toBe(
      '/usr/local/bin/dsh',
    )
  })

  it('names the command and the override when PATH cannot supply it', () => {
    expect(() => resolveLiveRuntime('dsh', { pathEntries: [scratch], fileExists: () => false })).toThrowError(
      /Could not find dsh on PATH.*DSH_LIVE_RUNTIME/su,
    )
  })

  it('rejects an empty override instead of launching nothing', () => {
    expect(() => resolveLiveRuntime('  ', { pathEntries: [], fileExists: () => false })).toThrowError(
      /DSH_LIVE_RUNTIME is empty/u,
    )
  })
})
