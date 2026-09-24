import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { CompanionRegistryDiscoveryProvider } from './companion-provider.js'

describe('companion registry discovery', () => {
  it('keeps registry candidates in the fallback phase and trusts only their loopback endpoint', async () => {
    const previousHome = process.env.DSH_HOME
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-companion-registry-'))
    try {
      process.env.DSH_HOME = dshHome
      const instances = path.join(dshHome, 'runtime', 'vscode', 'instances')
      await mkdir(instances, { recursive: true })
      await writeFile(
        path.join(instances, 'stale.json'),
        JSON.stringify({ host: '127.0.0.1', port: 3949, pid: 25200, version: '0.1.7-alpha.2' }),
        'utf8',
      )
      const provider = new CompanionRegistryDiscoveryProvider()

      expect(provider).toMatchObject({ phase: 'fallback' })
      await expect(provider.discover()).resolves.toEqual([
        {
          endpoint: { host: '127.0.0.1', port: 3949, baseUrl: 'http://127.0.0.1:3949' },
          source: 'companion',
          confidence: 60,
        },
      ])
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})
