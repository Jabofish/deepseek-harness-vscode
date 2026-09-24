import { describe, expect, it } from 'vitest'
import {
  diagnosticsSnapshotSchema,
  hostEnvelopeSchema,
  hostMessageSchema,
  webviewRequestSchema,
} from './schemas.js'
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

describe('sequenced queue projection protocol', () => {
  it('accepts an optional safe projection cut and rejects malformed cuts', () => {
    const base = {
      type: 'event',
      name: 'queue.updated',
      sequence: 1,
      payload: { sessionId: 'session-1', items: [] },
    }

    expect(
      hostMessageSchema.safeParse({ ...base, payload: { ...base.payload, asOfSequence: 6 } }).success,
    ).toBe(true)
    expect(
      hostMessageSchema.safeParse({ ...base, payload: { ...base.payload, asOfSequence: -1 } }).success,
    ).toBe(false)
    expect(
      hostMessageSchema.safeParse({ ...base, payload: { ...base.payload, asOfSequence: 1.5 } }).success,
    ).toBe(false)
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

describe('Job follow Webview protocol', () => {
  it('requires an identity on follow start and stop requests', () => {
    const base = { sessionId: 'session-1', jobId: 'bash-1' }
    expect(
      webviewRequestSchema.safeParse({
        type: 'job.follow.start',
        requestId: 'follow-1',
        payload: { ...base, followId: 'follow-1', from: 12 },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'job.follow.stop',
        requestId: 'stop-1',
        payload: { ...base, followId: 'follow-1' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'job.follow.stop',
        requestId: 'stop-2',
        payload: base,
      }).success,
    ).toBe(false)
    expect(
      webviewRequestSchema.safeParse({
        type: 'job.follow.start',
        requestId: 'follow-2',
        payload: { ...base, from: 12 },
      }).success,
    ).toBe(false)
  })
})

describe('Job follow Host protocol', () => {
  const job = {
    id: 'bash-1',
    kind: 'bash',
    label: 'run build',
    status: 'running',
    startedAt: 1_000,
    output: { total: 5, earliest: 0 },
  }

  it('accepts a closed Job follow output event and keeps unrelated events generic', () => {
    expect(
      hostEnvelopeSchema.safeParse({
        protocolVersion: 1,
        message: {
          type: 'event',
          name: 'job.follow.updated',
          sequence: 1,
          payload: {
            sessionId: 'session-1',
            jobId: 'bash-1',
            followId: 'follow-1',
            frame: { type: 'output', chunks: [{ at: 0, text: 'hello' }], next: 5 },
          },
        },
      }).success,
    ).toBe(true)
    expect(
      hostEnvelopeSchema.safeParse({
        protocolVersion: 1,
        message: {
          type: 'event',
          name: 'job.follow.updated',
          sequence: 2,
          payload: {
            sessionId: 'session-1',
            jobId: 'bash-1',
            followId: 'follow-1',
            frame: { type: 'output', chunks: [{ at: 4, text: 'ef' }], next: 6, lossy: true },
          },
        },
      }).success,
    ).toBe(true)
    expect(
      hostEnvelopeSchema.safeParse({
        protocolVersion: 1,
        message: {
          type: 'event',
          name: 'job.follow.updated',
          sequence: 5,
          payload: {
            sessionId: 'session-1',
            jobId: 'bash-1',
            followId: 'follow-1',
            frame: {
              type: 'output',
              chunks: [
                { at: 0, text: 'a' },
                { at: 2, text: 'c', gapBefore: true },
              ],
              next: 3,
            },
          },
        },
      }).success,
    ).toBe(true)
    expect(
      hostEnvelopeSchema.safeParse({
        protocolVersion: 1,
        message: {
          type: 'event',
          name: 'job.follow.updated',
          sequence: 4,
          payload: {
            sessionId: 'session-1',
            jobId: 'bash-1',
            followId: 'follow-1',
            frame: { type: 'output', chunks: [], next: 5, lossy: true },
          },
        },
      }).success,
    ).toBe(true)
    expect(
      hostEnvelopeSchema.safeParse({
        protocolVersion: 1,
        message: {
          type: 'event',
          name: 'job.follow.updated',
          sequence: 3,
          payload: {
            sessionId: 'session-1',
            jobId: 'bash-1',
            followId: 'follow-1',
            frame: {
              type: 'output',
              chunks: [{ at: 4, text: '', gapBefore: true }],
              next: 4,
              lossy: true,
            },
          },
        },
      }).success,
    ).toBe(true)
    expect(
      hostEnvelopeSchema.safeParse({
        protocolVersion: 1,
        message: { type: 'event', name: 'jobs.updated', sequence: 2, payload: { sessionId: 'session-1' } },
      }).success,
    ).toBe(true)
  })

  it('rejects malformed offsets and extra fields at every Job follow boundary', () => {
    const base = {
      protocolVersion: 1,
      message: {
        type: 'event',
        name: 'job.follow.updated',
        sequence: 1,
        payload: {
          sessionId: 'session-1',
          jobId: 'bash-1',
          followId: 'follow-1',
          frame: { type: 'output', chunks: [{ at: 0, text: 'hello' }], next: 5 },
        },
      },
    }
    const malformed = [
      {
        ...base,
        message: {
          ...base.message,
          payload: {
            ...base.message.payload,
            frame: { type: 'output', chunks: [{ at: 0, text: 'a' }], next: 5 },
          },
        },
      },
      {
        ...base,
        message: {
          ...base.message,
          payload: {
            ...base.message.payload,
            frame: {
              type: 'output',
              chunks: [
                { at: 0, text: 'a' },
                { at: 2, text: 'c' },
              ],
              next: 3,
              lossy: true,
            },
          },
        },
      },
      {
        ...base,
        message: {
          ...base.message,
          payload: {
            ...base.message.payload,
            frame: { type: 'output', chunks: [], next: 5 },
          },
        },
      },
      {
        ...base,
        message: {
          ...base.message,
          payload: {
            ...base.message.payload,
            frame: {
              type: 'output',
              chunks: [
                { at: 0, text: 'a' },
                { at: 2, text: 'c' },
              ],
              next: 3,
            },
          },
        },
      },
      {
        ...base,
        message: {
          ...base.message,
          payload: {
            ...base.message.payload,
            frame: { type: 'output', chunks: [{ at: 9, text: 'x' }], next: 8 },
          },
        },
      },
      {
        ...base,
        message: {
          ...base.message,
          payload: { ...base.message.payload, injected: true },
        },
      },
      {
        ...base,
        message: {
          ...base.message,
          payload: {
            ...base.message.payload,
            frame: {
              type: 'output',
              chunks: [{ at: 0, text: 'hello', unexpected: true }],
              next: 5,
            },
          },
        },
      },
      {
        protocolVersion: 1,
        message: {
          type: 'event',
          name: 'job.follow.failed',
          sequence: 3,
          payload: {
            sessionId: 'session-1',
            jobId: 'bash-1',
            followId: 'follow-1',
            reason: 'private upstream error',
          },
        },
      },
    ]

    for (const envelope of malformed) {
      expect(hostEnvelopeSchema.safeParse(envelope).success).toBe(false)
      const message = typeof envelope === 'object' && envelope !== null ? envelope.message : undefined
      expect(hostMessageSchema.safeParse(message).success).toBe(false)
    }
  })

  it('accepts opened frames but rejects unsafe offsets and extra projected Job fields', () => {
    const event = {
      protocolVersion: 1,
      message: {
        type: 'event',
        name: 'job.follow.updated',
        sequence: 1,
        payload: {
          sessionId: 'session-1',
          jobId: 'bash-1',
          followId: 'follow-1',
          frame: { type: 'opened', job, from: 0 },
        },
      },
    }
    expect(hostEnvelopeSchema.safeParse(event).success).toBe(true)
    expect(
      hostEnvelopeSchema.safeParse({
        ...event,
        message: {
          ...event.message,
          payload: {
            ...event.message.payload,
            frame: { type: 'opened', job: { ...job, internalPath: 'private' }, from: 0 },
          },
        },
      }).success,
    ).toBe(false)
    expect(
      hostEnvelopeSchema.safeParse({
        ...event,
        message: {
          ...event.message,
          payload: {
            ...event.message.payload,
            frame: { type: 'opened', job, from: Number.MAX_SAFE_INTEGER + 1 },
          },
        },
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
