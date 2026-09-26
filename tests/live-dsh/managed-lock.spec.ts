import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
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
    expect((await readFile(target, 'utf8')).split('\n')[2]).toBe(String(process.pid))

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
    expect((await readFile(target, 'utf8')).split('\n')[2]).toBe(String(process.pid))
    await second()
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not remove a replacement lock when an old owner releases', async () => {
    const target = lockPath('replacement-owner')
    const releaseOld = await acquireManagedRuntimeLock({ lockPath: target })
    const oldOwner = await readFile(target, 'utf8')

    // Simulate a stale lock being manually cleared before a new test acquires
    // the same path. The old lease may finish after the new owner has started.
    await rm(target, { force: true })
    const releaseNew = await acquireManagedRuntimeLock({ lockPath: target })
    const newOwner = await readFile(target, 'utf8')
    expect(newOwner).not.toBe(oldOwner)

    await releaseOld()
    expect(await readFile(target, 'utf8')).toBe(newOwner)

    await releaseNew()
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes separate Node processes and reclaims the child lease after it exits', async () => {
    const target = lockPath('cross-process')
    const childSource = `
      const { acquireManagedRuntimeLock } = await import(process.argv[1]);
      const release = await acquireManagedRuntimeLock({ lockPath: process.argv[2] });
      process.stdout.write('LOCKED\\n');
      process.stdin.once('data', async (command) => {
        if (String(command).trim() === 'release') {
          await release();
          process.stdout.write('RELEASED\\n');
          process.exit(0);
        }
        if (String(command).trim() === 'abandon') process.exit(0);
      });
    `
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        childSource,
        new URL('./managed-lock.ts', import.meta.url).href,
        target,
      ],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const output = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })

    try {
      const ready = await new Promise<string>((resolve, reject) => {
        output.once('line', (line: string) => resolve(line))
        child.once('error', reject)
        child.once('exit', (code) => reject(new Error(`Lock child exited early (${code}): ${stderr}`)))
      })
      expect(ready).toBe('LOCKED')
      const childLease = await readFile(target, 'utf8')
      expect(childLease.split('\n')[2]).toBe(String(child.pid))

      await expect(acquireManagedRuntimeLock({ lockPath: target, timeoutMs: 0 })).rejects.toThrow(
        `held by pid ${child.pid}`,
      )

      child.stdin.write('abandon\n')
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code))
      })
      expect(exitCode).toBe(0)

      const releaseParent = await acquireManagedRuntimeLock({
        lockPath: target,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      })
      expect((await readFile(target, 'utf8')).split('\n')[2]).toBe(String(process.pid))
      await releaseParent()
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      output.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.write('release\n')
        const exited = await Promise.race([
          new Promise<true>((resolve) => child.once('exit', () => resolve(true))),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
        ])
        if (!exited) {
          child.kill()
          await new Promise<void>((resolve) => child.once('exit', () => resolve()))
        }
      }
    }
  })

  it('closes its own lease handle and preserves both paths when gate ownership changes on release', async () => {
    const target = lockPath('gate-owner-changed-on-acquire')
    const gatePath = `${target}.gate`
    const replacementGateOwner = `dsh-live-lock-gate-v1\n00000000-0000-4000-8000-000000000002\n${process.pid}\n`
    let gateReads = 0
    let closeAttempts = 0

    try {
      await expect(
        acquireManagedRuntimeLock({
          lockPath: target,
          readGateOwner: async (path) => {
            gateReads += 1
            const current = await readFile(path, 'utf8')
            return gateReads === 1 ? replacementGateOwner : current
          },
          closeLockFile: async (handle) => {
            closeAttempts += 1
            await handle.close()
          },
        }),
      ).rejects.toThrow(/gate could not be released safely/iu)

      expect(gateReads).toBe(1)
      expect(closeAttempts).toBe(1)
      expect((await readFile(target, 'utf8')).split('\n')[2]).toBe(String(process.pid))
      expect((await readFile(gatePath, 'utf8')).split('\n')[2]).toBe(String(process.pid))
    } finally {
      await rm(target, { force: true })
      await rm(gatePath, { force: true })
    }
  })

  it('deduplicates a concurrent close failure and retries without reclosing a closed handle', async () => {
    const target = lockPath('close-retry')
    const closeFailure = new Error('lock handle close failed once')
    let closeAttempts = 0
    let ownerReadAttempts = 0
    const release = await acquireManagedRuntimeLock({
      lockPath: target,
      closeLockFile: async (handle) => {
        closeAttempts += 1
        if (closeAttempts === 1) throw closeFailure
        await handle.close()
      },
      readLeaseOwner: async (leasePath) => {
        ownerReadAttempts += 1
        return readFile(leasePath, 'utf8')
      },
    })

    const firstAttempt = release()
    const concurrentAttempt = release()
    await expect(firstAttempt).rejects.toBe(closeFailure)
    await expect(concurrentAttempt).rejects.toBe(closeFailure)
    expect(closeAttempts).toBe(1)
    expect(ownerReadAttempts).toBe(0)

    await release()
    await release()
    expect(closeAttempts).toBe(2)
    expect(ownerReadAttempts).toBe(1)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries owner reads without closing an already closed handle', async () => {
    const target = lockPath('owner-read-retry')
    const readFailure = Object.assign(new Error('lock owner read failed once'), { code: 'EIO' })
    let closeAttempts = 0
    let ownerReadAttempts = 0
    const release = await acquireManagedRuntimeLock({
      lockPath: target,
      closeLockFile: async (handle) => {
        closeAttempts += 1
        await handle.close()
      },
      readLeaseOwner: async (leasePath) => {
        ownerReadAttempts += 1
        if (ownerReadAttempts === 1) throw readFailure
        return readFile(leasePath, 'utf8')
      },
    })

    await expect(release()).rejects.toBe(readFailure)
    expect(closeAttempts).toBe(1)
    expect(ownerReadAttempts).toBe(1)
    expect((await readFile(target, 'utf8')).split('\n')[2]).toBe(String(process.pid))

    await release()
    expect(closeAttempts).toBe(1)
    expect(ownerReadAttempts).toBe(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries unlink errors without closing an already closed handle', async () => {
    const target = lockPath('unlink-retry')
    const unlinkFailure = Object.assign(new Error('lock removal failed once'), { code: 'EIO' })
    let closeAttempts = 0
    let unlinkAttempts = 0
    const release = await acquireManagedRuntimeLock({
      lockPath: target,
      closeLockFile: async (handle) => {
        closeAttempts += 1
        await handle.close()
      },
      removeLeaseFile: async (leasePath) => {
        unlinkAttempts += 1
        if (unlinkAttempts === 1) throw unlinkFailure
        await rm(leasePath, { force: true })
      },
    })

    await expect(release()).rejects.toBe(unlinkFailure)
    expect(closeAttempts).toBe(1)
    expect(unlinkAttempts).toBe(1)
    expect((await readFile(target, 'utf8')).split('\n')[2]).toBe(String(process.pid))

    await release()
    expect(closeAttempts).toBe(1)
    expect(unlinkAttempts).toBe(2)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finishes an old lease when its lock file is already gone', async () => {
    const target = lockPath('missing-lock')
    let ownerReadAttempts = 0
    let unlinkAttempts = 0
    const release = await acquireManagedRuntimeLock({
      lockPath: target,
      readLeaseOwner: async (leasePath) => {
        ownerReadAttempts += 1
        return readFile(leasePath, 'utf8')
      },
      removeLeaseFile: async (leasePath) => {
        unlinkAttempts += 1
        await rm(leasePath, { force: true })
      },
    })

    await rm(target, { force: true })
    await release()
    await release()

    expect(ownerReadAttempts).toBe(1)
    expect(unlinkAttempts).toBe(0)
  })

  it('closes and removes the verified owner file when the write operation rejects', async () => {
    const target = lockPath('owner-write-retry')
    const writeFailure = new Error('owner write failed after writing')
    let closeAttempts = 0
    let ownerReadAttempts = 0
    let unlinkAttempts = 0

    await expect(
      acquireManagedRuntimeLock({
        lockPath: target,
        writeLeaseOwner: async (handle, owner) => {
          await handle.writeFile(owner)
          throw writeFailure
        },
        closeLockFile: async (handle) => {
          closeAttempts += 1
          await handle.close()
        },
        readLeaseOwner: async (leasePath) => {
          ownerReadAttempts += 1
          return readFile(leasePath, 'utf8')
        },
        removeLeaseFile: async (leasePath) => {
          unlinkAttempts += 1
          await rm(leasePath, { force: true })
        },
      }),
    ).rejects.toBe(writeFailure)

    expect(closeAttempts).toBe(1)
    expect(ownerReadAttempts).toBe(1)
    expect(unlinkAttempts).toBe(1)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves and reports a partial owner file when a failed write cannot prove ownership', async () => {
    const target = lockPath('partial-owner-write')
    const writeFailure = new Error('owner write failed after a partial write')
    const clock = { value: Date.now() }
    const staleUnwrittenMs = 60_000
    let closeAttempts = 0
    let ownerReadAttempts = 0
    let unlinkAttempts = 0
    let caught: unknown

    try {
      await acquireManagedRuntimeLock({
        lockPath: target,
        writeLeaseOwner: async (handle, owner) => {
          await handle.writeFile(owner.slice(0, owner.indexOf('\n') + 1))
          throw writeFailure
        },
        closeLockFile: async (handle) => {
          closeAttempts += 1
          await handle.close()
        },
        readLeaseOwner: async (leasePath) => {
          ownerReadAttempts += 1
          return readFile(leasePath, 'utf8')
        },
        removeLeaseFile: async (leasePath) => {
          unlinkAttempts += 1
          await rm(leasePath, { force: true })
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors[0] as unknown).toBe(writeFailure)
    expect(String((caught as AggregateError).errors[1])).toContain(
      'preserved because its owner could not be verified',
    )
    expect(closeAttempts).toBe(1)
    expect(ownerReadAttempts).toBe(1)
    expect(unlinkAttempts).toBe(0)
    expect(await readFile(target, 'utf8')).toBe('dsh-live-lock-v2\n')
    clock.value = (await stat(target)).mtimeMs

    let inspectedPid = false
    await expect(
      acquireManagedRuntimeLock({
        lockPath: target,
        timeoutMs: 0,
        staleUnwrittenMs,
        now: () => clock.value,
        isProcessAlive: () => {
          inspectedPid = true
          return true
        },
      }),
    ).rejects.toThrow('Timed out waiting for the managed DSH lock')
    expect(inspectedPid).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('dsh-live-lock-v2\n')

    clock.value += staleUnwrittenMs + 1
    const retryRelease = await acquireManagedRuntimeLock({
      lockPath: target,
      timeoutMs: 0,
      staleUnwrittenMs,
      now: () => clock.value,
      isProcessAlive: () => {
        inspectedPid = true
        return true
      },
    })
    const retriedOwner = await readFile(target, 'utf8')
    expect(retriedOwner).toMatch(
      /^dsh-live-lock-v2\n[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n[0-9]+\n$/iu,
    )
    expect(retriedOwner.split('\n')[2]).toBe(String(process.pid))
    expect(inspectedPid).toBe(false)
    await retryRelease()
  })

  it('preserves a replacement owner if the original owner write fails', async () => {
    const target = lockPath('replacement-during-owner-write')
    const writeFailure = new Error('owner write failed after replacement')
    const replacement = 'dsh-live-lock-v2\n00000000-0000-4000-8000-000000000001\n' + process.pid + '\n'
    let closeAttempts = 0
    let unlinkAttempts = 0
    let caught: unknown

    try {
      await acquireManagedRuntimeLock({
        lockPath: target,
        writeLeaseOwner: async (handle, owner) => {
          await handle.writeFile(owner)
          await rm(target, { force: true })
          await writeFile(target, replacement, 'utf8')
          throw writeFailure
        },
        closeLockFile: async (handle) => {
          closeAttempts += 1
          await handle.close()
        },
        removeLeaseFile: async (leasePath) => {
          unlinkAttempts += 1
          await rm(leasePath, { force: true })
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors[0] as unknown).toBe(writeFailure)
    expect(closeAttempts).toBe(1)
    expect(unlinkAttempts).toBe(0)
    expect(await readFile(target, 'utf8')).toBe(replacement)
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

    expect((await readFile(target, 'utf8')).split('\n')[2]).toBe(String(process.pid))
    await release()
  })

  it('does not parse a malformed pid prefix as a lock owner', async () => {
    const target = lockPath('malformed-owner')
    const contents = `${process.pid}corrupt\nnot-an-owner-token\n`
    writeFileSync(target, contents)
    let inspectedPid = false

    await expect(
      acquireManagedRuntimeLock({
        lockPath: target,
        timeoutMs: 0,
        isProcessAlive: () => {
          inspectedPid = true
          return false
        },
      }),
    ).rejects.toThrow('Timed out waiting for the managed DSH lock')

    expect(inspectedPid).toBe(false)
    expect(await readFile(target, 'utf8')).toBe(contents)
  })

  it('serializes a replacement owner against the verified stale-reclaim window', async () => {
    const target = lockPath('serialized-stale-reclaim')
    writeFileSync(target, '999999\n')
    let announceStaleObservation: () => void = () => undefined
    const staleObserved = new Promise<void>((resolve) => {
      announceStaleObservation = resolve
    })
    let continueReclaim: () => void = () => undefined
    const reclaimMayContinue = new Promise<void>((resolve) => {
      continueReclaim = resolve
    })
    let announceContenderWait: () => void = () => undefined
    const contenderWaitingOnGate = new Promise<void>((resolve) => {
      announceContenderWait = resolve
    })
    let signaledContenderWait = false

    const firstAcquisition = acquireManagedRuntimeLock({
      lockPath: target,
      timeoutMs: 3_000,
      pollIntervalMs: 1,
      isProcessAlive: () => false,
      afterStaleLeaseObserved: async () => {
        announceStaleObservation()
        await reclaimMayContinue
      },
    })
    let releaseFirst: (() => Promise<void>) | undefined
    let releaseSecond: (() => Promise<void>) | undefined
    let secondAcquisition: Promise<() => Promise<void>> | undefined
    try {
      await staleObserved

      // This is the old two-reader interleaving: a second shell tries to install
      // a new owner after the stale lease was verified but before it is removed.
      // It must wait for the gate, then see the first new owner and wait for its
      // release instead of being deleted by the stale reclaimer.
      secondAcquisition = acquireManagedRuntimeLock({
        lockPath: target,
        timeoutMs: 3_000,
        pollIntervalMs: 1,
        sleep: async (ms) => {
          if (!signaledContenderWait) {
            signaledContenderWait = true
            announceContenderWait()
          }
          await new Promise<void>((resolve) => setTimeout(resolve, ms))
        },
      })
      await contenderWaitingOnGate
      continueReclaim()

      releaseFirst = await firstAcquisition
      const firstOwner = await readFile(target, 'utf8')
      expect(firstOwner.split('\n')[2]).toBe(String(process.pid))
      await releaseFirst()
      releaseFirst = undefined

      releaseSecond = await secondAcquisition
      const secondOwner = await readFile(target, 'utf8')
      expect(secondOwner).not.toBe(firstOwner)
      expect(secondOwner.split('\n')[2]).toBe(String(process.pid))
      await releaseSecond()
      releaseSecond = undefined
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(`${target}.gate`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      continueReclaim()
      if (releaseFirst !== undefined) await releaseFirst()
      if (releaseSecond !== undefined) await releaseSecond()
      if (secondAcquisition !== undefined && releaseSecond === undefined) {
        try {
          releaseSecond = await secondAcquisition
          await releaseSecond()
        } catch {
          // Keep the test failure while ensuring any acquired lease is released.
        }
      }
      if (releaseFirst === undefined) {
        try {
          const cleanupFirst = await firstAcquisition
          await cleanupFirst()
        } catch {
          // Keep the test failure while ensuring any acquired lease is released.
        }
      }
    }
  })

  it('preserves the gate when its owner process crashes and fails closed', async () => {
    const target = lockPath('interrupted-gate')
    const gatePath = `${target}.gate`
    const staleLease = '999999\n'
    writeFileSync(target, staleLease)
    const childSource = `
      const { acquireManagedRuntimeLock } = await import(process.argv[1]);
      void acquireManagedRuntimeLock({
        lockPath: process.argv[2],
        isProcessAlive: () => false,
        afterStaleLeaseObserved: async () => {
          process.stdout.write('GATE_HELD\\n');
          await new Promise(() => process.stdin.once('data', () => process.exit(23)));
        },
      });
    `
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        childSource,
        new URL('./managed-lock.ts', import.meta.url).href,
        target,
      ],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const output = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })

    try {
      const ready = await new Promise<string>((resolve, reject) => {
        output.once('line', (line: string) => resolve(line))
        child.once('error', reject)
        child.once('exit', (code) => reject(new Error(`Gate child exited early (${code}): ${stderr}`)))
      })
      expect(ready).toBe('GATE_HELD')
      const interruptedGate = await readFile(gatePath, 'utf8')
      expect(interruptedGate.split('\n')[2]).toBe(String(child.pid))

      child.stdin.write('crash\n')
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code))
      })
      expect(exitCode).toBe(23)

      await expect(
        acquireManagedRuntimeLock({
          lockPath: target,
          timeoutMs: 0,
          isGateProcessAlive: () => false,
        }),
      ).rejects.toThrow(/lock gate.*stale and was preserved.*remove.*manually/iu)

      expect(await readFile(gatePath, 'utf8')).toBe(interruptedGate)
      expect(await readFile(target, 'utf8')).toBe(staleLease)
    } finally {
      output.close()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      }
    }
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

    expect((await readFile(target, 'utf8')).split('\n')[2]).toBe(String(process.pid))
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
