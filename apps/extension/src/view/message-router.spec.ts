import { describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'

import { WebviewMessageRouter } from './message-router.js'

describe('WebviewMessageRouter command diagnostics', () => {
  it('keeps the DSH command failure reason visible without exposing credential values', async () => {
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest: () =>
        Promise.reject(
          new AppError({
            code: 'INVALID_CONFIGURATION',
            message: 'The DSH configuration is invalid. Details: expected images array; token=super-secret',
            retryable: false,
            context: { rpcMethod: 'commands/execute', rpcCode: 'internal' },
          }),
        ),
    })

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'command.execute',
        requestId: 'command-diagnostic-1',
        payload: { sessionId: 'session-1', command: '/plan' },
      },
    })

    const response = posted[0] as { readonly error?: { readonly message?: string } }
    const message = response.error?.message ?? ''
    expect(message).toContain('commands/execute')
    expect(message).toContain('expected images array')
    expect(message).toContain('DSH code: internal')
    expect(message).not.toContain('super-secret')
  })

  it('keeps settings RPC diagnostics visible for native document and schema failures', async () => {
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest: () =>
        Promise.reject(
          new AppError({
            code: 'INTERNAL_ERROR',
            message:
              'DSH returned an internal error. Details: spawn powershell.exe ENOENT; token=super-secret',
            retryable: true,
            context: { rpcMethod: 'settings.openDocument', rpcCode: 'internal' },
          }),
        ),
    })

    await router.handle({
      protocolVersion: 1,
      message: { type: 'settings.openDocument', requestId: 'settings-diagnostic-1' },
    })

    const response = posted[0] as { readonly error?: { readonly message?: string } }
    const message = response.error?.message ?? ''
    expect(message).toContain('settings.openDocument')
    expect(message).toContain('DSH code: internal')
    expect(message).toContain('spawn powershell.exe ENOENT')
    expect(message).not.toContain('super-secret')
  })
})
