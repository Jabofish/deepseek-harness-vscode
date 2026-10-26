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

describe('Job follow Host protocol', () => {
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
})

describe('settings write protocol', () => {
  const revision = 7

  it('limits one atomic batch to one namespace revision and strict relative operations', () => {
    const valid = {
      type: 'settings.mutate',
      requestId: 'settings-mutate-valid',
      payload: {
        namespace: 'llm-deepseek',
        expectedRevision: revision,
        operations: [
          { op: 'set', path: ['baseURL'], value: 'https://example.invalid' },
          { op: 'unset', path: ['models', '0', 'contextWindow'] },
        ],
      },
    }
    expect(webviewRequestSchema.safeParse(valid).success).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        ...valid,
        requestId: 'settings-mutate-mixed',
        payload: {
          ...valid.payload,
          operations: [{ op: 'set', namespace: 'shell', path: ['timeoutMs'], value: 20_000 }],
        },
      }).success,
    ).toBe(false)
    expect(
      webviewRequestSchema.safeParse({
        ...valid,
        requestId: 'settings-mutate-empty',
        payload: { ...valid.payload, operations: [] },
      }).success,
    ).toBe(false)
  })
})

describe('Schedule feature protocol', () => {
  const record = {
    id: 'schedule-1',
    kind: 'weekly',
    title: 'Weekly review',
    prompt: '[redacted prompt]',
    scheduledAt: '2026-10-02T09:00:00.000Z',
    time: '09:00:00',
    timeZone: 'Europe/Paris',
    weekdays: [1, 3, 5],
  }

  it('validates timed question wait claims and complete late-answer batches', () => {
    const requests = [
      {
        type: 'user-question.wait.attach',
        payload: { sessionId: 'session-1', callId: 'call-1' },
      },
      {
        type: 'user-question.wait.release',
        payload: { sessionId: 'session-1', callId: 'call-1' },
      },
      {
        type: 'user-question.reply.read',
        payload: { sessionId: 'session-1', callId: 'call-1' },
      },
      {
        type: 'user-question.answer',
        payload: {
          sessionId: 'session-1',
          callId: 'call-1',
          answer: {
            answers: [
              { id: 'scope', selected: ['workspace'], custom: 'include the tests' },
              { id: 'deadline', selected: [] },
            ],
          },
        },
      },
    ]
    for (const [index, request] of requests.entries())
      expect(featureRequestSchema.safeParse({ ...request, requestId: `question-${index}` }).success).toBe(
        true,
      )
    expect(
      featureRequestSchema.safeParse({
        type: 'user-question.answer',
        requestId: 'question-duplicate',
        payload: {
          sessionId: 'session-1',
          callId: 'call-1',
          answer: {
            answers: [
              { id: 'scope', selected: [] },
              { id: 'scope', selected: ['all'] },
            ],
          },
        },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'user-question.wait.attach',
        requestId: 'question-extra',
        payload: { sessionId: 'session-1', callId: 'call-1', endpoint: 'http://127.0.0.1' },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'question-wait-response',
        ok: true,
        payload: { kind: 'question.wait', remainingMs: 0 },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'question-answer-response',
        ok: true,
        payload: { kind: 'question.answer', accepted: false },
      }).success,
    ).toBe(true)
  })

  it('accepts reply metadata and rejects answer bodies, unknown states and invalid cuts', () => {
    const response = (status: unknown): unknown => ({
      type: 'feature.response',
      requestId: 'reply-read',
      ok: true,
      payload: { kind: 'question.reply', status },
    })
    expect(featureResponseSchema.safeParse(response({ state: 'queued', asOfSequence: 101 })).success).toBe(
      true,
    )
    for (const status of [
      { state: 'queued', asOfSequence: 101, body: 'private answer' },
      { state: 'invented', asOfSequence: 101 },
      { state: 'released', asOfSequence: 1.5 },
      { state: 'released', asOfSequence: -2 },
    ])
      expect(featureResponseSchema.safeParse(response(status)).success).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'user-question.reply.read',
        requestId: 'reply-read',
        payload: { sessionId: 's1', callId: 'c', endpoint: 'http://127.0.0.1' },
      }).success,
    ).toBe(false)
  })

  it('rejects unbounded history pages, empty updates, malformed weekly rules, and unknown fields', () => {
    expect(
      featureRequestSchema.safeParse({
        type: 'schedule.history',
        requestId: 'history-too-large',
        payload: { sessionId: 'session-1', id: 'schedule-1', limit: 101 },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'schedule.update',
        requestId: 'update-empty',
        payload: { sessionId: 'session-1', id: 'schedule-1', expected: record },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'schedule.update',
        requestId: 'update-bad-rule',
        payload: {
          sessionId: 'session-1',
          id: 'schedule-1',
          expected: { ...record, weekdays: [1, 1] },
          prompt: 'updated',
        },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'schedule.delete',
        requestId: 'delete-extra',
        payload: { sessionId: 'session-1', id: 'schedule-1', prompt: 'must not transit' },
      }).success,
    ).toBe(false)
  })
})

