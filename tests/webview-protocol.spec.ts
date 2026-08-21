import { describe, expect, it } from 'vitest'

import { webviewRequestSchema } from '../packages/webview-protocol/src/schemas.js'

describe('attachment ingest schema', () => {
  it('accepts automatic and custom DSH connection requests without exposing host details', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'connection.configure',
        requestId: 'connection-auto',
        payload: { mode: 'auto' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'connection.configure',
        requestId: 'connection-custom',
        payload: { mode: 'custom', endpoint: 'http://127.0.0.1:4310' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'connection.configure',
        requestId: 'connection-invalid-mode',
        payload: { mode: 'attach-only' },
      }).success,
    ).toBe(false)
    expect(
      webviewRequestSchema.safeParse({
        type: 'connection.configure',
        requestId: 'connection-secret',
        payload: { mode: 'custom', endpoint: 'http://127.0.0.1:4310?token=secret' },
      }).success,
    ).toBe(true)
  })

  it('accepts bounded DSH history paging parameters and rejects an invalid cursor', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'session.history',
        requestId: 'history-1',
        payload: { sessionId: 'session-1', beforeSeq: 20, maxMessages: 200 },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'session.history',
        requestId: 'history-2',
        payload: { sessionId: 'session-1', beforeSeq: -1 },
      }).success,
    ).toBe(false)
  })

  it('accepts the exact Base64 envelope size of an 8 MiB attachment', () => {
    const encodedLength = Math.ceil((8 * 1024 * 1024) / 3) * 4
    const request = {
      type: 'attachment.ingest',
      requestId: 'request-1',
      payload: {
        name: 'maximum.bin',
        dataBase64: 'A'.repeat(encodedLength),
      },
    }

    expect(webviewRequestSchema.safeParse(request).success).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, dataBase64: `${request.payload.dataBase64}A` },
      }).success,
    ).toBe(false)
  })

  it('accepts the rc.8 prompt attachment count and rejects the next item', () => {
    const attachments = Array.from({ length: 20 }, (_, index) => ({
      uri: `dsh-attachment:${String(index).padStart(16, '0')}`,
      name: `${index}.png`,
      mimeType: 'image/png',
    }))
    const request = {
      type: 'session.sendPrompt',
      requestId: 'request-2',
      payload: { sessionId: 'session-1', text: 'attach', attachments },
    }

    expect(webviewRequestSchema.safeParse(request).success).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, attachments: [...attachments, attachments[0]] },
      }).success,
    ).toBe(false)
  })

  it('keeps command image handles opaque and validates feedback/reference requests', () => {
    const attachment = {
      uri: 'dsh-attachment:1234567890abcdef',
      name: 'diagram.png',
      mimeType: 'image/png',
    }
    expect(
      webviewRequestSchema.safeParse({
        type: 'command.execute',
        requestId: 'request-command-images',
        payload: { sessionId: 'session-1', command: '/goal inspect', attachments: [attachment] },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'reference.list',
        requestId: 'request-reference',
        payload: { sessionId: 'session-1', query: 'src/', quoted: false },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'feedback.note',
        requestId: 'request-feedback-note',
        payload: {
          sessionId: 'session-1',
          messageId: 'message-1',
          rating: 'positive',
          note: 'keep the explanation concise',
        },
      }).success,
    ).toBe(true)
  })

  it('keeps model discovery host-mediated and rejects a Webview API key', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'models.discover',
        requestId: 'discover-models',
        payload: {
          settingsNamespace: 'llm-pi-ai',
          providerId: 'gateway',
          baseUrl: 'http://127.0.0.1:9000/v1',
          api: 'openai-completions',
        },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'models.discover',
        requestId: 'discover-secret',
        payload: { settingsNamespace: 'llm-pi-ai', apiKey: 'must-not-cross-boundary' },
      }).success,
    ).toBe(false)
  })

  it('accepts Host-mediated DSH update requests and keeps version selection bounded', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'runtime.update.check',
        requestId: 'runtime-update-check',
        payload: { force: true },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'runtime.update.install',
        requestId: 'runtime-update-install',
        payload: { version: '0.1.0-rc.8' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'runtime.update.install',
        requestId: 'runtime-update-invalid',
        payload: { version: 'latest' },
      }).success,
    ).toBe(true)
    // The schema bounds transport size; the Host performs the exact registry
    // membership and SemVer validation before invoking npm.
    expect(
      webviewRequestSchema.safeParse({
        type: 'runtime.update.install',
        requestId: 'runtime-update-too-long',
        payload: { version: 'x'.repeat(129) },
      }).success,
    ).toBe(false)
  })
})
