import { describe, expect, it } from 'vitest'
import { diagnosticsSnapshotSchema, webviewRequestSchema } from './schemas.js'
import { featureRequestSchema, featureResponseSchema } from './feature-schemas.js'

describe('custom provider Webview protocol', () => {
  it('accepts only the non-secret provider draft and its CAS revision', () => {
    const result = webviewRequestSchema.safeParse({
      type: 'provider.custom.create',
      requestId: 'request-1',
      payload: {
        settingsNamespace: 'llm-pi-ai',
        collectionPath: ['providers'],
        providerId: 'gateway',
        displayName: 'Gateway',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: [{ id: 'gateway-chat', contextWindow: 128_000 }],
        expectedRevision: 7,
      },
    })

    expect(result.success).toBe(true)
  })

  it('rejects API keys in create and custom-discovery payloads', () => {
    const create = webviewRequestSchema.safeParse({
      type: 'provider.custom.create',
      requestId: 'request-1',
      payload: {
        settingsNamespace: 'llm-pi-ai',
        collectionPath: ['providers'],
        providerId: 'gateway',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: [{ id: 'gateway-chat' }],
        expectedRevision: 7,
        apiKey: 'must-stay-in-host',
      },
    })
    const discover = webviewRequestSchema.safeParse({
      type: 'models.discover.custom',
      requestId: 'request-2',
      payload: {
        settingsNamespace: 'llm-pi-ai',
        providerId: 'gateway',
        baseUrl: 'http://127.0.0.1:9000/v1',
        api: 'openai-completions',
        apiKey: 'must-stay-in-host',
      },
    })

    expect(create.success).toBe(false)
    expect(discover.success).toBe(false)
  })

  it('rejects an empty model list and a non-integral CAS revision', () => {
    const result = webviewRequestSchema.safeParse({
      type: 'provider.custom.create',
      requestId: 'request-1',
      payload: {
        settingsNamespace: 'llm-pi-ai',
        collectionPath: ['providers'],
        providerId: 'gateway',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: [],
        expectedRevision: 7.5,
      },
    })

    expect(result.success).toBe(false)
  })

  it('rejects credential-shaped fields even when nested in model metadata', () => {
    const result = webviewRequestSchema.safeParse({
      type: 'provider.custom.create',
      requestId: 'request-1',
      payload: {
        settingsNamespace: 'llm-pi-ai',
        collectionPath: ['providers'],
        providerId: 'gateway',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: [{ id: 'gateway-chat', metadata: { api_key: 'must-stay-in-host' } }],
        expectedRevision: 7,
      },
    })

    expect(result.success).toBe(false)
  })
})

describe('diagnostics Webview protocol', () => {
  it('accepts a bounded redacted snapshot request', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'diagnostics.snapshot',
        requestId: 'request-diagnostics',
      }).success,
    ).toBe(true)
  })

  it('keeps diagnostics response fields closed and bounded', () => {
    expect(
      diagnosticsSnapshotSchema.safeParse({
        extensionVersion: '0.1.9',
        state: 'failed',
        canReconnect: true,
        recentEvents: ['{"level":"error","event":"failure"}'],
      }).success,
    ).toBe(true)
    expect(
      diagnosticsSnapshotSchema.safeParse({
        extensionVersion: '0.1.9',
        state: 'failed',
        canReconnect: true,
        recentEvents: [],
        endpoint: 'http://127.0.0.1:3939',
      }).success,
    ).toBe(false)
  })
})

describe('task center Webview protocol', () => {
  const task = {
    taskId: 'session:session-1',
    sourceId: 'session-1',
    sessionId: 'session-1',
    workspaceFolderId: 'workspace-1',
    kind: 'session',
    title: 'Main session',
    status: 'running',
    needsUserAction: false,
    startedAt: 1,
    updatedAt: 2,
    childCount: 0,
    canOpen: true,
    canAnswer: false,
    canSessionCancel: true,
    ownerKind: 'unknown',
    taskRevision: 1,
  } as const

  it('accepts an explicit workspace task scope without a session id', () => {
    expect(
      featureRequestSchema.safeParse({
        type: 'tasks.list',
        requestId: 'request-tasks-workspace',
        payload: { scope: 'workspace', includeCompleted: false, limit: 200 },
      }).success,
    ).toBe(true)
  })

  it('requires bounded scope and completeness metadata on task responses', () => {
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'response-tasks',
        ok: true,
        payload: {
          kind: 'tasks',
          items: [task],
          scope: 'workspace',
          source: 'workspace-composed',
          complete: false,
          omittedSessions: 2,
        },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'response-tasks',
        ok: true,
        payload: {
          kind: 'tasks',
          items: [task],
          scope: 'workspace',
          source: 'workspace-composed',
          complete: false,
          omittedSessions: 65,
        },
      }).success,
    ).toBe(false)
  })
})

describe('goal Webview protocol', () => {
  it('accepts a positive safe maxGoalRounds on update', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'goal.update',
        requestId: 'request-goal-update',
        payload: { goalId: 'goal-1', maxGoalRounds: 9 },
      }).success,
    ).toBe(true)
  })

  it('rejects non-positive or non-integral goal round caps', () => {
    for (const maxGoalRounds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        webviewRequestSchema.safeParse({
          type: 'goal.update',
          requestId: 'request-goal-invalid',
          payload: { goalId: 'goal-1', maxGoalRounds },
        }).success,
      ).toBe(false)
    }
  })
})

describe('subagent Webview protocol', () => {
  it('accepts opaque attachment handles on a subagent follow-up', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'subagent.send',
        requestId: 'request-subagent',
        payload: {
          sessionId: 'child',
          message: '看这张图',
          attachments: [
            { uri: 'dsh-attachment:0123456789abcdef', name: 'screen.png', mimeType: 'image/png' },
          ],
        },
      }).success,
    ).toBe(true)
  })

  it('defaults delivery to queue, accepts steer, and rejects unknown modes', () => {
    const queued = webviewRequestSchema.safeParse({
      type: 'subagent.send',
      requestId: 'request-subagent-default',
      payload: { sessionId: 'child', message: 'continue' },
    })
    expect(queued.success).toBe(true)
    if (queued.success && queued.data.type === 'subagent.send') expect(queued.data.payload.mode).toBe('queue')

    expect(
      webviewRequestSchema.safeParse({
        type: 'subagent.send',
        requestId: 'request-subagent-steer',
        payload: { sessionId: 'child', message: 'steer', mode: 'steer' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'subagent.send',
        requestId: 'request-subagent-invalid',
        payload: { sessionId: 'child', message: 'invalid', mode: 'later' },
      }).success,
    ).toBe(false)
  })
})

describe('message feedback Webview protocol', () => {
  it('accepts the upstream feedback category on submit and note updates', () => {
    for (const type of ['feedback.toggle', 'feedback.note'] as const) {
      expect(
        webviewRequestSchema.safeParse({
          type,
          requestId: `request-${type}`,
          payload: {
            sessionId: 'session-1',
            messageId: 'message-1',
            rating: 'negative',
            note: 'needs work',
            category: 'instruction-following',
          },
        }).success,
      ).toBe(true)
    }
  })

  it('rejects a foreign feedback category', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'feedback.toggle',
        requestId: 'request-feedback-invalid',
        payload: {
          sessionId: 'session-1',
          messageId: 'message-1',
          rating: 'positive',
          category: 'not-a-category',
        },
      }).success,
    ).toBe(false)
  })
})
