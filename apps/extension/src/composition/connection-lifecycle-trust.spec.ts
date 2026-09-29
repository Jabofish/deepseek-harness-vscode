import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionRequest } from '@dsh-vscode/application'

const trust = vi.hoisted(() => ({ isTrusted: true }))

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return trust.isTrusted
    },
  },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
}))

import { createConnectionLifecycle } from './connection-assembly.js'

const projectFolder = { uri: { fsPath: '/project' }, name: 'project', index: 0 }

function buildLifecycle(
  requests: ConnectionRequest[],
  folders: readonly unknown[],
  autoStart: boolean,
): { connect: () => Promise<unknown> } {
  const backend = { connection: { endpoint: { port: 4_321 } } }
  return createConnectionLifecycle({
    context: { workspaceState: { update: () => Promise.resolve() } } as never,
    configuration: {
      read: () => ({ connection: { mode: 'auto' }, runtime: { autoStart } }) as never,
    } as never,
    coordinator: {
      connect: (request: ConnectionRequest) => {
        requests.push(request)
        return Promise.resolve({ backend, state: {} } as never)
      },
      disconnect: () => Promise.resolve(),
      getState: () => ({}) as never,
    } as never,
    currentWorkspaceFolders: () => folders as never,
    endpointLaunchUrls: new Map<string, string>(),
    attach: () => Promise.resolve(),
    publishState: () => {},
    disposeAccountLifecycleHost: () => Promise.resolve(),
    detachSessionAdapters: () => {},
  })
}

describe('connection lifecycle workspace trust gate', () => {
  let requests: ConnectionRequest[]

  beforeEach(() => {
    requests = []
    trust.isTrusted = true
  })

  it('keeps auto start enabled for an untrusted empty window', async () => {
    trust.isTrusted = false
    await buildLifecycle(requests, [], true).connect()
    expect(requests[0]?.autoStart).toBe(true)
  })

  it('drops auto start for an untrusted project folder even when the setting asks for it', async () => {
    trust.isTrusted = false
    await buildLifecycle(requests, [projectFolder], true).connect()
    expect(requests[0]?.autoStart).toBe(false)
  })

  it('keeps auto start for a trusted folder', async () => {
    await buildLifecycle(requests, [projectFolder], true).connect()
    expect(requests[0]?.autoStart).toBe(true)
  })

  it('never re-enables an auto start the user turned off', async () => {
    await buildLifecycle(requests, [], false).connect()
    expect(requests[0]?.autoStart).toBe(false)
  })

  it('still issues the connect request so an untrusted window can attach to a running host', async () => {
    trust.isTrusted = false
    const connected = (await buildLifecycle(requests, [projectFolder], true).connect()) as {
      connected: boolean
    }
    expect(connected.connected).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.mode).toBe('auto')
  })
})
