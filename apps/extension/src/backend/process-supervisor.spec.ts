import { describe, expect, it, vi } from 'vitest'

import type { DshRuntime } from '@dsh-vscode/domain'
import { managedWebArguments } from '@dsh-vscode/dsh-adapter'

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
  it.each([
    '0.1.0-rc.6',
    '0.1.0-rc.7',
    '0.1.0-rc.8',
    '0.1.1-rc.1',
    '0.1.1-rc.2',
    '0.1.2-rc.1',
    '0.1.2-alpha.1',
    '0.1.2-alpha.2',
    '0.1.2-alpha.3',
    '0.1.2-alpha.4',
    '0.1.2-alpha.5',
    '0.1.3-alpha.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1',
    '0.1.0-rc.99',
  ])('uses only the shared Web Profile flags for %s', async (version) => {
    let args: readonly string[] | undefined
    const kill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: (_executable, receivedArgs) => {
        args = receivedArgs
        return child(kill)
      },
    })

    const handle = await supervisor.start({ ...runtime(), version })

    expect(args).toEqual(managedWebArguments(version, 4317))
    expect(args?.includes('--no-open')).toBe(
      [
        '0.1.0-rc.8',
        '0.1.1-rc.1',
        '0.1.1-rc.2',
        '0.1.2-rc.1',
        '0.1.2-alpha.1',
        '0.1.2-alpha.2',
        '0.1.2-alpha.3',
        '0.1.2-alpha.4',
        '0.1.2-alpha.5',
        '0.1.3-alpha.1',
        '0.1.3-alpha.2',
        '0.1.5-alpha.1',
      ].includes(version),
    )
    await expect(handle.stop()).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('hands the managed launch token to the Extension Host login seam without exposing it on the handle', async () => {
    const onReadyEndpoint = vi.fn()
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => ({
        ...child(vi.fn()),
        stdout: output('dsh web: http://127.0.0.1:4317/?token=launch-secret\n'),
      }),
      onReadyEndpoint,
    })

    const handle = await supervisor.start(runtime())

    expect(onReadyEndpoint).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 4317, baseUrl: 'http://127.0.0.1:4317' },
      'http://127.0.0.1:4317/?token=launch-secret',
    )
    expect(handle).toEqual(
      expect.objectContaining({
        endpoint: { host: '127.0.0.1', port: 4317, baseUrl: 'http://127.0.0.1:4317' },
      }),
    )
    expect(handle).not.toHaveProperty('launchUrl')
    await handle.stop()
  })

  it.each([
    '0.1.2-alpha.1',
    '0.1.2-alpha.2',
    '0.1.2-alpha.3',
    '0.1.2-alpha.4',
    '0.1.2-alpha.5',
    '0.1.3-alpha.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1',
  ])('translates the alpha user-facing ptc mode to DSH_TOOLS_MODE for %s', async (version) => {
    let environment: NodeJS.ProcessEnv | undefined
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      toolMode: () => 'ptc',
      spawn: (_executable, _args, _cwd, receivedEnvironment) => {
        environment = receivedEnvironment
        return child(vi.fn())
      },
    })

    const handle = await supervisor.start({ ...runtime(), version })

    expect(environment).toMatchObject({ DSH_TOOLS_MODE: 'ptc' })
    await handle.stop()
  })

  it('keeps the legacy code wire value for published runtimes', async () => {
    let environment: NodeJS.ProcessEnv | undefined
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      toolMode: () => 'ptc',
      spawn: (_executable, _args, _cwd, receivedEnvironment) => {
        environment = receivedEnvironment
        return child(vi.fn())
      },
    })

    const handle = await supervisor.start(runtime())

    expect(environment).toMatchObject({ DSH_TOOLS_MODE: 'code' })
    await handle.stop()
  })

  it('does not guess the alpha tool mode for an unknown future runtime', async () => {
    let environment: NodeJS.ProcessEnv | undefined
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      toolMode: () => 'ptc',
      spawn: (_executable, _args, _cwd, receivedEnvironment) => {
        environment = receivedEnvironment
        return child(vi.fn())
      },
    })

    const handle = await supervisor.start({ ...runtime(), version: '0.1.2-alpha.6' })

    expect(environment).toMatchObject({ DSH_TOOLS_MODE: 'code' })
    await handle.stop()
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
