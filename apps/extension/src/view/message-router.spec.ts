import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import { hostEnvelopeSchema } from '@dsh-vscode/webview-protocol'

import { WebviewMessageRouter } from './message-router.js'

describe('WebviewMessageRouter command diagnostics', () => {
  it('routes a strict feature request to the feature handler', async () => {
    const posted: unknown[] = []
    const handleFeatureRequest = vi.fn().mockResolvedValue({ kind: 'empty' })
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleFeatureRequest,
    })

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'editor.context.list',
        requestId: 'feature-route-1',
        payload: { workspaceFolderId: 'workspace-1' },
      },
    })

    expect(handleFeatureRequest).toHaveBeenCalledOnce()
    expect(posted[0]).toMatchObject({
      type: 'feature.response',
      requestId: 'feature-route-1',
      ok: true,
      payload: { kind: 'empty' },
    })
  })

  it('keeps an unconfigured feature route explicitly disabled', async () => {
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
    })

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'editor.context.list',
        requestId: 'feature-disabled-1',
        payload: {},
      },
    })

    expect(posted[0]).toMatchObject({
      type: 'feature.response',
      requestId: 'feature-disabled-1',
      ok: false,
      error: { code: 'FEATURE_DISABLED' },
    })
  })

  it('keeps an unconfigured request route explicitly disabled', async () => {
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
    })

    await router.handle({
      protocolVersion: 1,
      message: { type: 'session.list', requestId: 'request-disabled-1', payload: {} },
    })

    expect(posted[0]).toMatchObject({
      type: 'response',
      requestId: 'request-disabled-1',
      ok: false,
      error: { code: 'FEATURE_DISABLED' },
    })
  })

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

describe('WebviewMessageRouter attachment diagnostics', () => {
  function routerRejecting(error: AppError, posted: unknown[]): WebviewMessageRouter {
    return new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest: () => Promise.reject(error),
    })
  }

  it('keeps a local attachment rejection reason visible instead of blaming the DSH configuration', async () => {
    const posted: unknown[] = []
    const router = routerRejecting(
      new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The selected file is too large.',
        retryable: false,
      }),
      posted,
    )

    await router.handle({
      protocolVersion: 1,
      message: { type: 'attachment.pick', requestId: 'attachment-diagnostic-1' },
    })

    const response = posted[0] as { readonly error?: { readonly message?: string } }
    expect(response.error?.message).toContain('too large')
  })

  it('keeps the DSH attachment limit reason visible when a prompt is rejected', async () => {
    const posted: unknown[] = []
    const router = routerRejecting(
      new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment is too large. token=super-secret',
        retryable: false,
      }),
      posted,
    )

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'session.sendPrompt',
        requestId: 'attachment-diagnostic-2',
        payload: { sessionId: 'session-1', text: 'hi', attachments: [] },
      },
    })

    const response = posted[0] as { readonly error?: { readonly message?: string } }
    const message = response.error?.message ?? ''
    expect(message).toContain('too large')
    expect(message).not.toContain('super-secret')
  })
})

describe('WebviewMessageRouter prompt template diagnostics', () => {
  it('keeps a template validation reason visible instead of blaming the DSH configuration', async () => {
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleFeatureRequest: () =>
        Promise.reject(
          new AppError({
            code: 'INVALID_CONFIGURATION',
            message: 'Template variable {{name}} must be explicitly declared. token=super-secret',
            retryable: false,
          }),
        ),
    })

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'prompt.template.create',
        requestId: 'template-diagnostic-1',
        payload: {
          sessionId: 'session-1',
          workspaceFolderId: 'workspace-1',
          title: 'Review',
          description: '',
          templateText: 'Review {{name}}.',
          scope: 'workspace',
          variables: [],
        },
      },
    })

    const response = posted[0] as { readonly error?: { readonly message?: string } }
    const message = response.error?.message ?? ''
    expect(message).toContain('must be explicitly declared')
    expect(message).not.toContain('super-secret')
  })

  it('names the checkpoint file that is too large instead of only the quota', async () => {
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleFeatureRequest: () =>
        Promise.reject(
          new AppError({
            code: 'CHECKPOINT_QUOTA',
            message: 'The file src/bundle.js is too large for a checkpoint.',
            retryable: false,
          }),
        ),
    })

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'checkpoint.create',
        requestId: 'checkpoint-diagnostic-1',
        payload: { sessionId: 'session-1', workspaceFolderId: 'workspace-1' },
      },
    })

    const response = posted[0] as { readonly error?: { readonly message?: string } }
    expect(response.error?.message).toContain('src/bundle.js is too large')
  })
})

