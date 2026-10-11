import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionRequest } from '@dsh-vscode/application'
import type { BackendEndpoint } from '@dsh-vscode/domain'

const trust = vi.hoisted(() => ({ isTrusted: true }))

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return trust.isTrusted
    },
  },
}))

import { createConnectionLifecycle } from './connection-assembly.js'

const projectFolder = { uri: { fsPath: '/project' }, name: 'project', index: 0 }

function buildLifecycle(config: Record<string, unknown>): {
  connect: () => Promise<unknown>
  requests: ConnectionRequest[]
  logins: Array<{ endpoint: BackendEndpoint; token: string }>
} {
  const requests: ConnectionRequest[] = []
  const logins: Array<{ endpoint: BackendEndpoint; token: string }> = []
  const backend = { connection: { endpoint: { port: 4_321 } } }
  const connect = createConnectionLifecycle({
    context: { workspaceState: { update: () => Promise.resolve() } } as never,
    configuration: {
      read: () => config as never,
    } as never,
    coordinator: {
      connect: (request: ConnectionRequest) => {
        requests.push(request)
        return Promise.resolve({ backend, state: {} } as never)
      },
      disconnect: () => Promise.resolve(),
      getState: () => ({}) as never,
    } as never,
    currentWorkspaceFolders: () => [projectFolder] as never,
    endpointLaunchUrls: new Map<string, string>(),
    loginWithToken: (endpoint: BackendEndpoint, token: string) => {
      logins.push({ endpoint, token })
      return Promise.resolve()
    },
    hasCookie: () => false,
    attach: () => Promise.resolve(),
    publishState: () => {},
    disposeAccountLifecycleHost: () => Promise.resolve(),
    detachSessionAdapters: () => {},
  }).connect
  return { connect, requests, logins }
}

describe('connection launch-token login', () => {
  beforeEach(() => {
    trust.isTrusted = true
  })

  it('exchanges a configured token for the attach port before connecting', async () => {
    const { connect, requests, logins } = buildLifecycle({
      connection: { mode: 'auto', launchToken: 'TOK', attachPorts: [3080] },
      runtime: { autoStart: true },
    })
    await connect()
    expect(logins).toEqual([
      { endpoint: { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' }, token: 'TOK' },
    ])
    expect(requests).toHaveLength(1)
  })

  it('exchanges the token for the custom endpoint when in custom mode', async () => {
    const { connect, logins } = buildLifecycle({
      connection: { mode: 'custom', serverUrl: 'http://127.0.0.1:3080', launchToken: 'TOK' },
      runtime: { autoStart: true },
    })
    await connect()
    expect(logins).toEqual([
      { endpoint: { host: '127.0.0.1', port: 3080, baseUrl: 'http://127.0.0.1:3080' }, token: 'TOK' },
    ])
  })

  it('does not attempt login when no token is configured', async () => {
    const { connect, logins } = buildLifecycle({
      connection: { mode: 'auto', attachPorts: [3080] },
      runtime: { autoStart: true },
    })
    await connect()
    expect(logins).toEqual([])
  })
})
