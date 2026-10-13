import { describe, expect, it } from 'vitest'
import { Rc6SessionRepository, type DshTransport } from '@dsh-vscode/dsh-adapter'
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
})
