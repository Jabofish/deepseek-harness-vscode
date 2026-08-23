import { describe, expect, it, vi } from 'vitest'
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

describe('WebviewMessageRouter unexpected failure diagnostics', () => {
  it('reports non-AppError failures to the host diagnostics hook, bounded and redacted', async () => {
    const posted: unknown[] = []
    const entries: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest: () => Promise.reject(new Error(`boom password=hunter2 ${'x'.repeat(400)}`)),
      logUnexpectedError: (entry) => entries.push(entry),
    })

    await router.handle({
      protocolVersion: 1,
      message: { type: 'session.list', requestId: 'unexpected-1', payload: {} },
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0] as { requestType: string; name: string; message: string }
    expect(entry.requestType).toBe('session.list')
    expect(entry.name).toBe('Error')
    expect(entry.message).not.toContain('hunter2')
    expect(entry.message).toContain('password: [redacted]')
    expect(entry.message.length).toBeLessThanOrEqual(320)
    const response = posted[0] as { readonly error?: { readonly code?: string } }
    expect(response.error?.code).toBe('INTERNAL_ERROR')
  })

  it('does not route expected AppError failures through the diagnostics hook', async () => {
    const entries: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: () => Promise.resolve(true),
      handleRequest: () =>
        Promise.reject(new AppError({ code: 'BACKEND_UNREACHABLE', message: 'down', retryable: true })),
      logUnexpectedError: (entry) => entries.push(entry),
    })

    await router.handle({
      protocolVersion: 1,
      message: { type: 'session.list', requestId: 'expected-1', payload: {} },
    })

    expect(entries).toHaveLength(0)
  })

  it('contains a rejected response post and reports it through diagnostics', async () => {
    const entries: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: () => Promise.reject(new Error('webview disposed')),
      handleRequest: () => Promise.resolve(undefined),
      logUnexpectedError: (entry) => entries.push(entry),
    })

    await expect(
      router.handle({
        protocolVersion: 1,
        message: { type: 'session.list', requestId: 'post-failure-1', payload: {} },
      }),
    ).resolves.toBeUndefined()
    await vi.waitFor(() => expect(entries).toHaveLength(1))
    expect(entries[0]).toMatchObject({ requestType: 'session.list', message: 'webview disposed' })
  })

  it('does not let a failing diagnostics hook suppress the error response', async () => {
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest: () => Promise.reject(new Error('handler failed')),
      logUnexpectedError: () => {
        throw new Error('diagnostics unavailable')
      },
    })

    await expect(
      router.handle({
        protocolVersion: 1,
        message: { type: 'session.list', requestId: 'diagnostics-failure-1', payload: {} },
      }),
    ).resolves.toBeUndefined()
    expect(posted[0]).toMatchObject({
      type: 'response',
      requestId: 'diagnostics-failure-1',
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    })
  })
})
