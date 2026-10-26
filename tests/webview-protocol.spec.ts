import { describe, expect, it } from 'vitest'

import {
  protocolValueWithinBudget,
  webviewEnvelopeSchema,
  webviewRequestSchema,
} from '../packages/webview-protocol/src/schemas.js'

describe('attachment ingest schema', () => {
  it('rejects retired raw history access and pages through bounded transcript windows', () => {
    for (const payload of [
      { sessionId: 's' },
      { sessionId: 's', beforeSeq: 20, maxMessages: 200, pagePurpose: 'transcript' },
    ])
      expect(
        webviewRequestSchema.safeParse({ type: 'session.history', requestId: 'retired', payload }).success,
      ).toBe(false)
    expect(
      webviewRequestSchema.safeParse({
        type: 'subagent.history',
        requestId: 'open',
        payload: { sessionId: 'child' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'subagent.history',
        requestId: 'retired-child-page',
        payload: { sessionId: 'child', beforeSeq: 20 },
      }).success,
    ).toBe(false)
    expect(
      webviewRequestSchema.safeParse({
        type: 'session.transcript.navigate',
        requestId: 'older',
        payload: { sessionId: 's', revision: 2, direction: 'older' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'session.transcript.navigate',
        requestId: 'invalid',
        payload: { sessionId: 's', revision: -1, direction: 'older' },
      }).success,
    ).toBe(false)
  })

  it('accepts the exact Base64 envelope size of a 20 MiB rc.2 image', () => {
    const encodedLength = Math.ceil((20 * 1024 * 1024) / 3) * 4
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

  it('keeps the wire budget in step with the admitted attachment envelope', () => {
    const encodedLength = Math.ceil((20 * 1024 * 1024) / 3) * 4
    const measurement = 'A'.repeat(encodedLength)
    const envelope = {
      protocolVersion: 1,
      message: {
        type: 'attachment.ingest',
        requestId: 'request-1',
        payload: { name: 'maximum.png', mimeType: 'image/png', dataBase64: measurement },
      },
    }

    expect(webviewEnvelopeSchema.safeParse(envelope).success).toBe(true)
    expect(protocolValueWithinBudget(envelope)).toBe(true)
    // The preview that returns the same image must survive the budget too: the
    // data URI prefix is the reason the per-string cap keeps a small headroom.
    expect(
      protocolValueWithinBudget({
        protocolVersion: 1,
        message: {
          type: 'response',
          requestId: 'request-1',
          ok: true,
          payload: { cancelled: false, dataUri: `data:image/png;base64,${measurement}` },
        },
      }),
    ).toBe(true)
    expect(
      protocolValueWithinBudget({
        ...envelope,
        message: {
          ...envelope.message,
          payload: {
            ...envelope.message.payload,
            dataBase64: 'A'.repeat(Math.ceil((21 * 1024 * 1024) / 3) * 4),
          },
        },
      }),
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
})

describe('workspace directory selection boundary', () => {
  it('accepts a picker gesture but rejects a Webview-supplied host path', () => {
    const request = { type: 'workspace.addFolder', requestId: 'pick-folder' }
    expect(webviewRequestSchema.safeParse(request).success).toBe(true)
    expect(webviewRequestSchema.safeParse({ ...request, payload: { path: '/private' } }).success).toBe(false)
  })
})

describe('skill documentation action schema', () => {
  it('accepts catalog identity and rejects a Webview-supplied filesystem path', () => {
    const request = {
      type: 'skill.openDocument',
      requestId: 'open-skill',
      payload: { sessionId: 'session', skillId: 'review' },
    }
    expect(webviewRequestSchema.safeParse(request).success).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, path: '/secret/SKILL.md' },
      }).success,
    ).toBe(false)
    expect(webviewRequestSchema.safeParse({ ...request, payload: { skillId: 'review' } }).success).toBe(false)
  })
})
