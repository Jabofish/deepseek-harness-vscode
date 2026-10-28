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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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
  it('waits for tree termination before allowing another launch even after the parent exits', async () => {
    const tree = deferred<void>()
    const managed = child(() => undefined)
    const spawn = vi
      .fn()
      .mockReturnValueOnce({
        ...managed,
        terminateTree: async () => {
          managed.kill('SIGKILL')
          await tree.promise
        },
      })
      .mockImplementation(() => child(() => undefined))
    const supervisor = new DshProcessSupervisor({ managedPort: () => 4317, spawn })
    try {
      const handle = await supervisor.start(runtime())
      const stopping = handle.stop()
      await managed.exited
      const restarting = supervisor.start(runtime())
      await Promise.resolve()
      expect(spawn).toHaveBeenCalledTimes(1)
      tree.resolve()
      await stopping
      await restarting
      expect(spawn).toHaveBeenCalledTimes(2)
    } finally {
      tree.resolve()
      await supervisor.dispose()
    }
  })
  it('allows a cold runtime to become ready after the former 15-second deadline', async () => {
    vi.useFakeTimers()
    const kill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
    const managed = child(kill)
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => ({
        ...managed,
        stdout: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 33_000))
          yield 'dsh web: http://127.0.0.1:4317\n'
        })(),
      }),
    })
    try {
      const starting = supervisor.start(runtime())
      const accepted = expect(starting).resolves.toMatchObject({ pid: 42 })
      await vi.advanceTimersByTimeAsync(33_000)
      await accepted
      expect(kill).not.toHaveBeenCalled()
      await (await starting).stop()
      expect(kill).toHaveBeenCalledOnce()
    } finally {
      await supervisor.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['timeout', 'cancel'] as const)(
    'cleans up the owned child after a readiness %s',
    async (outcome) => {
      vi.useFakeTimers()
      const kill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
      const managed = child(kill)
      const never = deferred<string>()
      const supervisor = new DshProcessSupervisor({
        managedPort: () => 4317,
        spawn: () => ({
          ...managed,
          stdout: (async function* () {
            yield await never.promise
          })(),
        }),
      })
      try {
        const controller = new AbortController()
        const starting = supervisor.start(runtime(), controller.signal)
        const rejected = expect(starting).rejects.toMatchObject({
          code: outcome === 'cancel' ? 'REQUEST_CANCELLED' : 'BACKEND_UNREACHABLE',
        })
        await vi.advanceTimersByTimeAsync(33_000)
        expect(kill).not.toHaveBeenCalled()
        if (outcome === 'cancel') controller.abort()
        else await vi.advanceTimersByTimeAsync(27_000)
        await rejected
        expect(kill).toHaveBeenCalledOnce()
      } finally {
        never.resolve('')
        await supervisor.dispose()
        vi.useRealTimers()
      }
    },
  )

  it('launches the current runtime with the Web Profile flags and stops its owned process', async () => {
    const version = '0.2.1-rc.3'
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

    expect(args).toEqual(['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '4317'])
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
      expect.any(AbortSignal),
    )
    expect(handle).toEqual(
      expect.objectContaining({
        endpoint: { host: '127.0.0.1', port: 4317, baseUrl: 'http://127.0.0.1:4317' },
      }),
    )
    expect(handle).not.toHaveProperty('launchUrl')
    await handle.stop()
  })

  it('retries a failed stop before allowing a replacement process to start', async () => {
    const oldExited = deferred<{ readonly code: number | null; readonly signal: string | null }>()
    const retryStopStarted = deferred<void>()
    const stopFailure = new Error('transient termination failure')
    let killAttempts = 0
    let spawnCount = 0
    const first: SpawnedChild = {
      pid: 42,
      stdout: output('dsh web: http://127.0.0.1:4317\n'),
      stderr: output(''),
      kill: () => {
        killAttempts += 1
        if (killAttempts === 1) throw stopFailure
        retryStopStarted.resolve(undefined)
      },
      exited: oldExited.promise,
    }
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => (spawnCount++ === 0 ? first : { ...child(vi.fn()), pid: 43 }),
    })

    const handle = await supervisor.start(runtime())
    await expect(handle.stop()).rejects.toBe(stopFailure)
    const replacementPromise = supervisor.start(runtime())
    await retryStopStarted.promise

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(killAttempts).toBe(2)
    expect(spawnCount).toBe(1)

    oldExited.resolve({ code: null, signal: 'SIGTERM' })
    const replacement = await replacementPromise

    expect(spawnCount).toBe(2)
    await replacement.stop()
  })

  it('retains failed-start ownership when cleanup retries fail, then releases it on dispose', async () => {
    let resolveExited:
      ((status: { readonly code: number | null; readonly signal: string | null }) => void) | undefined
    const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
      (resolve) => {
        resolveExited = resolve
      },
    )
    let killAttempts = 0
    let allowKill = false
    let spawnCount = 0
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => {
        spawnCount += 1
        return {
          pid: 42,
          stdout: output('dsh web: http://127.0.0.1:4317\n'),
          stderr: output(''),
          kill: (signal) => {
            killAttempts += 1
            if (!allowKill) throw new Error('termination unavailable')
            resolveExited?.({ code: null, signal: signal ?? null })
          },
          exited,
        }
      },
      onReadyEndpoint: () => {
        throw new Error('login failed')
      },
    })

    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: true,
    })
    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: true,
    })
    expect(spawnCount).toBe(1)
    expect(killAttempts).toBe(2)

    allowKill = true
    await supervisor.dispose()
    await supervisor.dispose()

    expect(killAttempts).toBe(3)
    expect(spawnCount).toBe(1)
  })

  it('classifies a bind failure the runtime reports at the top of its startup diagnostics', async () => {
    // Upstream prints the failing bind error as one of the first lines of a
    // multi-kilobyte startup-failure report and ends that report with a
    // diagnostics-file pointer, so the end of stderr is stack frames plus the
    // log path and never contains the bind error. A classification that only
    // reads a fixed window from the end of the stream therefore reports a
    // generic unreachable runtime for what is a port conflict, and the
    // dedicated port-conflict card can never appear.
    const stack = Array.from(
      { length: 48 },
      (_, index) => `    at Object.<anonymous> (/dsh/packages/boot/app-boot/src/index.ts:${index + 1}:15)`,
    ).join('\n')
    const stderr = [
      'dsh: startup failed',
      'Error: listen EADDRINUSE: address already in use 127.0.0.1:3080',
      stack,
      'Full diagnostics: C:\\Users\\ada\\.dsh\\logs\\startup-2026-10-01T02-51-23-3f2a1b7c-9d4e-4f0a-8b1c-2e5f6a7b8c9d.log',
      '',
    ].join('\n')
    const exited = deferred<{ code: number | null; signal: string | null }>()
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 3080,
      spawn: () => ({
        pid: 9,
        stdout: output(''),
        // Resolve the exit only after the report has been handed to the
        // consumer, mirroring a runtime that writes its report and then exits.
        stderr: (async function* () {
          yield stderr
          await Promise.resolve()
          exited.resolve({ code: 1, signal: null })
        })(),
        kill: () => exited.resolve({ code: null, signal: 'SIGTERM' }),
        exited: exited.promise,
      }),
    })

    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'PORT_CONFLICT',
      retryable: true,
    })
  })

  it('does not spawn a waiting replacement after disposal begins', async () => {
    const firstExited = deferred<{ readonly code: number | null; readonly signal: string | null }>()
    const stopStarted = deferred<void>()
    let spawnCount = 0
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => {
        spawnCount += 1
        return spawnCount === 1
          ? {
              pid: 42,
              stdout: output('dsh web: http://127.0.0.1:4317\n'),
              stderr: output(''),
              kill: () => stopStarted.resolve(undefined),
              exited: firstExited.promise,
            }
          : { ...child(vi.fn()), pid: 43 }
      },
    })

    const handle = await supervisor.start(runtime())
    const stopping = handle.stop()
    await stopStarted.promise
    const replacement = supervisor.start(runtime())
    const disposing = supervisor.dispose()

    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: false,
    })
    firstExited.resolve({ code: null, signal: 'SIGTERM' })

    await expect(stopping).resolves.toBeUndefined()
    await expect(replacement).rejects.toMatchObject({ code: 'PROCESS_FAILED', retryable: false })
    await expect(disposing).resolves.toBeUndefined()

    expect(spawnCount).toBe(1)
    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: false,
    })
  })

  it('aborts a pending endpoint callback and stops its child when disposed', async () => {
    const readyCallbackStarted = deferred<void>()
    const kill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
    let callbackSignal: AbortSignal | undefined
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => child(kill),
      onReadyEndpoint: (_endpoint, _launchUrl, signal) => {
        callbackSignal = signal
        readyCallbackStarted.resolve(undefined)
        return new Promise<void>(() => undefined)
      },
    })

    const starting = supervisor.start(runtime())
    await readyCallbackStarted.promise
    await expect(supervisor.dispose()).resolves.toBeUndefined()

    await expect(starting).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(callbackSignal?.aborted).toBe(true)
    expect(kill).toHaveBeenCalledOnce()
    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: false,
    })
  })

  it('stops the managed child when startup is cancelled during endpoint initialization', async () => {
    const readyCallbackStarted = deferred<void>()
    const kill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
    const controller = new AbortController()
    let callbackSignal: AbortSignal | undefined
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => child(kill),
      onReadyEndpoint: (_endpoint, _launchUrl, signal) => {
        callbackSignal = signal
        readyCallbackStarted.resolve(undefined)
        return new Promise<void>(() => undefined)
      },
    })

    const starting = supervisor.start(runtime(), controller.signal)
    await readyCallbackStarted.promise
    controller.abort()

    await expect(starting).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await expect(supervisor.dispose()).resolves.toBeUndefined()
    expect(callbackSignal?.aborted).toBe(true)
    expect(kill).toHaveBeenCalledOnce()
  })

  it('times out an endpoint callback that never resolves and aborts it before stopping the child', async () => {
    vi.useFakeTimers()
    try {
      const readyCallbackStarted = deferred<void>()
      const kill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
      let callbackSignal: AbortSignal | undefined
      const supervisor = new DshProcessSupervisor({
        managedPort: () => 4317,
        spawn: () => child(kill),
        onReadyEndpoint: (_endpoint, _launchUrl, signal) => {
          callbackSignal = signal
          readyCallbackStarted.resolve(undefined)
          return new Promise<void>(() => undefined)
        },
      })
      const starting = supervisor.start(runtime())

      await readyCallbackStarted.promise
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(starting).rejects.toMatchObject({
        code: 'BACKEND_UNREACHABLE',
        message: 'Timed out completing managed DSH endpoint initialization.',
        retryable: true,
      })
      expect(callbackSignal?.aborted).toBe(true)
      expect(kill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not publish a handle when the endpoint callback resolves after disposal', async () => {
    const readyCallbackStarted = deferred<void>()
    const releaseCallback = deferred<void>()
    const callbackFinished = deferred<void>()
    const kill = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
    let callbackSignal: AbortSignal | undefined
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => child(kill),
      onReadyEndpoint: async (_endpoint, _launchUrl, signal) => {
        callbackSignal = signal
        readyCallbackStarted.resolve(undefined)
        await releaseCallback.promise
        callbackFinished.resolve(undefined)
      },
    })

    const starting = supervisor.start(runtime())
    await readyCallbackStarted.promise
    const disposing = supervisor.dispose()
    await expect(starting).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await expect(disposing).resolves.toBeUndefined()
    expect(callbackSignal?.aborted).toBe(true)
    expect(kill).toHaveBeenCalledOnce()

    releaseCallback.resolve(undefined)
    await callbackFinished.promise
    await supervisor.dispose()

    expect(kill).toHaveBeenCalledOnce()
    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: false,
    })
  })
})