describe('RC2 Account Profile feature protocol', () => {
  it('accepts closed profile requests and rejects identity or URL input from the Webview', () => {
    const requests = [
      { type: 'account.details.read', payload: {} },
      { type: 'account.bonus.ack', payload: { orderId: 'd80ff092-0cdd-4a34-b5fb-05503d8574d8' } },
      { type: 'account.page.open', payload: { page: 'top-up' } },
    ]
    for (const [index, request] of requests.entries())
      expect(
        featureRequestSchema.safeParse({ ...request, requestId: `account-request-${index}` }).success,
      ).toBe(true)
    expect(
      featureRequestSchema.safeParse({
        type: 'account.page.open',
        requestId: 'account-page-injection',
        payload: { page: 'usage', url: 'https://untrusted.example.test/' },
      }).success,
    ).toBe(false)
    expect(
      featureRequestSchema.safeParse({
        type: 'account.bonus.ack',
        requestId: 'account-ack-injection',
        payload: { orderId: 'd80ff092-0cdd-4a34-b5fb-05503d8574d8', accountId: 'host-only' },
      }).success,
    ).toBe(false)
  })

  it('accepts only account detail, acknowledgement, and page receipts with safe projections', () => {
    const details = {
      accountScopeRevision: 1,
      profile: { status: 'ready', value: { name: 'Ada', contact: 'ada@example.test' } },
      balance: { status: 'ready', value: { wallets: [], bonusWallets: [] } },
      bonus: { status: 'ready', value: null },
    }
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'account-details-response',
        ok: true,
        payload: { kind: 'account.details', snapshot: details },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'account-details-unsafe-response',
        ok: true,
        payload: {
          kind: 'account.details',
          snapshot: {
            ...details,
            profile: { status: 'ready', value: { name: 'Ada', contact: null, id: 'private' } },
          },
        },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'account-ack-response',
        ok: true,
        payload: { kind: 'account.bonus.ack', accepted: true },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'account-page-response',
        ok: true,
        payload: { kind: 'account.page.opened', page: 'usage' },
      }).success,
    ).toBe(true)
  })
})

