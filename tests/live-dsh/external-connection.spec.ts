import { createServer, request as requestHttp } from 'node:http'
import { once } from 'node:events'
import { networkInterfaces } from 'node:os'
import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { parseServerOrigin } from '../../packages/domain/src/server-origin.js'
import { EndpointNetwork } from '../../apps/extension/src/backend/endpoint-network.js'
import { ExternalConnectionAccess } from '../../apps/extension/src/backend/external-connection-access.js'
import { createAdapterOptions } from '../../apps/extension/src/backend/adapter-options.js'
import { createVersionAdapters } from '../../apps/extension/src/backend/version-adapters.js'
import { VersionedBackendProbe } from '../../packages/dsh-adapter/src/probe.js'
import { VersionedBackendFactory } from '../../packages/dsh-adapter/src/backend-factory.js'
import { canConnect, freeLoopbackPort, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) =>
      entry !== undefined &&
      entry.family === 'IPv4' &&
      !entry.internal &&
      /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(entry.address),
  )?.address

describe.skipIf(
  process.env.DSH_LIVE_SMOKE !== '1' ||
    process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.1-alpha.2' ||
    lanAddress === undefined,
)('live external HTTP connection', () => {
  it(
    'authenticates and reconnects over a LAN proxy using production transports without local process identity',
    async () => {
      const proxyPort = await freeLoopbackPort()
      const runtime = await startManagedRuntime({ trustedHost: `dsh-fixture.test:${proxyPort}` })
      const sockets = new Set<Socket>()
      let logins = 0
      const responses: Array<{ path: string; status: number; authenticated: boolean }> = []
      const proxy = createServer((incoming, outgoing) => {
        if (incoming.url?.startsWith('/?token=')) logins++
        const upstream = requestHttp(
          `http://127.0.0.1:${runtime.snapshot.port}${incoming.url ?? '/'}`,
          { method: incoming.method, headers: incoming.headers },
          (response) => {
            responses.push({
              path: incoming.url?.split('?')[0] ?? '/',
              status: response.statusCode ?? 502,
              authenticated: incoming.headers.cookie !== undefined,
            })
            outgoing.writeHead(response.statusCode ?? 502, response.headers)
            response.pipe(outgoing)
          },
        )
        upstream.on('error', () => {
          outgoing.writeHead(502)
          outgoing.end()
        })
        incoming.pipe(upstream)
      })
      proxy.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      proxy.on('upgrade', (incoming, client, head) => {
        const upstream = requestHttp(`http://127.0.0.1:${runtime.snapshot.port}${incoming.url ?? '/'}`, {
          headers: incoming.headers,
        })
        upstream.on('upgrade', (response, peer, peerHead) => {
          sockets.add(peer)
          peer.once('close', () => sockets.delete(peer))
          client.write(
            `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
              .map(([name, value]) => `${name}: ${String(value)}\r\n`)
              .join('')}\r\n`,
          )
          if (head.length > 0) peer.write(head)
          if (peerHead.length > 0) client.write(peerHead)
          client.pipe(peer).pipe(client)
          client.on('error', () => peer.destroy())
          peer.on('error', () => client.destroy())
          client.once('close', () => peer.destroy())
          peer.once('close', () => client.destroy())
        })
        upstream.on('response', (response) => {
          response.resume()
          client.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`)
        })
        upstream.on('error', () => client.destroy())
        upstream.end()
      })
      proxy.listen(proxyPort, lanAddress)
      await once(proxy, 'listening')
      const address = proxy.address()
      if (address === null || typeof address === 'string') throw new Error('LAN fixture did not bind')
      const endpoint = parseServerOrigin(`http://dsh-fixture.test:${address.port}`)
      if (endpoint === undefined || runtime.launchUrl === undefined)
        throw new Error('Live fixture has no endpoint or owned launch credential')
      const token = new URL(runtime.launchUrl).searchParams.get('token')
      if (token === null) throw new Error('Live fixture has no owned launch token')
      const values = new Map<string, string>()
      const network = new EndpointNetwork({
        resolve: () => Promise.resolve([{ address: lanAddress!, family: 4 }]),
      })
      const access = new ExternalConnectionAccess({
        credentialScope: () => Promise.resolve('isolated-live-host'),
        secrets: {
          get: (name) => Promise.resolve(values.get(name)),
          store: (name, value) => {
            values.set(name, value)
            return Promise.resolve()
          },
          delete: (name) => {
            values.delete(name)
            return Promise.resolve()
          },
        },
        network,
        isTrusted: () => true,
        requestTimeoutMs: () => 15_000,
        confirm: (_endpoint, insecure) => Promise.resolve(insecure),
        inputToken: () => Promise.resolve(token),
      })
      const adapters = createVersionAdapters(
        createAdapterOptions({
          requestTimeoutMs: () => 15_000,
          fetch: network.fetch,
          webSocket: network.webSocketConstructor(),
          authCookie: (origin) => access.cookie(origin),
          samePath: (left, right) => left === right,
          exportFileSystem: {
            stat: () => Promise.reject(new Error('No filesystem authority')),
            rename: () => Promise.reject(new Error('No filesystem authority')),
            unlink: () => Promise.reject(new Error('No filesystem authority')),
            writeFile: () => Promise.reject(new Error('No filesystem authority')),
          },
          allowLocalInspector: () => false,
        }),
      )
      const probe = new VersionedBackendProbe(adapters, { fetch: network.fetch })
      let connectedBackend: Awaited<ReturnType<VersionedBackendFactory['connect']>> | undefined
      try {
        await expect(access.prepare(endpoint, new AbortController().signal)).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
        })
        expect(logins).toBe(0)
        await access.authorize(endpoint)
        await access.prepare(endpoint, new AbortController().signal)
        const connection = await probe.probe({
          endpoint,
          source: 'configured',
          confidence: 100,
          runtimeVersion: '0.2.1-alpha.2',
        })
        if (connection === undefined)
          throw new Error(`Remote production probe rejected the owned DSH: ${JSON.stringify(responses)}`)
        expect(connection).not.toHaveProperty('pid')
        expect(connection.capabilities.adapterId).toBe('dsh-0.2.1-alpha.2')
        connectedBackend = await new VersionedBackendFactory(adapters).connect(connection)
        const workspace = await connectedBackend.workspaces.create({
          name: 'External fixture',
          path: runtime.snapshot.workspace,
        })
        const session = await connectedBackend.sessions.create({
          workspaceId: workspace.id,
          configuration: {
            preset: '',
            toolMode: 'native',
            permissionPreset: '',
            planMode: false,
            model: { providerId: '', modelId: '' },
          },
        })
        expect((await connectedBackend.sessions.open?.(session.id))?.id).toBe(session.id)
        expect((await connectedBackend.sessions.list()).items.some((item) => item.id === session.id)).toBe(
          true,
        )
        expect(await connectedBackend.inspectorDevtools?.discover()).toEqual({ available: false })
        await connectedBackend.close()
        connectedBackend = undefined
        expect(await canConnect(runtime.snapshot.port)).toBe(true)
        for (const [name, value] of values)
          values.set(
            name,
            JSON.stringify({
              ...(JSON.parse(value) as Record<string, unknown>),
              cookie: 'dsh-auth-fixture=expired-fixture',
              cookieExpiresAt: Date.now() + 100_000,
            }),
          )
        await access.prepare(endpoint, new AbortController().signal)
        expect(logins).toBe(2)
        expect(
          await probe.probe({
            endpoint,
            source: 'configured',
            confidence: 100,
            runtimeVersion: '0.2.1-alpha.2',
          }),
        ).toBeDefined()
        const untrusted = parseServerOrigin(`http://untrusted-fixture.test:${address.port}`)
        if (untrusted === undefined) throw new Error('Invalid untrusted authority fixture')
        await access.authorize(untrusted)
        await access.prepare(untrusted, new AbortController().signal)
        await expect(
          probe.probe({
            endpoint: untrusted,
            source: 'configured',
            confidence: 100,
            runtimeVersion: '0.2.1-alpha.2',
          }),
        ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
        await access.clear(endpoint)
        await expect(access.prepare(endpoint, new AbortController().signal)).rejects.toMatchObject({
          code: 'PERMISSION_DENIED',
        })
        expect(await canConnect(runtime.snapshot.port)).toBe(true)
      } finally {
        await connectedBackend?.close()
        await access.dispose()
        for (const socket of sockets) socket.destroy()
        proxy.close()
        await once(proxy, 'close')
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
