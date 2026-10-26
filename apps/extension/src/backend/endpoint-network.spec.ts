/* Promise-shaped DNS fixtures complete synchronously. */
/* eslint-disable @typescript-eslint/require-await */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseServerOrigin, type BackendEndpoint } from '@dsh-vscode/domain'
import { EndpointNetwork, isDisallowedRemoteAddress } from './endpoint-network.js'

const endpoint = (url: string): BackendEndpoint => {
  const value = parseServerOrigin(url)
  if (value === undefined) throw new Error('Invalid fixture endpoint')
  return value
}
const remote = endpoint('https://dsh.example:443')
const networks: EndpointNetwork[] = []
const network = (options: ConstructorParameters<typeof EndpointNetwork>[0] = {}): EndpointNetwork => {
  const value = new EndpointNetwork(options)
  networks.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(networks.splice(0).map((value) => value.dispose()))
})

describe('endpoint network boundary', () => {
  it('verifies localhost resolution before automatic HTTP or WebSocket dialing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response())
    const rejected = network({ fetch, resolve: async () => [{ address: '10.0.0.8', family: 4 }] })
    await expect(rejected.fetch('http://localhost:3960/api')).rejects.toMatchObject({
      code: 'INVALID_ENDPOINT',
    })
    const Socket = rejected.webSocketConstructor()
    expect(() => new Socket('ws://localhost:3960/api')).toThrow()
    expect(fetch).not.toHaveBeenCalled()
    const resolve = vi.fn(async () => [
      { address: '127.0.0.1', family: 4 as const },
      { address: '::1', family: 6 as const },
    ])
    const allowed = network({ fetch, resolve })
    await allowed.fetch('http://localhost:3960/api')
    await allowed.fetch('http://localhost:3960/api')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]).toHaveProperty('dispatcher')
  })
  it.each([
    '127.0.0.1',
    '127.0.0.2',
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '224.1.1.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'ff02::1',
    'fd00:ec2::254',
  ])('rejects prohibited address %s', async (address) => {
    expect(isDisallowedRemoteAddress(address)).toBe(true)
    const value = network({ resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] })
    await expect(value.prepare(remote, false, new AbortController().signal)).rejects.toMatchObject({
      code: 'INVALID_ENDPOINT',
    })
  })

  it('denies unknown remote HTTP and WebSocket origins without touching transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const value = network({ fetch })
    await expect(value.fetch(`${remote.baseUrl}/api`)).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
    const Socket = value.webSocketConstructor()
    expect(() => new Socket('wss://dsh.example/api')).toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('requires a separate plaintext grant and detects address changes before sending credentials', async () => {
    let address = '10.0.0.8'
    const resolve = vi.fn(async () => [{ address, family: 4 as const }])
    const value = network({ resolve })
    const http = endpoint('http://dsh.example:3080')
    await expect(value.prepare(http, false, new AbortController().signal)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(resolve).not.toHaveBeenCalled()
    const pin = await value.prepare(http, true, new AbortController().signal)
    address = '10.0.0.9'
    await expect(value.prepare(http, true, new AbortController().signal, pin)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
  })
  it('pins resolution once and forces manual or error redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response())
    const resolve = vi.fn(async () => [{ address: '10.0.0.8', family: 4 as const }])
    const value = network({ fetch, resolve })
    await value.prepare(remote, false, new AbortController().signal)
    await value.fetch(`${remote.baseUrl}/api`, { redirect: 'follow' })
    await value.fetch(`${remote.baseUrl}/?token=fixture`, { redirect: 'manual' })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error')
    expect(fetch.mock.calls[0]?.[1]).toHaveProperty('dispatcher')
    expect(fetch.mock.calls[1]?.[1]?.redirect).toBe('manual')
    await value.release(remote)
    await expect(value.fetch(`${remote.baseUrl}/api`)).rejects.toMatchObject({ code: 'INVALID_ENDPOINT' })
  })

  it('blocks HTTP redirects on real sockets and closes live WebSockets on release', async () => {
    let leaked = 0
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/leak' })
        response.end()
      } else {
        leaked++
        response.end('unexpected redirect')
      }
    })
    const sockets = new WebSocketServer({ server })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Server fixture did not bind')
    const local = endpoint(`http://127.0.0.1:${address.port}`)
    const value = network()
    try {
      await value.prepare(local, false, new AbortController().signal)
      await expect(
        value.fetch(`${local.baseUrl}/redirect`, {
          headers: { Cookie: 'fixture-secret' },
          redirect: 'follow',
        }),
      ).rejects.toThrow()
      expect(leaked).toBe(0)
      const Socket = value.webSocketConstructor()
      const socket = new Socket(`ws://127.0.0.1:${address.port}/events`)
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve())
        socket.addEventListener('error', reject)
      })
      const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()))
      await value.release(local)
      await closed
      expect(socket.readyState).toBe(3)
    } finally {
      await value.dispose()
      sockets.close()
      server.close()
      await once(server, 'close')
    }
  })
})
