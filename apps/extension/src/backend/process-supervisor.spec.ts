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
  it.each([
    '0.0.1-rc.1',
    '0.0.1-rc.2',
    '0.0.1-rc.5',
    '0.1.0-rc.2',
    '0.1.0-rc.3',
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
    '0.1.5-alpha.2',
    '0.1.5-rc.1',
    '0.1.5-rc.2',
    '0.1.5-rc.3',
    '0.1.7-alpha.1',
    '0.1.7-alpha.2',
    '0.1.7-rc.1',
    '0.1.7-rc.2',
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
        '0.1.5-alpha.2',
        '0.1.5-rc.1',
        '0.1.5-rc.2',
        '0.1.5-rc.3',
        '0.1.7-alpha.1',
        '0.1.7-alpha.2',
        '0.1.7-rc.1',
        '0.1.7-rc.2',
      ].includes(version),
    )
    await expect(handle.stop()).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('clears the termination timeout when the managed child exits', async () => {
    vi.useFakeTimers()
    try {
      const supervisor = new DshProcessSupervisor({
        managedPort: () => 4317,
        spawn: () => child(vi.fn()),
      })

      const handle = await supervisor.start(runtime())
      await handle.stop()

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
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

  it.each([
    '0.1.2-alpha.1',
    '0.1.2-alpha.2',
    '0.1.2-alpha.3',
    '0.1.2-alpha.4',
    '0.1.2-alpha.5',
    '0.1.3-alpha.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1',
    '0.1.5-alpha.2',
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

  it('waits for an in-flight stop before spawning a replacement process', async () => {
    const firstExited = deferred<{ readonly code: number | null; readonly signal: string | null }>()
    const stopStarted = deferred<void>()
    const firstKill = vi.fn<(signal: NodeJS.Signals | undefined) => void>(() => {
      stopStarted.resolve(undefined)
    })
    const first: SpawnedChild = {
      pid: 42,
      stdout: output('dsh web: http://127.0.0.1:4317\n'),
      stderr: output(''),
      kill: firstKill,
      exited: firstExited.promise,
    }
    const second = { ...child(vi.fn()), pid: 43 }
    let spawnCount = 0
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => (spawnCount++ === 0 ? first : second),
    })

    const handle = await supervisor.start(runtime())
    const stopping = handle.stop()
    await stopStarted.promise
    const replacementPromise = supervisor.start(runtime())
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(firstKill).toHaveBeenCalledWith('SIGTERM')
    expect(spawnCount).toBe(1)

    firstExited.resolve({ code: null, signal: 'SIGTERM' })
    await expect(stopping).resolves.toBeUndefined()
    const replacement = await replacementPromise

    expect(replacement).not.toBe(handle)
    expect(spawnCount).toBe(2)
    await replacement.stop()
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

  it('shares concurrent stop and dispose failures and can retry cleanup', async () => {
    const stopFailure = new Error('transient termination failure')
    let resolveExited:
      ((status: { readonly code: number | null; readonly signal: string | null }) => void) | undefined
    const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
      (resolve) => {
        resolveExited = resolve
      },
    )
    let attempts = 0
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => ({
        pid: 42,
        stdout: output('dsh web: http://127.0.0.1:4317\n'),
        stderr: output(''),
        kill: (signal) => {
          attempts += 1
          if (attempts === 1) throw stopFailure
          resolveExited?.({ code: null, signal: signal ?? null })
        },
        exited,
      }),
    })

    const handle = await supervisor.start(runtime())
    const stopping = handle.stop()
    const disposing = supervisor.dispose()
    expect(supervisor.dispose()).toBe(disposing)

    await expect(stopping).rejects.toBe(stopFailure)
    await expect(disposing).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: true,
      cause: stopFailure,
    })
    expect(attempts).toBe(1)

    await supervisor.dispose()

    expect(attempts).toBe(2)
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

  it('retries a coordinator stop failure during supervisor disposal', async () => {
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

    await supervisor.dispose()
    await supervisor.dispose()

    expect(attempts).toBe(2)
  })

  it('retries failed-start cleanup before launching a replacement process', async () => {
    let resolveExited:
      ((status: { readonly code: number | null; readonly signal: string | null }) => void) | undefined
    const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
      (resolve) => {
        resolveExited = resolve
      },
    )
    let killAttempts = 0
    let readyAttempts = 0
    let spawnCount = 0
    const firstKill = vi.fn<(signal: NodeJS.Signals | undefined) => void>((signal) => {
      killAttempts += 1
      if (killAttempts === 1) throw new Error('transient startup cleanup failure')
      resolveExited?.({ code: null, signal: signal ?? null })
    })
    const first: SpawnedChild = {
      pid: 42,
      stdout: output('dsh web: http://127.0.0.1:4317\n'),
      stderr: output(''),
      kill: firstKill,
      exited,
    }
    const second = { ...child(vi.fn()), pid: 43 }
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => (spawnCount++ === 0 ? first : second),
      onReadyEndpoint: () => {
        readyAttempts += 1
        if (readyAttempts === 1) throw new Error('login failed')
      },
    })

    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'PROCESS_FAILED',
      retryable: true,
    })
    expect(spawnCount).toBe(1)

    const handle = await supervisor.start(runtime())

    expect(spawnCount).toBe(2)
    expect(firstKill).toHaveBeenCalledTimes(2)
    await handle.stop()
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

  it('honors cancellation after retrying failed-start cleanup and before spawning again', async () => {
    let resolveExited:
      ((status: { readonly code: number | null; readonly signal: string | null }) => void) | undefined
    const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
      (resolve) => {
        resolveExited = resolve
      },
    )
    let killAttempts = 0
    let spawnCount = 0
    const firstKill = vi.fn<(signal: NodeJS.Signals | undefined) => void>((signal) => {
      killAttempts += 1
      if (killAttempts === 1) throw new Error('transient startup cleanup failure')
      if (killAttempts > 2) resolveExited?.({ code: null, signal: signal ?? null })
    })
    const first: SpawnedChild = {
      pid: 42,
      stdout: output('dsh web: http://127.0.0.1:4317\n'),
      stderr: output(''),
      kill: firstKill,
      exited,
    }
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => {
        spawnCount += 1
        return first
      },
      onReadyEndpoint: () => {
        throw new Error('login failed')
      },
    })
    await expect(supervisor.start(runtime())).rejects.toMatchObject({ code: 'PROCESS_FAILED' })

    const controller = new AbortController()
    const retry = supervisor.start(runtime(), controller.signal)
    await vi.waitFor(() => expect(firstKill).toHaveBeenCalledTimes(2))
    controller.abort()
    resolveExited?.({ code: null, signal: 'SIGTERM' })

    await expect(retry).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(spawnCount).toBe(1)
  })

  it('reports a launch that never produced a process instead of a readiness timeout', async () => {
    // A failed `spawn` still yields a child object: Node leaves `pid` unset and
    // reports the reason on an `error` event, so nothing is ever written to the
    // readiness buffers. Blaming the runtime for a launch that never happened
    // costs a full timeout and hides the actionable cause from the user.
    const kills = vi.fn<(signal: NodeJS.Signals | undefined) => void>()
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => ({
        pid: -1,
        stdout: output(''),
        stderr: output(''),
        kill: kills,
        exited: new Promise<never>(() => undefined),
      }),
    })

    const started = Date.now()
    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      message: 'The DSH process could not be started.',
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 20_000)

  it('reports a synchronous spawn failure as an unreachable runtime', async () => {
    // `shell: false` cannot launch a `.cmd`/`.bat` target: Node throws EINVAL
    // before any child exists, and that raw errno must not reach the caller as
    // an unmapped error.
    const supervisor = new DshProcessSupervisor({
      managedPort: () => 4317,
      spawn: () => {
        throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
      },
    })

    await expect(supervisor.start(runtime())).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      message: 'The DSH process could not be started.',
      retryable: true,
    })
  })
})
