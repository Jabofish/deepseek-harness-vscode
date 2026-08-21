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
})
