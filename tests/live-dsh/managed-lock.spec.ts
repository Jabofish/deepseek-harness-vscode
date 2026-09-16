import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { acquireManagedRuntimeLock } from './managed-lock.js'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-live-lock-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function lockPath(name: string): string {
  return path.join(scratch, `${name}.lock`)
}

describe('acquireManagedRuntimeLock', () => {
  it('holds the lock for one owner and lets the next run in after release', async () => {
    // The failure this guards: `npx vitest run tests/live-dsh` starts three
    // managed DSH processes at once, each waits behind the same 15s readiness
    // budget, and every spec reports a timeout that looks like a product bug.
    const target = lockPath('serialize')
    const clock = { value: 0 }
    const releaseFirst = await acquireManagedRuntimeLock({ lockPath: target, now: () => clock.value })
    expect(await readFile(target, 'utf8')).toBe(`${process.pid}\n`)

    let released = false
    const second = await acquireManagedRuntimeLock({
      lockPath: target,
      now: () => clock.value,
      sleep: async (ms) => {
        clock.value += ms
        if (released) return
        released = true
        await releaseFirst()
      },
      isProcessAlive: () => true,
    })

    expect(clock.value).toBeGreaterThan(0)
    expect(await readFile(target, 'utf8')).toBe(`${process.pid}\n`)
    await second()
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a lock whose owner process is gone', async () => {
    // A killed spec must not deadlock the suite: the file names its owner, and
    // a lock held by a dead pid is removed instead of waited on.
    const target = lockPath('dead-owner')
    writeFileSync(target, '999999\n')

    const release = await acquireManagedRuntimeLock({
      lockPath: target,
      now: Date.now,
      isProcessAlive: () => false,
    })

    expect(await readFile(target, 'utf8')).toBe(`${process.pid}\n`)
    await release()
  })

  it('reclaims an unwritten lock once it is stale', async () => {
    // A writer killed between create and write leaves an empty file with no
    // owner to check, so the lock also expires on its own age.
    const target = lockPath('unwritten')
    writeFileSync(target, '')
    const past = new Date(Date.now() - 60_000)
    await utimes(target, past, past)

    const release = await acquireManagedRuntimeLock({
      lockPath: target,
      now: Date.now,
      staleUnwrittenMs: 1_000,
      isProcessAlive: () => true,
    })

    expect(await readFile(target, 'utf8')).toBe(`${process.pid}\n`)
    await release()
  })

  it('names the holder when the lock never frees', async () => {
    const target = lockPath('timeout')
    writeFileSync(target, '4242\n')
    const clock = { value: 0 }

    await expect(
      acquireManagedRuntimeLock({
        lockPath: target,
        timeoutMs: 1_000,
        pollIntervalMs: 250,
        now: () => clock.value,
        sleep: (ms) => {
          clock.value += ms
          return Promise.resolve()
        },
        isProcessAlive: () => true,
      }),
    ).rejects.toThrowError(/managed DSH lock.*held by pid 4242/su)
  })
})
