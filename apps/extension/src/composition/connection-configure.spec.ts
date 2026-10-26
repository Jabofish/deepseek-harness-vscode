import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'

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
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  Uri: { joinPath: () => ({ fsPath: '/fixture/resources' }) },
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
vi.mock('../editor/editor-integration-settings.js', () => ({
  readEditorPreferences: () => ({ enabled: true, autoSetup: true, allowEdits: true }),
}))

import { createConnectionLifecycle } from './connection-assembly.js'

function lifecycle(
  connect: (
    request: {
      readonly mode: string
      readonly endpoint?: unknown
      readonly autoStart: boolean
    },
    signal?: AbortSignal,
  ) => Promise<unknown> = vi.fn().mockResolvedValue({
    backend: { connection: { endpoint: { port: 3080 } } },
    state: { kind: 'connected' },
  }),
  extensionMode = vscode.ExtensionMode.Production,
  withResources = false,
): ReturnType<typeof createConnectionLifecycle> {
  const result = createConnectionLifecycle({
    context: {
      extensionMode,
      ...(withResources ? { extensionUri: { fsPath: '/fixture' } } : {}),
      workspaceState: { update: () => Promise.resolve(undefined) },
    },
    configuration: { read: () => harness.configuration },
    coordinator: {
      connect: (
        request: {
          readonly mode: string
          readonly endpoint?: unknown
          readonly autoStart: boolean
        },
        signal?: AbortSignal,
      ) => {
        harness.connects.push(request)
        return connect(request, signal)
      },
      disconnect: () => Promise.resolve(),
    },
    currentWorkspaceFolders: () => [],
    endpointLaunchUrls: new Map(),
    loginWithToken: () => Promise.resolve(),
    hasCookie: () => false,
    attach: () => Promise.resolve(),
    publishState: () => undefined,
    disposeAccountLifecycleHost: () => Promise.resolve(),
    detachSessionAdapters: () => undefined,
  } as never)
  harness.transportListeners.push(result.reconnectOnTransportChange)
  return result
}

describe('connection.configure reconnect', () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    harness.connects.length = 0
    harness.transportListeners.length = 0
    harness.configuration.connection.mode = 'auto'
    harness.configuration.connection.serverUrl = ''
    harness.afterWrite = undefined
    harness.configuration.runtime.autoStart = false
  })

  it('uses a fresh owned runtime for F5 without changing or attaching to the configured external server', async () => {
    vi.stubEnv('DSH_VSCODE_DEV_MANAGED_RUNTIME', '1')
    harness.configuration.connection.mode = 'custom'
    harness.configuration.connection.serverUrl = 'http://127.0.0.1:3080'
    const development = lifecycle(undefined, vscode.ExtensionMode.Development)
    await development.connect()
    expect(harness.connects.at(-1)).toMatchObject({ mode: 'new-isolated', autoStart: true })
    expect(harness.connects.at(-1)?.endpoint).toBeUndefined()
    expect(harness.configuration.connection).toEqual({ mode: 'custom', serverUrl: 'http://127.0.0.1:3080' })
    const production = lifecycle()
    await production.connect()
    expect(harness.connects.at(-1)).toMatchObject({ mode: 'custom', endpoint: { port: 3080 } })
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
      loginWithToken: () => Promise.resolve(),
      hasCookie: () => false,
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
        credentialRevision: 0,
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
