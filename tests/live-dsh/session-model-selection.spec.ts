import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

// dsh-v0.2.1-alpha.2 / d743267388641bc76f17c45ce8b4c231aed1d32c:
// session-persistence-jsonl/src/format.ts and session-controller/src/model-selection-projection.ts.
// Test-owned V4 facts only; no model requests, accounts or production profile.
describe.skipIf(
  process.env.DSH_LIVE_SMOKE !== '1' || process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.1-alpha.2',
)('live DSH model selection readback', () => {
  it(
    'keeps pending intent over a different past request and clears omitted effort',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-model-selection-'))
      const id = 'selection-fixture'
      // Match the pinned persistence project's UTF-16 slug for this owned path.
      const slug = home
        .replace(
          /[^A-Za-z0-9._\-\\/:]/g,
          (character) => `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        )
        .replace(/[\\/:]+/g, '-')
        .replace(/^-+/, '')
      const directory = path.join(home, 'sessions', `--${slug.slice(0, 251)}--`, id)
      await mkdir(directory, { recursive: true })
      const rows = [
        { type: 'session', version: 4, id, cwd: home, createdAt: 1000, isSeeded: false, delegationDepth: 0 },
        {
          type: 'model/selection',
          seq: 0,
          time: 1001,
          data: { provider: 'old', model: 'old-model', reasoningEffort: 'high' },
        },
        {
          type: 'model/selection',
          seq: 1,
          time: 1002,
          data: { provider: 'pending', model: 'pending-model' },
        },
        { type: 'turn/start', seq: 2, time: 1003, data: { turn: 1 } },
        {
          type: 'request/header',
          seq: 3,
          time: 1004,
          data: {
            reason: 'initial',
            header: { config: { provider: 'old', model: 'old-model', reasoningEffort: 'high' } },
          },
        },
      ]
      await writeFile(
        path.join(directory, 'session.v4.jsonl.zstd'),
        Buffer.concat([
          zstdCompressSync(Buffer.from(JSON.stringify(rows[0]) + '\n')),
          zstdCompressSync(
            Buffer.from(
              rows
                .slice(1)
                .map((row) => JSON.stringify(row))
                .join('\n') + '\n',
            ),
          ),
        ]),
      )
      const runtime = await startManagedRuntime({ dshHome: home, removeDshHomeOnStop: true })
      try {
        expect(runtime.backend.connection.capabilities.adapterId).toBe('dsh-0.2.1-alpha.2')
        expect((await runtime.backend.sessions.list()).items.some((item) => item.id === id)).toBe(true)
        const history = await runtime.backend.sessions.history(id)
        expect(history.projection?.values.modelSelection).toMatchObject({
          next: { provider: 'pending', model: 'pending-model' },
          lastUsed: { provider: 'old', model: 'old-model', reasoningEffort: 'high' },
        })
        expect((await runtime.backend.sessions.get(id)).configuration.model).toEqual({
          providerId: 'pending',
          modelId: 'pending-model',
        })
      } finally {
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
