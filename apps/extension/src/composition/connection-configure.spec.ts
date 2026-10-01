import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      update: async (key: string, value: unknown): Promise<void> => {
        if (key === 'connection.serverUrl') harness.configuration.connection.serverUrl = String(value)
        if (key === 'connection.mode') harness.configuration.connection.mode = value as 'auto' | 'custom'
        // VS Code fires the transport-change listener once per committed
        // write; the extension subscribes to it through
        // `reconnectOnTransportChange`.
        for (const listener of harness.transportListeners) await listener()
        await harness.afterWrite?.(key)
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}))

const harness = vi.hoisted(() => {
  const state = {
    configuration: {
      connection: { mode: 'auto' as 'auto' | 'custom', serverUrl: '' },
      runtime: { autoStart: false },
    },
    connects: [] as Array<{
      readonly mode: string
      readonly endpoint?: unknown
      readonly autoStart: boolean
    }>,
    transportListeners: [] as Array<(signal?: AbortSignal) => Promise<unknown>>,
    afterWrite: undefined as ((key: string) => Promise<void>) | undefined,
  }
  return state
})

import { createConnectionLifecycle } from './connection-assembly.js'

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function lifecycle(
  connect: (request: {
    readonly mode: string
    readonly endpoint?: unknown
    readonly autoStart: boolean
  }) => Promise<unknown> = vi.fn().mockResolvedValue({
    backend: { connection: { endpoint: { port: 3080 } } },
    state: { kind: 'connected' },
  }),
): ReturnType<typeof createConnectionLifecycle> {
  const result = createConnectionLifecycle({
    context: { workspaceState: { update: () => Promise.resolve(undefined) } },
    configuration: { read: () => harness.configuration },
    coordinator: {
      connect: (request: {
        readonly mode: string
        readonly endpoint?: unknown
        readonly autoStart: boolean
      }) => {
        harness.connects.push(request)
        return connect(request)
      },
      disconnect: () => Promise.resolve(),
    },
    currentWorkspaceFolders: () => [],
    endpointLaunchUrls: new Map(),
    attach: () => Promise.resolve(),
    publishState: () => undefined,
    disposeAccountLifecycleHost: () => Promise.resolve(),
    detachSessionAdapters: () => undefined,
  } as never)
  harness.transportListeners.push(result.reconnectOnTransportChange)
  return result
}

describe('connection.configure reconnect', () => {
  beforeEach(() => {
    harness.connects.length = 0
    harness.transportListeners.length = 0
    harness.configuration.connection.mode = 'auto'
    harness.configuration.connection.serverUrl = ''
    harness.afterWrite = undefined
  })

  it('does not adopt a reconnect that already read the old settings', async () => {
    const started = deferred<void>()
    const admitted = deferred<unknown>()
    const connect = vi
      .fn()
      .mockImplementationOnce(() => {
        started.resolve()
        return admitted.promise
      })
      .mockResolvedValue({
        backend: { connection: { endpoint: { port: 3080 } } },
        state: { kind: 'connected' },
      })
    const subject = lifecycle(connect)
    const previous = subject.reconnect()
    await started.promise
    const configured = subject.configureConnection('custom', 'http://127.0.0.1:3080')
    await vi.waitFor(() => expect(harness.configuration.connection.mode).toBe('custom'))
    admitted.resolve({ backend: { connection: { endpoint: { port: 3080 } } }, state: { kind: 'connected' } })
    await Promise.all([previous, configured])
    expect(harness.connects.map((request) => request.mode)).toEqual(['auto', 'custom'])
  })

  it('serializes overlapping settings submissions without publishing a mixed pair', async () => {
    const firstWrite = deferred<void>()
    const release = deferred<void>()
    harness.afterWrite = async (key) => {
      if (key !== 'connection.serverUrl') return
      harness.afterWrite = undefined
      firstWrite.resolve()
      await release.promise
    }
    const subject = lifecycle()
    const custom = subject.configureConnection('custom', 'http://127.0.0.1:3080')
    await firstWrite.promise
    const auto = subject.configureConnection('auto', undefined)
    release.resolve()
    await Promise.all([custom, auto])
    expect(harness.connects.map((request) => request.mode)).toEqual(['custom', 'auto'])
    expect(harness.configuration.connection).toEqual({ mode: 'auto', serverUrl: '' })
  })

  it('reconnects once, on the fully committed configuration', async () => {
    // configureConnection writes its settings in several awaited steps, and
    // VS Code delivers a configuration-change event for every committed
    // write. Each of those events used to start (or adopt) a reconnect that
    // read the partially updated configuration: switching to a custom
    // endpoint could reconnect under the old auto mode, and the coalescer
    // then swallowed the explicit reconnect, leaving the connection on the
    // pre-update settings with nothing to correct it.
    harness.connects.length = 0
    harness.transportListeners.length = 0
    harness.configuration.connection.mode = 'auto'
    harness.configuration.connection.serverUrl = ''
    const lifecycle = createConnectionLifecycle({
      context: { workspaceState: { update: () => Promise.resolve(undefined) } },
      configuration: { read: () => harness.configuration },
      coordinator: {
        connect: (request: {
          readonly mode: string
          readonly endpoint?: unknown
          readonly autoStart: boolean
        }) => {
          harness.connects.push(request)
          return Promise.resolve({
            backend: { connection: { endpoint: { port: 3080 } } },
            state: { kind: 'connected' },
          })
        },
        disconnect: () => Promise.resolve(),
      },
      currentWorkspaceFolders: () => [],
      endpointLaunchUrls: new Map<string, string>(),
      attach: () => Promise.resolve(undefined),
      publishState: () => undefined,
      disposeAccountLifecycleHost: () => Promise.resolve(undefined),
      detachSessionAdapters: () => undefined,
    } as never)
    harness.transportListeners.push((signal) => lifecycle.reconnectOnTransportChange(signal))

    await lifecycle.configureConnection('custom', 'http://127.0.0.1:3080')

    expect(harness.connects).toEqual([
      {
        mode: 'custom',
        endpoint: { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' },
        autoStart: false,
      },
    ])
  })

  it('releases the settings queue and listener suppression after a failed write', async () => {
    harness.afterWrite = () => {
      harness.afterWrite = undefined
      return Promise.reject(new Error('Settings write failed'))
    }
    const subject = lifecycle()
    await expect(subject.configureConnection('custom', 'http://127.0.0.1:3080')).rejects.toThrow(
      'Settings write failed',
    )
    await subject.configureConnection('auto', undefined)
    await subject.reconnectOnTransportChange()
    expect(harness.connects.map((request) => request.mode)).toEqual(['auto', 'auto'])
  })

  it('does not write settings for an already-cancelled submission', async () => {
    const signal = AbortSignal.abort(new Error('Cancelled'))
    const subject = lifecycle()
    await expect(subject.configureConnection('custom', 'http://127.0.0.1:3080', signal)).rejects.toThrow(
      'Cancelled',
    )
    expect(harness.configuration.connection).toEqual({ mode: 'auto', serverUrl: '' })
    expect(harness.connects).toEqual([])
  })
})