describe('WebviewMessageRouter attachment size budget', () => {
  // `attachment.ingest` admits the exact Base64 envelope of a 20 MiB rc.2 image,
  // so a budget that rejects a shorter string turns a supported paste into a
  // protocol error before the handler ever sees it.
  const encodedLength = Math.ceil((20 * 1024 * 1024) / 3) * 4

  it('routes the largest attachment the ingest schema admits', async () => {
    const posted: unknown[] = []
    const handleRequest = vi.fn().mockResolvedValue({ cancelled: true })
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest,
    })

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'attachment.ingest',
        requestId: 'attachment-budget-1',
        payload: { name: 'maximum.png', mimeType: 'image/png', dataBase64: 'A'.repeat(encodedLength) },
      },
    })

    expect(handleRequest).toHaveBeenCalledOnce()
    expect(posted[0]).toMatchObject({
      type: 'response',
      requestId: 'attachment-budget-1',
      ok: true,
    })
  })

  it('returns a maximum-size attachment preview instead of a protocol error', async () => {
    const posted: unknown[] = []
    const dataUri = `data:image/png;base64,${'A'.repeat(encodedLength)}`
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      handleRequest: () => Promise.resolve({ cancelled: false, dataUri }),
    })

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'attachment.preview',
        requestId: 'attachment-budget-2',
        payload: { uri: `dsh-attachment:${'a'.repeat(16)}` },
      },
    })

    const response = posted[0] as {
      readonly ok?: boolean
      readonly payload?: { readonly dataUri?: string }
      readonly error?: { readonly message?: string }
    }
    expect(response.error).toBeUndefined()
    expect(response.ok).toBe(true)
    expect(response.payload?.dataUri).toBe(dataUri)
  })
})

describe('WebviewMessageRouter unexpected failure diagnostics', () => {
  it('answers an unrepresentable host error inside the wire budget instead of throwing', async () => {
    const posted: unknown[] = []
    const router = new WebviewMessageRouter({
      postMessage: (message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      // The host owns the RPC error code, so it can be arbitrarily long; the
      // message builder appends it verbatim to the public failure text.
      handleRequest: () =>
        Promise.reject(
          new AppError({
            code: 'INTERNAL_ERROR',
            message: 'The DSH command failed.',
            retryable: true,
            context: { rpcMethod: 'commands/execute', rpcCode: 'x'.repeat(4_000) },
          }),
        ),
    })

    await expect(
      router.handle({
        protocolVersion: 1,
        message: {
          type: 'command.execute',
          requestId: 'oversize-error-1',
          payload: { sessionId: 'session-1', command: '/plan' },
        },
      }),
    ).resolves.toBeUndefined()

    const response = posted[0] as {
      readonly ok?: boolean
      readonly error?: { readonly code?: string; readonly message?: string }
    }
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('INTERNAL_ERROR')
    expect((response.error?.message ?? '').length).toBeLessThanOrEqual(1_024)
    expect(
      hostEnvelopeSchema.safeParse({ protocolVersion: 1, message: response }).success,
      'the Webview must be able to parse the failure it is sent',
    ).toBe(true)
  })

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
