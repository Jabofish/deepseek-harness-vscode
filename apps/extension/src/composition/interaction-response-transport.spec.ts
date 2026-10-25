import { transcriptWindowFixture, sessionWatchFixture } from '../view/transcript-window.fixture.js'
import { createServer, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { BackendService, InteractionUseCases } from '@dsh-vscode/application'
import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import { Alpha212VersionAdapter, Rc213VersionAdapter } from '@dsh-vscode/dsh-adapter'

vi.mock('vscode', () => ({ workspace: { isTrusted: true } }))

import { createRequestGateway } from './request-handler.js'
import { WebviewSurfaceRegistry } from '../view/webview-surface-registry.js'

describe('interaction cancellation through the Host and real alpha transport', () => {
  it.each([
    { Adapter: Alpha212VersionAdapter, protocolVersion: 'alpha212' as const, dshVersion: '0.2.1-alpha.2' },
    { Adapter: Rc213VersionAdapter, protocolVersion: 'rc213' as const, dshVersion: '0.2.1-rc.3' },
  ])(
    '$dshVersion keeps an accepted batch alive for its other caller and refuses a conflicting answer',
    async ({ Adapter, protocolVersion, dshVersion }) => {
      // Controlled wire fixture for dsh-v0.2.1-alpha.2 d74326738864:
      // gateway/src/index.ts settles $events/result before replying to HTTP.
      // The consumed Gateway/userQuestions contract is unchanged at rc.3
      // 1f81c047fc48fa190a683e469daa699857e9afe8. This exercises real
      // Adapter/mux/HTTP/Host paths, not a live DSH model turn.
      const responses: {
        readonly rpcId: string
        readonly response: ServerResponse
        readonly payload: unknown
      }[] = []
      const server = createServer((request, response) => {
        void (async (): Promise<void> => {
          const chunks: Buffer[] = []
          for await (const chunk of request) {
            if (!Buffer.isBuffer(chunk)) throw new Error('Expected request Buffer')
            chunks.push(chunk)
          }
          const envelope = JSON.parse(Buffer.concat(chunks).toString()) as {
            readonly rpcId: string
            readonly method: string
            readonly payload: unknown
          }
          if (envelope.method !== '$events/result') throw new Error('Unexpected fixture RPC')
          responses.push({ rpcId: envelope.rpcId, response, payload: envelope.payload })
          // The result is accepted here; hold back its acknowledgement.
        })().catch(() => {
          response.writeHead(500)
          response.end()
        })
      })
      const sockets = new WebSocketServer({ server })
      sockets.on('connection', (socket) => {
        socket.on('message', (data) => {
          if (!Buffer.isBuffer(data)) throw new Error('Expected text-frame Buffer')
          const frame = JSON.parse(data.toString()) as {
            readonly type: string
            readonly streamId: string
            readonly endpoint?: string
          }
          if (frame.type === 'cancel') {
            socket.send(JSON.stringify({ type: 'end', streamId: frame.streamId }))
            return
          }
          if (frame.type !== 'open' || frame.endpoint !== '$events') return
          socket.send(
            JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: { type: 'ready', clientId: 'fixture-client', host: { home: '/fixture-home' } },
            }),
          )
          socket.send(
            JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: {
                type: 'waterfall',
                event: 'user-questions/request',
                eventId: 'fixture-event',
                agentId: 's',
                request: {
                  questions: [
                    {
                      id: 'plan',
                      question: 'Proceed?',
                      options: [{ label: 'Approve' }, { label: 'Decline' }],
                    },
                    { id: 'scope', question: 'Scope?' },
                  ],
                },
              },
            }),
          )
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing fixture port')
      let backend: DshBackend | undefined
      let gateway: ReturnType<typeof createRequestGateway> | undefined
      let unsubscribe: (() => void) | undefined
      try {
        backend = await new Adapter({
          fetch: globalThis.fetch,
          requestTimeoutMs: 2_000,
          retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
        }).createBackend({
          endpoint: { host: '127.0.0.1', port: address.port, baseUrl: `http://127.0.0.1:${address.port}` },
          ownership: 'external',
          capabilities: { protocolVersion, dshVersion, features: new Set() },
        })
        const events: BackendEvent[] = []
        unsubscribe = backend.events.subscribe((event) => events.push(event))
        await vi.waitFor(() => expect(events.some((event) => event.type === 'question.requested')).toBe(true))
        const service = new BackendService()
        service.attach(backend, () => undefined)
        const respond = vi.spyOn(backend.interactions, 'respondToQuestion')
        const posted: unknown[] = []
        const responseFor = (requestId: string): unknown =>
          posted.find(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              'requestId' in value &&
              value.requestId === requestId,
          )
        gateway = createRequestGateway({
          postTo: () => Promise.resolve(true),
          postEvent: () => Promise.resolve(true),
          postEventTo: () => Promise.resolve(true),
          surfaces: new WebviewSurfaceRegistry(),
          transcript: transcriptWindowFixture(),
          sessionWatch: sessionWatchFixture(),
          post: (message: unknown) => {
            posted.push(message)
            return Promise.resolve(true)
          },
          backendService: service,
          interactionUseCases: new InteractionUseCases(service),
          // Workspace ownership is covered separately by session-scope specs.
          requireOwnedQuestion: () => Promise.resolve(),
          diagnostics: { log: () => undefined },
          context: { extensionUri: { fsPath: '/fixture-extension' }, subscriptions: [] },
          currentWorkspaceFolders: () => [],
        } as never)
        const answer = (requestId: string, choice = 'Approve'): unknown => ({
          protocolVersion: 1,
          message: {
            type: 'interaction.question.respond',
            requestId,
            payload: {
              questionId: 'plan',
              identity: { sessionId: 's', rpcId: 'fixture-event' },
              response: [
                { id: 'plan', response: [choice] },
                { id: 'scope', response: 'workspace' },
              ],
            },
          },
        })
        const first = gateway.router.handle(answer('first'))
        const second = gateway.router.handle(answer('second'))
        await vi.waitFor(() => {
          expect(respond).toHaveBeenCalledTimes(2)
          expect(responses).toHaveLength(1)
        })
        await gateway.router.handle(answer('conflict', 'Decline'))
        expect(responseFor('conflict')).toMatchObject({
          requestId: 'conflict',
          ok: false,
          error: { code: 'BACKEND_BUSY' },
        })
        await gateway.router.handle({
          protocolVersion: 1,
          message: {
            type: 'feature.request.cancel',
            requestId: 'cancel-first',
            payload: { targetRequestId: 'first' },
          },
        })
        await first
        expect(responseFor('first')).toMatchObject({
          requestId: 'first',
          ok: false,
          error: { code: 'REQUEST_CANCELLED' },
        })
        const accepted = responses[0]!
        expect(accepted.response.destroyed).toBe(false)
        expect(accepted.payload).toEqual({
          args: {
            clientId: 'fixture-client',
            eventId: 'fixture-event',
            outcome: {
              kind: 'result',
              value: {
                answers: [
                  { id: 'plan', selected: ['Approve'] },
                  { id: 'scope', selected: [], custom: 'workspace' },
                ],
              },
            },
          },
        })
        accepted.response.setHeader('content-type', 'application/json')
        accepted.response.end(
          JSON.stringify({ type: 'server-response', rpcId: accepted.rpcId, result: { ok: true } }),
        )
        await second
        expect(posted).toContainEqual(expect.objectContaining({ requestId: 'second', ok: true }))
        expect(responses).toHaveLength(1)
        expect(events.filter((event) => event.type === 'question.resolved')).toEqual([
          { type: 'question.resolved', sessionId: 's', questionRpcId: 'fixture-event', outcome: 'answered' },
        ])
      } finally {
        gateway?.router.cancelAll()
        unsubscribe?.()
        await backend?.close()
        for (const socket of sockets.clients) socket.terminate()
        await new Promise<void>((resolve) => sockets.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  )
})