describe('RC2 Plugin Manager feature protocol', () => {
  it('accepts only closed lifecycle request payloads', () => {
    const requests = [
      { type: 'plugin.bundles.list', payload: {} },
      { type: 'plugin.registries.list', payload: {} },
      { type: 'plugin.spec.inspect', payload: { spec: '@dsh-community/review-layer', registry: null } },
      {
        type: 'plugin.bundle.install',
        payload: { spec: '@dsh-community/review-layer', installRequestId: 'install-1' },
      },
      { type: 'plugin.bundle.cancelInstall', payload: { installRequestId: 'install-1' } },
      { type: 'plugin.bundle.waitForInstall', payload: { installRequestId: 'install-1' } },
      { type: 'plugin.bundle.setEnabled', payload: { name: '@dsh-community/review-layer', enabled: true } },
      { type: 'plugin.bundle.remove', payload: { name: '@dsh-community/review-layer' } },
      { type: 'plugin.entry.setEnabled', payload: { entryId: 'review:entry', enabled: false } },
    ]
    for (const [index, request] of requests.entries()) {
      expect(
        featureRequestSchema.safeParse({ ...request, requestId: `bundle-request-${index}` }).success,
      ).toBe(true)
    }
    expect(
      featureRequestSchema.safeParse({
        type: 'plugin.bundle.install',
        requestId: 'bundle-install-unsafe',
        payload: { spec: 'pkg', installRequestId: 'install-1', options: { enabled: true } },
      }).success,
    ).toBe(false)
  })

  it('accepts safe live inventories and refuses upstream-only diagnostics', () => {
    const bundle = {
      name: '@dsh-community/review-layer',
      version: '1.2.3',
      title: { en: 'Review layer', zh: '审查层' },
      enabled: false,
      installed: false,
      optional: true,
      removable: false,
      rows: [
        { rowId: 'review-row', moduleName: '@dsh-community/review-layer/review', entryId: 'review:entry' },
      ],
      overrides: [],
    }
    const response = {
      type: 'feature.response',
      requestId: 'bundle-list-response',
      ok: true,
      payload: {
        kind: 'plugin.bundles',
        available: true,
        bundles: [bundle],
        plugins: [
          {
            entryId: 'review:entry',
            moduleName: '@dsh-community/review-layer/review',
            enabled: false,
            fiberPhase: null,
          },
        ],
      },
    }
    expect(featureResponseSchema.safeParse(response).success).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        ...response,
        payload: {
          ...response.payload,
          bundles: [{ ...bundle, meta: { icon: 'https://invalid', error: 'private diagnostic' } }],
        },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        ...response,
        payload: { ...response.payload, available: false },
      }).success,
    ).toBe(false)
  })

  it('validates registry choices, inspection refusals, cancellation and closed operation results', () => {
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'registry-list-response',
        ok: true,
        payload: {
          kind: 'plugin.registries',
          available: true,
          registries: {
            registry: null,
            fallbackRegistries: ['https://mirror.example.test/'],
            resolved: 'https://registry.example.test/',
          },
        },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'registry-credential-response',
        ok: true,
        payload: {
          kind: 'plugin.registries',
          available: true,
          registries: {
            registry: null,
            fallbackRegistries: ['https://user:secret@mirror.example.test/'],
            resolved: null,
          },
        },
      }).success,
    ).toBe(false)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'inspection-response',
        ok: true,
        payload: { kind: 'plugin.inspection', inspection: { status: 'refused', problem: 'not-a-bundle' } },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'install-cancel-response',
        ok: true,
        payload: { kind: 'plugin.install.cancelled', status: 'too-late' },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'install-wait-result-response',
        ok: true,
        payload: {
          kind: 'plugin.install.waited',
          result: {
            name: '@dsh-community/review-layer',
            changed: true,
            application: 'applied',
            stage: 'install',
            bundle: '@dsh-community/review-layer',
          },
        },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'install-wait-settled-response',
        ok: true,
        payload: { kind: 'plugin.install.waited', result: null },
      }).success,
    ).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        type: 'feature.response',
        requestId: 'install-wait-open-response',
        ok: true,
        payload: {
          kind: 'plugin.install.waited',
          result: {
            name: 'plugin',
            changed: false,
            application: 'cancelled',
            stage: 'install',
            diagnostic: 'private',
          },
        },
      }).success,
    ).toBe(false)
    const change = {
      type: 'feature.response',
      requestId: 'bundle-change-response',
      ok: true,
      payload: {
        kind: 'plugin.bundle.changed',
        result: {
          name: '@dsh-community/review-layer',
          changed: false,
          application: 'cancelled',
          enabled: true,
          stage: 'enable',
        },
      },
    }
    expect(featureResponseSchema.safeParse(change).success).toBe(true)
    expect(
      featureResponseSchema.safeParse({
        ...change,
        payload: {
          ...change.payload,
          result: { ...change.payload.result, diagnostic: 'must not enter Webview' },
        },
      }).success,
    ).toBe(false)
  })
})

describe('editor surface request protocol', () => {
  it('accepts the documented payloads and rejects anything the host did not ask for', () => {
    expect(
      webviewRequestSchema.safeParse({
        type: 'surface.openInEditor',
        requestId: 'surface-open-1',
        payload: { sessionId: 'session-1' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({
        type: 'surface.openInEditor',
        requestId: 'surface-open-2',
        payload: { sessionId: 'session-1', title: 'Fix login bug' },
      }).success,
    ).toBe(true)
    expect(
      webviewRequestSchema.safeParse({ type: 'surface.moveToSidebar', requestId: 'surface-move-1' }).success,
    ).toBe(true)

    for (const rejected of [
      // An empty session id is not a handle the Host can validate.
      { type: 'surface.openInEditor', requestId: 'r1', payload: { sessionId: '' } },
      // The tab label is bounded on the wire as well as re-sanitized by the Host.
      { type: 'surface.openInEditor', requestId: 'r2', payload: { sessionId: 's1', title: 'x'.repeat(121) } },
      // The Webview never chooses its own surface identity or path.
      {
        type: 'surface.openInEditor',
        requestId: 'r3',
        payload: { sessionId: 's1', surfaceId: 'editor:s1' },
      },
      { type: 'surface.moveToSidebar', requestId: 'r4', payload: { sessionId: 's1' } },
    ])
      expect(webviewRequestSchema.safeParse(rejected).success).toBe(false)
  })
})
