import { createServer } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_DSH_WEB_PORT } from '../../packages/dsh-adapter/src/launch-contract.js'

import {
  DEFAULT_DSH_WEB_PORT as guardDefaultPort,
  companionRegistryPorts,
  discoverExternalDshEndpoints,
  isLoopbackPortReachable,
} from './external-dsh-guard.ts'

describe('external DSH guard', () => {
  let home: string

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-guard-'))
  })
  afterAll(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('reads only usable companion records and treats a missing registry as quiet', async () => {
    expect(await companionRegistryPorts(path.join(home, 'absent'))).toEqual([])

    const directory = path.join(home, 'runtime', 'vscode', 'instances')
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, 'live.json'),
      JSON.stringify({ host: '127.0.0.1', port: 3961 }),
      'utf8',
    )
    await writeFile(
      path.join(directory, 'bogus-port.json'),
      JSON.stringify({ host: '127.0.0.1', port: 0 }),
      'utf8',
    )
    await writeFile(path.join(directory, 'not-json.json'), 'gateway says hello', 'utf8')
    await writeFile(path.join(directory, 'notes.txt'), 'ignored extension', 'utf8')

    expect(await companionRegistryPorts(home)).toEqual([3961])
  })

  it('separates a released port from one that is actually serving', async () => {
    const serving = await openLoopbackListener()
    const released = await releasedLoopbackPort()

    expect(await isLoopbackPortReachable(serving.port)).toBe(true)
    expect(await isLoopbackPortReachable(released)).toBe(false)
    await serving.close()
  })

  it('refuses auto only for endpoints that are actually serving', async () => {
    const serving = await openLoopbackListener()
    const released = await releasedLoopbackPort()
    // A home with no registry at all, so only the injected default port decides.
    const quietHome = path.join(home, 'no-such-home')

    expect(await discoverExternalDshEndpoints(quietHome, released)).toEqual([])
    expect(await discoverExternalDshEndpoints(quietHome, serving.port)).toEqual([
      { source: 'default-port', port: serving.port },
    ])

    // A companion record for a running instance is reported under its own
    // source, because the runner has to name what it found.
    const linkedHome = path.join(home, 'linked-home')
    const registry = path.join(linkedHome, 'runtime', 'vscode', 'instances')
    await mkdir(registry, { recursive: true })
    await writeFile(path.join(registry, 'other.json'), JSON.stringify({ port: serving.port }), 'utf8')
    expect(await discoverExternalDshEndpoints(linkedHome, released)).toEqual([
      { source: 'companion-registry', port: serving.port },
    ])

    await serving.close()
  })
})

describe('guard stays aligned with the adapter launch contract', () => {
  it('probes the default port the extension discovery offers', () => {
    // The runner loads this module under plain Node, so it restates the
    // constant instead of importing it; this is what keeps the copy honest.
    expect(guardDefaultPort).toBe(DEFAULT_DSH_WEB_PORT)
  })
})

interface LoopbackListener {
  readonly port: number
  readonly close: () => Promise<void>
}

function openLoopbackListener(): Promise<LoopbackListener> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ port, close: () => new Promise<void>((closed) => server.close(() => closed())) })
    })
  })
}

/**
 * Windows accepts a loopback connect on ports it never handed out but reserves
 * for Hyper-V, so an arbitrary neighbouring port cannot stand in for a quiet
 * one. Only a port this spec owned and gave back is a known-closed endpoint.
 */
async function releasedLoopbackPort(): Promise<number> {
  const listener = await openLoopbackListener()
  await listener.close()
  return listener.port
}
