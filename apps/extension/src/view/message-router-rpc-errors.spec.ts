import { describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '@dsh-vscode/dsh-adapter/contracts'
import { Rc6SessionRepository } from '@dsh-vscode/dsh-adapter/repositories/session-repository'
import { WebviewMessageRouter } from './message-router.js'

describe('RPC diagnostic to Webview boundary', () => {
  it.each(['Bearer', 'Basic'])(
    'does not orphan a %s credential while preserving the actionable failure',
    async (scheme) => {
      const posted: unknown[] = []
      const transport: DshTransport = {
        request: <T>(method: string): Promise<T> => {
          expect(method).toBe('session.prompt')
          return Promise.resolve({
            result: {
              ok: false,
              error: {
                code: 'internal',
                message: `Connection refused. Authorization: ${scheme} fixture-private-credential`,
              },
            },
          } as T)
        },
        remoteRequest: <T>(): Promise<T> => Promise.reject(new Error('Unexpected fixture Remote')),
        async *openEventStream() {},
        close: () => Promise.resolve(),
      }
      const repository = new Rc6SessionRepository(transport)
      const router = new WebviewMessageRouter({
        postMessage: (message) => {
          posted.push(message)
          return Promise.resolve(true)
        },
        handleRequest: () => repository.sendPrompt({ sessionId: 's1', text: 'fixture', attachments: [] }),
      })
      await router.handle({
        protocolVersion: 1,
        message: {
          type: 'session.sendPrompt',
          requestId: 'rpc-secret-fixture',
          payload: { sessionId: 's1', text: 'fixture', attachments: [] },
        },
      })
      expect(posted).toHaveLength(1)
      expect(posted[0]).toMatchObject({ type: 'response', ok: false, error: { code: 'INTERNAL_ERROR' } })
      const serialized = JSON.stringify(posted[0])
      expect(serialized).toContain('Connection refused.')
      expect(serialized).not.toContain('fixture-private-credential')
    },
  )

  it('maps connection.configure AUTH_REQUIRED and INVALID_ENDPOINT to connection guidance', async () => {
    const posted: unknown[] = []
    let code: 'AUTH_REQUIRED' | 'INVALID_ENDPOINT' = 'AUTH_REQUIRED'
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest: () =>
        Promise.reject(new AppError({ code, message: 'private detail https://secret.example', retryable: true })),
    })

    await router.handle({
      protocolVersion: 1,
      message: { type: 'connection.configure', requestId: 'conn-auth', payload: { mode: 'custom' } },
    })
    code = 'INVALID_ENDPOINT'
    await router.handle({
      protocolVersion: 1,
      message: { type: 'connection.configure', requestId: 'conn-url', payload: { mode: 'custom' } },
    })

    expect(posted[0]).toMatchObject({
      type: 'response',
      ok: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'DSH authentication failed. Run JaboDSH: Authorize External Connection and try again.',
      },
    })
    expect(posted[1]).toMatchObject({
      type: 'response',
      ok: false,
      error: {
        code: 'INVALID_ENDPOINT',
        message: 'Enter a valid HTTP(S) DSH origin without path, query, or embedded credentials.',
      },
    })
    expect(JSON.stringify(posted)).not.toContain('secret.example')
  })
})
