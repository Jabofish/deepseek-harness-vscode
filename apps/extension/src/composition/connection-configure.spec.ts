import { describe, expect, it, vi } from 'vitest'

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
  }
  return state
})

import { createConnectionLifecycle } from './connection-assembly.js'

describe('connection.configure reconnect', () => {
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
})
