import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { BackendService } from '@dsh-vscode/application'
import type { DshBackend } from '@dsh-vscode/domain'
import { Alpha212VersionAdapter } from '@dsh-vscode/dsh-adapter'

vi.mock('vscode', () => ({ workspace: { isTrusted: true } }))

import { createFeatureRequestHandler } from './feature-request-handler.js'
import { WebviewMessageRouter } from '../view/message-router.js'

describe('timed question cancellation through Host and real mux transport', () => {
  it('keeps the surviving UI attached and releases the shared upstream stream on explicit release', async () => {
    const server = createServer()
    const sockets = new WebSocketServer({ server })
    let upstream: { readonly socket: WebSocket; readonly streamId: string } | undefined
    const cancelled: string[] = []
    const opened: string[] = []
    sockets.on('connection', (socket) =>
      socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) throw new Error('Expected a text-frame Buffer')
        const frame = JSON.parse(data.toString()) as {
          readonly type: string
          readonly streamId: string
          readonly endpoint?: string
        }
        if (frame.type === 'open') {
          opened.push(frame.endpoint ?? '')
          upstream = { socket, streamId: frame.streamId }
        } else if (frame.type === 'cancel') {
          cancelled.push(frame.streamId)
          socket.send(JSON.stringify({ type: 'end', streamId: frame.streamId }))
        }
      }),
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture port')
    let backend: DshBackend | undefined
    let router: WebviewMessageRouter | undefined
    try {
      backend = await new Alpha212VersionAdapter({
        fetch: globalThis.fetch,
        requestTimeoutMs: 1_000,
        retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      }).createBackend({
        endpoint: { host: '127.0.0.1', port: address.port, baseUrl: `http://127.0.0.1:${address.port}` },
        ownership: 'external',
        capabilities: { protocolVersion: 'alpha212', dshVersion: '0.2.1-alpha.2', features: new Set() },
      })
      if (backend.userQuestions === undefined) throw new Error('Missing question repository')
      const service = { requireBackend: () => backend! } as BackendService
      const { handleFeatureRequest } = createFeatureRequestHandler({
        backendService: service,
        requireCurrentWorkspaceSession: () => Promise.resolve({ id: 's' }),
      } as never)
      const posted: unknown[] = []
      router = new WebviewMessageRouter({
        handleFeatureRequest,
        postMessage: (message) => {
          posted.push(message)
          return Promise.resolve(true)
        },
      })
      const envelope = (requestId: string): unknown => ({
        protocolVersion: 1,
        message: {
          type: 'user-question.wait.attach',
          requestId,
          payload: { sessionId: 's', callId: 'c' },
        },
      })
      const first = router.handle(envelope('first'))
      const second = router.handle(envelope('second'))
      await vi.waitFor(() => {
        expect(upstream).toBeDefined()
      })
      await router.handle({
        protocolVersion: 1,
        message: {
          type: 'feature.request.cancel',
          requestId: 'cancel-first',
          payload: { targetRequestId: 'first' },
        },
      })
      await first
      expect(cancelled).toEqual([])
      expect(
        posted.find(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            'requestId' in value &&
            value.requestId === 'first',
        ),
      ).toMatchObject({ requestId: 'first', ok: false, error: { code: 'REQUEST_CANCELLED' } })
      const active = upstream!
      active.socket.send(
        JSON.stringify({ type: 'item', streamId: active.streamId, value: { remainingMs: 4_250 } }),
      )
      await second
      expect(posted).toContainEqual(
        expect.objectContaining({
          requestId: 'second',
          ok: true,
          payload: { kind: 'question.wait', remainingMs: 4_250 },
        }),
      )
      expect(opened).toEqual(['userQuestions/attachWait'])
      await router.handle({
        protocolVersion: 1,
        message: {
          type: 'user-question.wait.release',
          requestId: 'release',
          payload: { sessionId: 's', callId: 'c' },
        },
      })
      await vi.waitFor(() => expect(cancelled).toEqual([active.streamId]))
    } finally {
      router?.cancelAll()
      await backend?.close()
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
