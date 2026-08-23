import { describe, expect, it, vi } from 'vitest'

import type { DshRuntime } from '@dsh-vscode/domain'

import { DshProcessSupervisor, type SpawnedChild } from './process-supervisor.js'

function runtime(): DshRuntime {
  return {
    executable: 'dsh',
    version: '0.1.0-rc.8',
    supported: true,
    compatibility: 'known',
    source: 'path',
  }
}

async function* output(value: string): AsyncIterable<string> {
  await Promise.resolve()
  yield value
}

function child(onKill: (signal: NodeJS.Signals | undefined) => void): SpawnedChild {
  let resolveExited:
    ((status: { readonly code: number | null; readonly signal: string | null }) => void) | undefined
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
    resolveExited = resolve
  })
  return {
    pid: 42,
    stdout: output('dsh web: http://127.0.0.1:4317\n'),
    stderr: output(''),
    kill: (signal) => {
      onKill(signal)
      resolveExited?.({ code: null, signal: signal ?? null })
    },
    exited,
  }
}

describe('DshProcessSupervisor', () => {
  it('starts the managed Web Host without opening the system browser', async () => {
    let args: readonly string[] | undefined
    const kill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: (_executable, receivedArgs) => {
        args = receivedArgs
        return child(kill)
      },
    })

    const handle = await supervisor.start(runtime())

    expect(args).toEqual(['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '4317'])
    await expect(handle.stop()).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('releases the active handle when stop starts so a new process can start', async () => {
    let releaseExit: (() => void) | undefined
    const firstExited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
      (resolve) => {
        releaseExit = () => resolve({ code: null, signal: 'SIGTERM' })
      },
    )
    const firstKill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
    const first: SpawnedChild = {
      pid: 42,
      stdout: output('dsh web: http://127.0.0.1:4317\n'),
      stderr: output(''),
      kill: firstKill,
      exited: firstExited,
    }
    const second = { ...child(vi.fn()), pid: 43 }
    let spawnCount = 0
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => (spawnCount++ === 0 ? first : second),
    })

    const handle = await supervisor.start(runtime())
    const stopping = handle.stop()
    await vi.waitFor(() => expect(firstKill).toHaveBeenCalledWith('SIGTERM'))

    const replacement = await supervisor.start(runtime())

    expect(replacement).not.toBe(handle)
    expect(spawnCount).toBe(2)
    releaseExit?.()
    await expect(stopping).resolves.toBeUndefined()
  })

  it('resets the stop guard after a termination error so the handle can be retried', async () => {
    let attempts = 0
    let resolveExited:
      ((status: { readonly code: number | null; readonly signal: string | null }) => void) | undefined
    const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
      (resolve) => {
        resolveExited = resolve
      },
    )
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => ({
        pid: 42,
        stdout: output('dsh web: http://127.0.0.1:4317\n'),
        stderr: output(''),
        kill: (signal) => {
          attempts += 1
          if (attempts === 1) throw new Error('transient termination failure')
          resolveExited?.({ code: null, signal: signal ?? null })
        },
        exited,
      }),
    })

    const handle = await supervisor.start(runtime())

    await expect(handle.stop()).rejects.toThrow('transient termination failure')
    await expect(handle.stop()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })
})
