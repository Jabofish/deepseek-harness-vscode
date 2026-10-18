import { describe, expect, it, vi } from 'vitest'
import type { ConnectionRequest } from '@dsh-vscode/application'

vi.mock('vscode', () => ({ workspace: { isTrusted: true } }))
import { createConnectionLifecycle } from './connection-assembly.js'

describe('connection credential boundary', () => {
  it.each(['auto', 'new-isolated', 'custom'] as const)(
    'never exchanges an ordinary configuration token in %s mode',
    async (mode) => {
      const requests: ConnectionRequest[] = []
      const updates: Array<readonly [string, unknown]> = []
      const connect = createConnectionLifecycle({
        context: {
          workspaceState: {
            update: (key: string, value: unknown) => {
              updates.push([key, value])
              return Promise.resolve()
            },
          },
        } as never,
        configuration: {
          read: () => ({
            connection: {
              mode,
              serverUrl: 'https://dsh.example:443',
              runtimeVersion: '0.2.1-alpha.2',
              launchToken: 'must-not-be-used',
            },
            runtime: { autoStart: true },
          }),
        } as never,
        coordinator: {
          connect: (request: ConnectionRequest) => {
            requests.push(request)
            const endpoint =
              request.mode === 'custom'
                ? { host: 'dsh.example', port: 443, baseUrl: 'https://dsh.example:443' }
                : { host: '127.0.0.1', port: 4321, baseUrl: 'http://127.0.0.1:4321' }
            return Promise.resolve({ backend: { connection: { endpoint } }, state: {} })
          },
          disconnect: () => Promise.resolve(),
          getState: () => ({}),
        } as never,
        currentWorkspaceFolders: () => [],
        endpointLaunchUrls: new Map(),
        attach: () => Promise.resolve(),
        publishState: () => {},
        disposeAccountLifecycleHost: () => Promise.resolve(),
        detachSessionAdapters: () => {},
      }).connect
      await connect()
      expect(requests).toHaveLength(1)
      expect(requests[0]).not.toHaveProperty('launchToken')
      expect(updates).toEqual([
        ['dsh.lastEndpoint', mode !== 'new-isolated' ? undefined : { host: '127.0.0.1', port: 4321 }],
      ])
      if (mode !== 'new-isolated')
        expect(requests[0]).toMatchObject({ runtimeVersion: '0.2.1-alpha.2', credentialRevision: 0 })
    },
  )
})
