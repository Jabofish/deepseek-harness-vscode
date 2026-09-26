import { describe, expect, it } from 'vitest'
import type { RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendFactory } from '../src/backend-factory.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { Rc6CommandRepository } from '../src/repositories/command-repository.js'
import { Rc6InteractionRepository } from '../src/repositories/interaction-repository.js'
import {
  RC6_PINNED_SOURCE_COMMIT,
  RC6_RPC_METHOD_NAMES,
  RC6_STRUCTURED_EVENT_FAMILIES,
} from './fixtures/rc6-contract-snapshot.js'

const rpcMethods = RC6_RPC_METHOD_NAMES satisfies readonly (keyof RpcMethodMap)[]

const transport = (response: unknown): DshTransport => ({
  request: <TResponse>(_method: string, _params: unknown, _signal?: AbortSignal) =>
    Promise.resolve(response as TResponse),
  remoteRequest: <TResponse>(
    _endpoint: string,
    _args: Readonly<Record<string, unknown>>,
    _signal?: AbortSignal,
  ) => Promise.resolve(response as TResponse),
  openEventStream: async function* () {
    /* fixture stream */
  },
  close: () => Promise.resolve(),
})

describe('DeepSeek Harness 0.1.0-rc.6 contract', () => {
  it('matches every RPC name against the pinned official rpc-map', () => {
    type Missing = Exclude<keyof RpcMethodMap, (typeof rpcMethods)[number]>
    const noMissing: Missing extends never ? true : never = true
    expect(noMissing).toBe(true)
    expect(rpcMethods).toHaveLength(52)
    expect(RC6_PINNED_SOURCE_COMMIT).toBe('47f943859bef60e4160492346772ded9b24f765a')
    expect(new Set(rpcMethods).size).toBe(rpcMethods.length)
  })

  it('keeps the audited structured event family list explicit', () => {
    expect(RC6_STRUCTURED_EVENT_FAMILIES).toEqual([
      'session/subscribed',
      'host/session-activity',
      'approval/resolved',
      'question/resolved',
      'session/projection',
      'goal/change',
      'host/session-added',
      'host/workspace-removed',
      'host/remote-event',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'question/requested',
      'session/jobs',
    ])
  })

  it('maps the pinned goal/change full snapshot and clear tombstone', () => {
    const phases = [
      ['active', 'in-progress'],
      ['paused', 'pending'],
      ['blocked', 'blocked'],
      ['complete', 'completed'],
    ] as const

    for (const [phase, status] of phases) {
      expect(
        rc6Mapper.event('goal/change', {
          sessionId: 's1',
          data: {
            kind: 'goal/change',
            version: 1,
            operation: 'edit',
            goal: {
              id: 'goal-1',
              revision: 2,
              objective: 'Finish the adapter',
              phase,
              maxGoalRounds: 3,
              ...(phase === 'blocked'
                ? { blockedReason: { code: 'awaiting-input', message: 'Waiting for user input' } }
                : {}),
            },
            roundsStarted: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        }),
      ).toEqual({
        type: 'goal.updated',
        sessionId: 's1',
        goals: [
          {
            id: 'goal-1',
            title: 'Finish the adapter',
            status,
            maxGoalRounds: 3,
            ...(phase === 'blocked'
              ? { blockedReason: { code: 'awaiting-input', message: 'Waiting for user input' } }
              : {}),
          },
        ],
      })
    }

    // The legacy whole-list event is mapped leniently: an unusable reason is
    // dropped instead of failing the frame, a usable one survives.
    for (const [blockedReason, expected] of [
      [
        { code: 'awaiting-input', message: 'Waiting for user input' },
        { code: 'awaiting-input', message: 'Waiting for user input' },
      ],
      [{ code: '', message: 'Waiting for user input' }, undefined],
      [{ code: 'awaiting-input', message: '   ' }, undefined],
      ['awaiting-input', undefined],
    ] as const) {
      expect(
        rc6Mapper.event('goal/updated', {
          sessionId: 's1',
          data: {
            goals: [
              {
                id: 'goal-1',
                revision: 2,
                objective: 'Finish the adapter',
                phase: 'blocked',
                maxGoalRounds: 3,
                blockedReason,
              },
            ],
          },
        }),
      ).toEqual({
        type: 'goal.updated',
        sessionId: 's1',
        goals: [
          {
            id: 'goal-1',
            title: 'Finish the adapter',
            status: 'blocked',
            maxGoalRounds: 3,
            ...(expected === undefined ? {} : { blockedReason: expected }),
          },
        ],
      })
    }

    expect(
      rc6Mapper.event('goal/change', {
        sessionId: 's1',
        data: {
          kind: 'goal/change',
          version: 1,
          operation: 'clear',
          cleared: { id: 'goal-1', revision: 3 },
          clearedAt: 3,
        },
      }),
    ).toEqual({ type: 'goal.updated', sessionId: 's1', goals: [] })

    expect(() =>
      rc6Mapper.event('goal/change', {
        sessionId: 's1',
        data: { kind: 'goal/change', version: 1, operation: 'edit' },
      }),
    ).toThrow(/goal\/change envelope/)

    expect(() =>
      rc6Mapper.event('goal/change', {
        sessionId: 's1',
        data: { operation: 'edit', goal: { id: 'goal-1', objective: 'missing envelope' } },
      }),
    ).toThrow(/goal\/change envelope/)

    expect(() =>
      rc6Mapper.event('goal/change', {
        sessionId: 's1',
        data: {
          kind: 'goal/change',
          version: 1,
          operation: 'clear',
          cleared: { id: 'goal-1', revision: 3 },
          clearedAt: -1,
        },
      }),
    ).toThrow(/clear tombstone/)

    const malformedGoal = {
      id: 'goal-1',
      revision: 2,
      objective: 'Finish the adapter',
      phase: 'active',
      maxGoalRounds: 3,
    }
    for (const goal of [
      { ...malformedGoal, objective: undefined },
      { ...malformedGoal, phase: 'future' },
      { ...malformedGoal, maxGoalRounds: 0 },
      { ...malformedGoal, phase: 'blocked' },
    ]) {
      expect(() =>
        rc6Mapper.event('goal/change', {
          sessionId: 's1',
          data: {
            kind: 'goal/change',
            version: 1,
            operation: 'edit',
            goal,
            roundsStarted: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        }),
      ).toThrow(/Malformed goal\/change goal/)
    }
  })

  it('fails closed on malformed session queue items instead of silently dropping them', () => {
    const validMessage = {
      id: 'message-1',
      role: 'user',
      content: [{ type: 'text', text: 'queued' }],
      source: { kind: 'user' },
    }
    const malformedItems = [
      { id: '', placement: 'queued', message: validMessage },
      { id: 'queue-1', placement: 'queued', message: { ...validMessage, content: 'queued' } },
      { id: 'queue-1', placement: 'unknown', message: validMessage },
      { id: 'queue-1', placement: 'queued', message: { ...validMessage, source: undefined } },
      {
        id: 'queue-1',
        placement: 'queued',
        message: {
          ...validMessage,
          content: [{ type: 'image', attachment: { attachmentId: 'image-1' } }],
        },
      },
    ]
    for (const item of malformedItems) {
      expect(() =>
        rc6Mapper.event('session/queue', {
          sessionId: 's1',
          data: { items: [item] },
        }),
      ).toThrow(/Malformed session\/queue item/)
    }
  })

  it('maps official host and mux event families without parsing terminal output', () => {
    const mapped = [
      rc6Mapper.event('session/subscribed', { sessionId: 's1', lastSeq: 2 }),
      rc6Mapper.event('host/session-activity', { sessionId: 's1', updatedAt: 1_700_000_000_000 }),
      rc6Mapper.event('approval/resolved', { sessionId: 's1', approvalId: 'a1', outcome: 'rejected' }),
      rc6Mapper.event('question/resolved', { sessionId: 's1', questionRpcId: 'q1', outcome: 'answered' }),
      rc6Mapper.event('session/projection', { sessionId: 's1', key: 'goal', seq: 3, value: {} }),
      rc6Mapper.event('host/session-added', {
        sessionId: 's1',
        blank: true,
        parentSessionId: 'parent',
        origin: 'subagent',
      }),
      rc6Mapper.event('host/workspace-removed', { workspaceId: 'w1' }),
      rc6Mapper.event('host/remote-event', { event: 'safe', args: [] }),
    ]
    expect(mapped.every((event) => event.type !== 'unknown')).toBe(true)
    expect(mapped[1]).toEqual({
      type: 'session.activity',
      sessionId: 's1',
      updatedAt: 1_700_000_000_000,
    })
    expect(mapped[5]).toEqual({
      type: 'session.added',
      sessionId: 's1',
      blank: true,
      parentSessionId: 'parent',
      origin: 'subagent',
    })
    expect(
      rc6Mapper.event('assistant/chunk', {
        sessionId: 's1',
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { text: 'Hi' } },
      }),
    ).toMatchObject({ type: 'message.delta', delta: 'Hi' })
  })

  it('does not confuse a shipped provider with a read-only provider when declared is false', () => {
    expect(
      rc6Mapper.provider({
        provider: 'minimax-cn',
        displayName: 'MiniMax',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'minimax-cn'],
        declared: false,
      }),
    ).toMatchObject({ configurable: true, declared: false })
  })

  it('does not filter malformed provider settingsPath segments', () => {
    expect(() =>
      rc6Mapper.provider({
        provider: 'gateway',
        displayName: 'Gateway',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', {}],
      }),
    ).toThrow(/provider settingsPath/)
  })

  it('preserves official step and event timestamps for timing consumers', () => {
    expect(
      rc6Mapper.event('turn/start', {
        sessionId: 's1',
        data: { turn: 1 },
      }),
    ).toEqual({ type: 'turn.started', sessionId: 's1', turn: 1 })
    expect(
      rc6Mapper.event('turn/end', {
        sessionId: 's1',
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ).toEqual({ type: 'turn.ended', sessionId: 's1', turn: 1, reason: 'completed' })
    expect(
      rc6Mapper.event('turn/end', {
        sessionId: 's1',
        data: { turn: 1, reason: { kind: 'future-plugin-reason' } },
      }),
    ).toEqual({ type: 'turn.ended', sessionId: 's1', turn: 1, reason: 'unknown' })
    expect(
      rc6Mapper.event('turn/end', {
        sessionId: 's1',
        data: {
          turn: 2,
          reason: {
            kind: 'error',
            error: { code: 'PROVIDER_UNAVAILABLE', message: 'apiKey=do-not-leak provider unavailable' },
          },
        },
      }),
    ).toEqual({
      type: 'turn.ended',
      sessionId: 's1',
      turn: 2,
      reason: 'error',
      failure: { code: 'PROVIDER_UNAVAILABLE', message: 'apiKey: [redacted] provider unavailable' },
    })
    expect(
      rc6Mapper.event('turn/end', {
        sessionId: 's1',
        data: { turn: 3, reason: { kind: 'error', error: { code: 'BAD CODE', message: '' } } },
      }),
    ).toEqual({ type: 'turn.ended', sessionId: 's1', turn: 3, reason: 'error' })
    expect(
      rc6Mapper.event('step/start', {
        sessionId: 's1',
        time: 1_000,
        data: { turn: 1, step: 1 },
      }),
    ).toEqual({ type: 'step.started', sessionId: 's1', turn: 1, step: 1, time: 1_000 })
    expect(
      rc6Mapper.event('assistant/chunk', {
        sessionId: 's1',
        time: 1_800,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'Hi' } },
      }),
    ).toMatchObject({ type: 'message.delta', turn: 1, step: 1, time: 1_800 })
    expect(
      rc6Mapper.event('assistant/message', {
        sessionId: 's1',
        time: 4_800,
        data: { turn: 1, step: 1, markdown: 'Hi' },
      }),
    ).toMatchObject({ type: 'message.completed', turn: 1, step: 1, time: 4_800 })
    expect(
      rc6Mapper.event('assistant/attempt', {
        sessionId: 's1',
        time: 4_900,
        data: { turn: 1, step: 1, stream: [] },
      }),
    ).toEqual({
      type: 'assistant.attempt',
      sessionId: 's1',
      turn: 1,
      step: 1,
      time: 4_900,
    })
    expect(
      rc6Mapper.event('tool/call', {
        sessionId: 's1',
        time: 5_000,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'shell', arguments: '{}' },
      }),
    ).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-1', turn: 1, step: 1, startedAt: '1970-01-01T00:00:05.000Z' },
    })
    expect(
      rc6Mapper.event('tool/result', {
        sessionId: 's1',
        time: 5_600,
        data: {
          turn: 1,
          step: 1,
          callId: 'call-1',
          message: { content: 'ok', source: { callId: 'call-1' } },
        },
      }),
    ).toMatchObject({ type: 'tool.updated', tool: { completedAt: '1970-01-01T00:00:05.600Z' } })
    expect(
      rc6Mapper.event('tool/result', {
        sessionId: 's1',
        data: {
          callId: 'call-error',
          name: 'ask_user_question',
          message: { isError: true, content: [{ type: 'text', text: 'the answer was rejected' }] },
        },
      }),
    ).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-error', status: 'failed', error: 'the answer was rejected' },
    })
    expect(
      rc6Mapper.event('tool/result', {
        sessionId: 's1',
        data: {
          callId: 'call-error-nested',
          message: {
            source: { kind: 'tool', callId: 'call-error-nested' },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-error-nested',
                content: ['[truncated]'],
                isError: true,
              },
            ],
            role: 'user',
            id: 'message-error-nested',
          },
        },
      }),
    ).toMatchObject({
      type: 'tool.updated',
      tool: {
        id: 'call-error-nested',
        status: 'failed',
        error: '[truncated]',
        outputSummary: '[truncated]',
      },
    })
  })

  it('uses the final embedded usage sample and lets a message-level sample replace it', () => {
    const stream = [
      {
        type: 'chunk',
        time: 1,
        chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
      },
      {
        type: 'chunk',
        time: 2,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 7, outputTokens: 2, totalTokens: 11, cacheReadTokens: 2 },
        },
      },
    ]

    expect(
      rc6Mapper.event('assistant/attempt', {
        sessionId: 's1',
        data: { turn: 1, step: 1, stream },
      }),
    ).toMatchObject({
      type: 'assistant.attempt',
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 11, cacheReadTokens: 2 },
    })

    const completedMessage = {
      id: 'assistant-1',
      content: [{ type: 'text', text: 'Answer' }],
      source: { provider: 'provider-a', model: 'model-a' },
    }
    expect(
      rc6Mapper.event('assistant/message', {
        sessionId: 's1',
        data: {
          turn: 1,
          step: 1,
          message: completedMessage,
          stream,
          usage: { inputTokens: 9, outputTokens: 4, totalTokens: 14 },
        },
      }),
    ).toMatchObject({
      type: 'message.completed',
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 14 },
    })
    expect(
      rc6Mapper.event('assistant/message', {
        sessionId: 's1',
        data: { turn: 1, step: 1, message: completedMessage, stream },
      }),
    ).toMatchObject({
      type: 'message.completed',
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 11, cacheReadTokens: 2 },
    })
  })

  it('does not fall back to older stream usage when a declared message sample is malformed', () => {
    const event = rc6Mapper.event('assistant/message', {
      sessionId: 's1',
      data: {
        turn: 1,
        step: 1,
        message: { id: 'assistant-1', content: [{ type: 'text', text: 'Answer' }] },
        stream: [
          {
            type: 'chunk',
            time: 1,
            chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
          },
        ],
        usage: { inputTokens: 'bad', outputTokens: 1 },
      },
    })
    expect(event).toMatchObject({ type: 'message.completed' })
    if (event.type === 'message.completed') expect(event.usage).toBeUndefined()
  })

  it('keeps a provider failure message longer than 320 characters', () => {
    // `turn/end`'s error reason carries the provider adapter's own `LlmError`
    // message (e.g. the provider's `error.message` from an HTTP error body)
    // with no length bound, and the reference client renders it whole in its
    // turn-error row. Clipping here drops the tail of the user's only
    // diagnosis with no ellipsis or second surface that reveals the loss.
    const message = `DeepSeek API error (HTTP 400): ${'invalid request field '.repeat(20)}`.trim()
    expect(message.length).toBeGreaterThan(320)
    expect(
      rc6Mapper.event('turn/end', {
        sessionId: 's1',
        data: {
          turn: 4,
          reason: { kind: 'error', error: { code: 'PROVIDER_UNAVAILABLE', message } },
        },
      }),
    ).toEqual({
      type: 'turn.ended',
      sessionId: 's1',
      turn: 4,
      reason: 'error',
      failure: { code: 'PROVIDER_UNAVAILABLE', message },
    })
  })

  it('uses replayed tool-result text instead of rendering a structured error identity as JSON', () => {
    const mapped = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      autoReviewDenialContract: true,
      data: {
        callId: 'call-structured-error',
        error: { name: 'AttachmentError', code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-structured-error',
              isError: true,
              content: [{ type: 'text', text: 'The selected DSH model does not support image input.' }],
            },
          ],
        },
      },
    })

    expect(mapped).toMatchObject({
      type: 'tool.updated',
      tool: {
        id: 'call-structured-error',
        status: 'failed',
        error: 'The selected DSH model does not support image input.',
      },
    })
    expect(JSON.stringify(mapped)).not.toContain('AttachmentError')
  })

  it('projects only the exact Auto review denial from the matching error result block', () => {
    const mapped = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      autoReviewDenialContract: true,
      data: {
        callId: 'call-auto-review-denied',
        name: 'shell',
        error: {
          name: 'AutoReviewDeniedError',
          code: 'AUTO_REVIEW_DENIED',
          reason: '  blocked by scope\nrequest review  ',
        },
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-auto-review-denied',
              isError: true,
              content: [{ type: 'text', text: 'ordinary tool failure text' }],
            },
          ],
        },
      },
    })

    expect(mapped).toMatchObject({
      type: 'tool.updated',
      tool: {
        id: 'call-auto-review-denied',
        status: 'failed',
        autoReviewDenial: { reason: '  blocked by scope\nrequest review  ' },
      },
    })
  })

  it('leaves the RC6 and pre-alpha.2 shared path on ordinary error semantics', () => {
    const mapped = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      data: {
        callId: 'call-auto-review-unversioned',
        error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' },
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-auto-review-unversioned',
              isError: true,
              content: [],
            },
          ],
        },
      },
    })

    expect(mapped).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-auto-review-unversioned', status: 'failed' },
    })
    expect(mapped).not.toHaveProperty('tool.autoReviewDenial')
  })

  it('keeps ordinary tool failures separate and never reads denial markers from error prose', () => {
    const ordinaryFailure = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      autoReviewDenialContract: true,
      data: {
        callId: 'call-ordinary-failure',
        error: { name: 'ToolExecutionError', code: 'TOOL_FAILED' },
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-ordinary-failure',
              isError: true,
              content: [{ type: 'text', text: 'AutoReviewDeniedError AUTO_REVIEW_DENIED' }],
            },
          ],
        },
      },
    })
    const nonErrorResult = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      autoReviewDenialContract: true,
      data: {
        callId: 'call-non-error-denial',
        error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' },
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-non-error-denial',
              isError: false,
            },
          ],
        },
      },
    })

    expect(ordinaryFailure).toMatchObject({
      type: 'tool.updated',
      tool: {
        id: 'call-ordinary-failure',
        status: 'failed',
        error: 'AutoReviewDeniedError AUTO_REVIEW_DENIED',
      },
    })
    expect(ordinaryFailure).not.toHaveProperty('tool.autoReviewDenial')
    expect(nonErrorResult).not.toHaveProperty('tool.autoReviewDenial')
  })

  it('keeps an exact denial without a malformed non-string reason', () => {
    const mapped = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      autoReviewDenialContract: true,
      data: {
        callId: 'call-auto-review-malformed-reason',
        error: {
          name: 'AutoReviewDeniedError',
          code: 'AUTO_REVIEW_DENIED',
          reason: { unexpected: 'object' },
        },
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-auto-review-malformed-reason',
              isError: true,
              content: [],
            },
          ],
        },
      },
    })

    expect(mapped).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-auto-review-malformed-reason', status: 'failed', autoReviewDenial: {} },
    })
    expect(mapped).not.toHaveProperty('tool.autoReviewDenial.reason')
  })

  it('keeps a failed tool result whose error text is longer than 4096 characters', () => {
    // A failed call's text is host-authored and unbounded: a `tools/post-execute`
    // block carries its feedback content verbatim (`hooks-codex` /
    // `hooks-claude-code` pass the external hook's own reason through), and the
    // reference client renders the flattened result text whole — the collapsed
    // error row's summary is its first line. Clipping here leaves the row's
    // error section showing a sentence chopped mid-line with nothing on screen
    // naming the loss.
    const text = `blocked by PostToolUse hook: lint failed\n${'src/feature.ts:12:5 no-unused-vars\n'.repeat(200)}`
    expect(text.length).toBeGreaterThan(4_096)

    const mapped = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      data: {
        callId: 'call-blocked',
        name: 'write',
        error: { name: 'PostToolUseBlocked', code: 'TOOL_BLOCKED' },
        message: {
          source: { kind: 'tool', callId: 'call-blocked' },
          role: 'user',
          id: 'message-blocked',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-blocked',
              isError: true,
              content: [{ type: 'text', text }],
            },
          ],
        },
      },
    })

    expect(mapped).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-blocked', status: 'failed', error: text },
    })
  })

  it('projects the pinned upstream image attachment reference without leaking image bytes', () => {
    const attachment = {
      attachmentId: 'fixture:image',
      mediaType: 'image/png',
      bytes: 247,
      width: 160,
      height: 90,
      name: 'fixture-image.png',
    }
    const user = rc6Mapper.event('user/message', {
      sessionId: 's1',
      message: {
        id: 'user-73',
        content: [
          { type: 'image', attachment },
          { type: 'text', text: '历史用户图片' },
        ],
      },
    })
    const assistant = rc6Mapper.event('assistant/message', {
      sessionId: 's1',
      data: {
        turn: 73,
        step: 0,
        message: {
          id: 'assistant-73',
          content: [
            { type: 'text', text: '结构化模型图片：' },
            { type: 'image', attachment },
          ],
        },
      },
    })

    expect(user).toMatchObject({
      type: 'message.user',
      markdown: '历史用户图片',
      images: [attachment],
    })
    expect(assistant).toMatchObject({
      type: 'message.completed',
      markdown: '结构化模型图片：',
      images: [attachment],
    })
    expect(JSON.stringify(user)).not.toContain('iVBOR')
    expect(JSON.stringify(assistant)).not.toContain('iVBOR')
  })

  it('projects structured session references as bounded labels without leaking capture details', () => {
    const event = rc6Mapper.event('user/message', {
      sessionId: 's1',
      message: {
        id: 'user-reference-1',
        source: {
          kind: 'session-reference',
          form: 'recall',
          version: 1,
          references: [
            {
              sessionId: 'source-session-1',
              label: 'Earlier debugging',
              capturedThroughSeq: 17,
              originalMessages: 12,
              retainedMessages: 8,
              omittedMessages: 4,
              omittedBytes: 512,
              truncated: true,
            },
          ],
        },
        content: [{ type: 'text', text: '继续检查 @Earlier debugging' }],
      },
    })

    expect(event).toEqual({
      type: 'message.user',
      sessionId: 's1',
      messageId: 'user-reference-1',
      markdown: '继续检查 @Earlier debugging',
      source: 'session-reference',
      sourceForm: 'recall',
      sessionReferenceLabels: ['Earlier debugging'],
    })
    expect(JSON.stringify(event)).not.toContain('capturedThroughSeq')
    expect(JSON.stringify(event)).not.toContain('source-session-1')
  })

  it('fails closed on malformed structured session references', () => {
    for (const references of [
      'not-an-array',
      [{ label: 'missing session id' }],
      [{ sessionId: 'source-session-1', label: '' }],
    ]) {
      expect(() =>
        rc6Mapper.event('user/message', {
          sessionId: 's1',
          message: {
            id: 'user-reference-invalid',
            source: { kind: 'session-reference', references },
            content: [{ type: 'text', text: 'context' }],
          },
        }),
      ).toThrow(/Malformed session-reference/)
    }
  })

  it('preserves the durable assistant message id used by feedback mutations', () => {
    expect(
      rc6Mapper.event('assistant/message', {
        sessionId: 's1',
        data: {
          turn: 1,
          step: 1,
          message: { id: 'assistant-message-real-1', content: [{ type: 'text', text: 'Hi' }] },
        },
      }),
    ).toMatchObject({ type: 'message.completed', messageId: 'assistant-message-real-1' })
  })

  it('projects adapter-owned text file blocks as compact user attachment metadata', () => {
    expect(
      rc6Mapper.event('user/message', {
        sessionId: 's1',
        data: {
          message: {
            id: 'user-1',
            content: [
              { type: 'text', text: '概括文件内容' },
              {
                type: 'text',
                text: '\n\nAttached file: 思路4.md\n\n# 很长的正文\n\nEnd of attached file: 思路4.md',
              },
            ],
          },
        },
      }),
    ).toEqual({
      type: 'message.user',
      sessionId: 's1',
      messageId: 'user-1',
      markdown: '概括文件内容',
      attachments: [{ name: '思路4.md' }],
    })
  })

  it('keeps a durable file part visible instead of dropping the message content', () => {
    // 0.1.6-alpha.1 admits real `file` parts beside text and images; their
    // bytes stay host-side. A file-only message carries no text at all, so an
    // unprojected block would render as an empty user bubble.
    expect(
      rc6Mapper.event('user/message', {
        sessionId: 's1',
        message: {
          id: 'user-file-1',
          content: [{ type: 'file', attachment: { attachmentId: 'file-1', name: 'spec.md', bytes: 2048 } }],
        },
      }),
    ).toEqual({
      type: 'message.user',
      sessionId: 's1',
      messageId: 'user-file-1',
      markdown: '',
      attachments: [{ name: 'spec.md' }],
    })
  })

  it('keeps one clear permission result for a command lifecycle pair', () => {
    expect(
      rc6Mapper.event('command/run', {
        sessionId: 's1',
        commandId: 'command-1',
        name: 'permission',
        args: ' danger-full-access',
      }),
    ).toMatchObject({
      type: 'notice',
      text: 'permission started.',
      commandName: 'permission',
      commandId: 'command-1',
      commandPhase: 'run',
      commandInput: '/permission danger-full-access',
    })
    expect(
      rc6Mapper.event('command/done', {
        sessionId: 's1',
        commandId: 'command-1',
        kind: 'success',
        text: 'preset danger-full-access',
      }),
    ).toMatchObject({
      type: 'notice',
      commandId: 'command-1',
      commandPhase: 'done',
      text: 'Permission changed to Full access.',
    })
  })

  it('keeps a slash-command line longer than 4096 characters', () => {
    // `command/run` records the parser's `args` — the raw text after the
    // command name, straight from the line the user submitted — with no length
    // bound (`parseCommand` slices the remainder of the line). The transcript
    // row this becomes is the record of what ran, so a clip here hides the tail
    // of the user's own command from the transcript and from an export.
    // `parseCommand` keeps the separator space, so the recorded `args` starts
    // with one and the reconstructed line has a single space after the name.
    const args = ` ${'a long goal description '.repeat(240)}`.trimEnd()
    const event = rc6Mapper.event('command/run', {
      sessionId: 's1',
      commandId: 'command-long',
      name: 'goal',
      args,
    })
    expect(args.length).toBeGreaterThan(4_096)
    expect(event).toMatchObject({
      type: 'notice',
      commandName: 'goal',
      commandPhase: 'run',
      commandInput: `/goal${args}`,
    })
  })

  it('maps model retries and compaction accounting to structured events', () => {
    expect(
      rc6Mapper.event('llm/retry', {
        sessionId: 's1',
        retryId: 'retry-1',
        turn: 1,
        step: 2,
        provider: 'deepseek',
        mode: 'normal',
        policyKey: 'deepseek-normal',
        retry: 2,
        maxRetries: 3,
        delayMs: 4_000,
        failure: { code: 'RATE_LIMIT', message: 'rate limited' },
      }),
    ).toEqual({
      type: 'model.retry',
      retry: {
        sessionId: 's1',
        id: 'retry-1',
        turn: 1,
        step: 2,
        attempt: 2,
        state: 'scheduled',
        delayMs: 4_000,
        maxRetries: 3,
        message: 'rate limited',
      },
    })
    expect(
      rc6Mapper.event('llm/retry-started', {
        sessionId: 's1',
        retryId: 'retry-1',
        turn: 1,
        step: 2,
        retry: 2,
      }),
    ).toEqual({
      type: 'model.retry',
      retry: {
        sessionId: 's1',
        id: 'retry-1',
        turn: 1,
        step: 2,
        attempt: 2,
        state: 'started',
      },
    })
    expect(
      rc6Mapper.event('compaction/summary', {
        sessionId: 's1',
        compactionId: 'c1',
        summary: [{ type: 'text', text: 'Condensed context' }],
        shadowedRange: { start: 1, end: 12 },
        shadowedSeqs: [1, 3, 5],
        shadowedTokenCount: 8_400,
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
    ).toEqual({
      type: 'compaction.updated',
      sessionId: 's1',
      compaction: {
        id: 'c1',
        phase: 'summary',
        summary: 'Condensed context',
        replacedCount: 3,
        estimatedTokens: 8_400,
      },
    })
    expect(
      rc6Mapper.event('compaction/prune', {
        sessionId: 's1',
        shadowedRange: { start: 14, end: 14 },
        shadowedSeqs: [14],
        shadowedTokenCount: 900,
      }),
    ).toMatchObject({
      type: 'compaction.updated',
      compaction: { id: 'prune:14', phase: 'prune', replacedCount: 1, estimatedTokens: 900 },
    })
    expect(() =>
      rc6Mapper.event('llm/retry', {
        sessionId: 's1',
        retryId: 'retry-invalid',
        turn: 1,
        step: 2,
        retry: 1,
      }),
    ).toThrow(/Malformed retry provider/)
    expect(() =>
      rc6Mapper.event('llm/retry-started', {
        sessionId: 's1',
        retryId: 'retry-invalid',
        turn: '1',
        step: 2,
        retry: 1,
      }),
    ).toThrow(/Malformed retry turn/)
  })

  it('keeps distinct prune rows apart when a prune carries no shadowed range', () => {
    // The timeline reducer keys compaction nodes by this id, so a fallback that
    // resolves to one shared label collapses every pruned range into a single
    // row. A prune without a usable shadowedSeqs list must still identify
    // itself, and the event's own durable sequence is what distinguishes it.
    const events = [
      rc6Mapper.event('compaction/prune', { sessionId: 's1', seq: 14, data: {} }),
      rc6Mapper.event('compaction/prune', { sessionId: 's1', seq: 41, data: { shadowedTokenCount: 700 } }),
      rc6Mapper.event('compaction/prune', { sessionId: 's1', seq: 42, data: { shadowedSeqs: [] } }),
    ]
    const ids = events.map((event) => {
      if (event.type !== 'compaction.updated') throw new Error('expected a compaction update')
      return event.compaction.id
    })

    expect(ids).toEqual(['prune:14', 'prune:41', 'prune:42'])
    expect(new Set(ids).size).toBe(3)
  })

  it('maps the rc.6 session projection, history, queue, jobs, and question correlation', () => {
    expect(
      rc6Mapper.sessionSummary({
        sessionId: 's1',
        updatedAt: 1_700_000_000_000,
        running: false,
        blank: false,
        projections: { values: { title: 'Actual title' } },
      }),
    ).toMatchObject({ id: 's1', title: 'Actual title', status: 'idle' })
    expect(
      rc6Mapper.sessionSummary({
        sessionId: 'session-generated',
        updatedAt: 1_700_000_000_000,
        running: false,
        blank: true,
      }),
    ).toMatchObject({ title: 'New Session', status: 'idle' })
    expect(
      rc6Mapper.sessionSummary({
        sessionId: 'child-1',
        updatedAt: 1_700_000_000_000,
        running: false,
        blank: false,
        parentSessionId: 's1',
        origin: 'subagent',
        projections: { values: { title: 'Inspect the project layout' } },
      }),
    ).toMatchObject({
      id: 'child-1',
      title: 'Inspect the project layout',
      parentSessionId: 's1',
      origin: 'subagent',
    })
    expect(
      rc6Mapper.workspace({
        workspaceId: 'w1',
        title: 'WebCraft',
        path: 'D:/workspace/WebCraft',
        sessionIds: ['s1'],
        createdAt: 1_700_000_000_000,
      }),
    ).toMatchObject({ id: 'w1', sessionIds: ['s1'], sessionCount: 1 })
    const history = rc6Mapper.history(
      {
        events: [
          {
            event: {
              type: 'user/message',
              seq: 4,
              time: '2026-01-01T00:00:00.000Z',
              data: {
                id: 'm1',
                role: 'user',
                content: [{ type: 'text', text: 'Hello' }],
                source: { kind: 'user' },
              },
            },
          },
        ],
        hasMore: false,
      },
      's1',
    )
    expect(history.events[0]?.event).toMatchObject({
      type: 'message.user',
      messageId: 'm1',
      markdown: 'Hello',
    })
    const malformed = rc6Mapper.history(
      {
        events: [
          {
            event: {
              type: 'assistant/message',
              seq: 5,
              time: '2026-01-01T00:00:01.000Z',
              data: { turn: 1, step: 1, markdown: 'not canonical' },
            },
          },
        ],
        hasMore: false,
      },
      's1',
    )
    expect(malformed.events[0]?.event).toMatchObject({ type: 'unknown', name: 'assistant/message' })
    expect(
      rc6Mapper.event('question/requested', {
        rpcId: 'rpc-question',
        sessionId: 's1',
        questions: [{ id: 'q1', question: 'Choose', options: [{ label: 'Allow' }] }],
      }),
    ).toMatchObject({
      type: 'question.requested',
      question: { id: 'q1', rpcId: 'rpc-question', choices: [{ id: 'Allow', label: 'Allow' }] },
    })
    expect(
      rc6Mapper.event('question/requested', {
        rpcId: 'rpc-plan',
        sessionId: 's1',
        questions: [
          {
            id: 'q-plan',
            question: 'Proceed with this plan?',
            header: 'Refactor',
            detail: '1. Do it',
            options: [
              { label: 'Approve', description: 'Run the plan now' },
              { label: 'Decline', description: 'Stop here' },
            ],
            intent: { kind: 'plan-review', approve: 'Approve' },
          },
          { id: 'q-extra', question: 'Notify?', multiSelect: true },
        ],
      }),
    ).toMatchObject({
      type: 'question.requested',
      question: {
        id: 'q-plan',
        rpcId: 'rpc-plan',
        items: [
          {
            id: 'q-plan',
            prompt: 'Proceed with this plan?',
            header: 'Refactor',
            detail: '1. Do it',
            choices: [
              { id: 'Approve', label: 'Approve', description: 'Run the plan now' },
              { id: 'Decline', label: 'Decline', description: 'Stop here' },
            ],
            intent: { kind: 'plan-review', approve: 'Approve' },
          },
          { id: 'q-extra', prompt: 'Notify?', multiSelect: true },
        ],
      },
    })
    expect(() => rc6Mapper.event('question/requested', { rpcId: 'rpc-missing', sessionId: 's1' })).toThrow(
      /Malformed question\/requested questions/,
    )
    expect(() =>
      rc6Mapper.event('question/requested', {
        rpcId: 'rpc-empty',
        sessionId: 's1',
        questions: [],
      }),
    ).toThrow(/Malformed question\/requested questions/)
    expect(() =>
      rc6Mapper.event('question/requested', {
        rpcId: 'rpc-item',
        sessionId: 's1',
        questions: [{ id: 'q1' }],
      }),
    ).toThrow(/Malformed question id or question/)
    expect(() =>
      rc6Mapper.event('question/requested', {
        rpcId: 'rpc-options',
        sessionId: 's1',
        questions: [{ id: 'q1', question: 'Pick', options: [{}] }],
      }),
    ).toThrow(/Malformed question option label/)
    expect(() =>
      rc6Mapper.event('question/requested', {
        rpcId: 'rpc-intent',
        sessionId: 's1',
        questions: [{ id: 'q1', question: 'Pick', intent: { kind: 'future-tag' } }],
      }),
    ).toThrow(/Malformed question intent/)
    expect(
      rc6Mapper.event('session/jobs', {
        sessionId: 's1',
        jobs: [
          {
            id: 'job-1',
            kind: 'bash',
            label: 'build',
            status: 'stopping',
            detail: 'signal pending',
            startedAt: 1,
            finishedAt: 2,
          },
        ],
      }),
    ).toEqual({
      type: 'jobs.updated',
      sessionId: 's1',
      jobs: [
        {
          id: 'job-1',
          kind: 'bash',
          label: 'build',
          status: 'stopping',
          detail: 'signal pending',
          startedAt: 1,
          finishedAt: 2,
        },
      ],
    })
    expect(() =>
      rc6Mapper.event('session/jobs', {
        sessionId: 's1',
        jobs: [{ id: 'job-1', label: 'build', status: 'cancelled', startedAt: 1 }],
      }),
    ).toThrow(/Malformed job/)
    expect(() => rc6Mapper.event('session/jobs', { sessionId: 's1', jobs: {} })).toThrow(
      /Malformed session\/jobs jobs/,
    )
    expect(
      rc6Mapper.event('tool-workflow/run-start', {
        sessionId: 's1',
        data: { runId: 'run-1', name: 'audit' },
      }),
    ).toEqual({
      type: 'workflow.started',
      sessionId: 's1',
      workflow: {
        id: 'run-1',
        sessionId: 's1',
        name: 'audit',
        status: 'running',
        stages: [],
      },
    })
    expect(
      rc6Mapper.event('tool-workflow/agent-start', {
        sessionId: 's1',
        data: { runId: 'run-1', seq: 1, label: '', phase: '', childId: 'child-1' },
      }),
    ).toMatchObject({
      type: 'workflow.member.started',
      runId: 'run-1',
      phase: '',
      member: { seq: 1, label: '', childId: 'child-1', status: 'running' },
    })
    expect(
      rc6Mapper.event('tool-workflow/agent-end', {
        sessionId: 's1',
        data: { runId: 'run-1', seq: 1, outcome: 'failed' },
      }),
    ).toMatchObject({ type: 'workflow.member.ended', runId: 'run-1', seq: 1, outcome: 'failed' })
    expect(
      rc6Mapper.event('tool-workflow/run-end', {
        sessionId: 's1',
        data: { runId: 'run-1', stopReason: 'error' },
      }),
    ).toMatchObject({ type: 'workflow.ended', runId: 'run-1', stopReason: 'error' })
    expect(
      rc6Mapper.event('session/queue', {
        sessionId: 's1',
        items: [
          {
            id: 'queued-1',
            placement: 'steering',
            message: {
              id: 'queued-message-1',
              role: 'user',
              content: [
                { type: 'text', text: 'Steer' },
                {
                  type: 'image',
                  attachment: {
                    attachmentId: 'image-1',
                    mediaType: 'image/png',
                    bytes: 4,
                    width: 2,
                    height: 2,
                    name: 'diagram.png',
                  },
                },
              ],
              source: { kind: 'user' },
            },
          },
        ],
      }),
    ).toMatchObject({
      type: 'queue.updated',
      items: [
        {
          id: 'queued-1',
          mode: 'steer',
          text: 'Steer',
          images: [
            {
              attachmentId: 'image-1',
              mediaType: 'image/png',
              bytes: 4,
              width: 2,
              height: 2,
              name: 'diagram.png',
            },
          ],
        },
      ],
    })
  })

  it('projects an inlined queued text file as a file chip instead of pasting its body into the row', () => {
    // A queued prompt with a text-file attachment carries the adapter's
    // "Attached file: …" envelope as a text block. Rendering that block as the
    // row's text shows the whole file body and, because the row is then
    // all-text, offers an edit that replaces the file with its own bytes.
    expect(
      rc6Mapper.event('session/queue', {
        sessionId: 's1',
        items: [
          {
            id: 'queued-file-1',
            placement: 'queued',
            rpcId: 'rpc-queued-file-1',
            createdAt: '2026-09-16T00:00:00.000Z',
            message: {
              id: 'queued-message-file-1',
              role: 'user',
              content: [
                { type: 'text', text: '概括文件内容' },
                {
                  type: 'text',
                  text: '\n\nAttached file: 思路4.md\n\n# 很长的正文\n\nEnd of attached file: 思路4.md',
                },
              ],
              source: { kind: 'user', rpcId: 'rpc-queued-file-1' },
            },
          },
        ],
      }),
    ).toEqual({
      type: 'queue.updated',
      sessionId: 's1',
      items: [
        {
          id: 'queued-file-1',
          sessionId: 's1',
          text: '概括文件内容',
          attachments: [],
          files: ['思路4.md'],
          textOnly: false,
          mode: 'queue',
          createdAt: '2026-09-16T00:00:00.000Z',
          rpcId: 'rpc-queued-file-1',
        },
      ],
    })
  })

  it('does not synthesize history sequence or time when those fields are explicitly malformed', () => {
    for (const event of [
      { type: 'turn/start', seq: '1', time: 1 },
      { type: 'turn/start', seq: 1, time: null },
      { type: 'turn/start', seq: 1, time: Number.MAX_VALUE },
    ]) {
      expect(() => rc6Mapper.history({ events: [{ event }], hasMore: false }, 's1')).toThrow(
        /Malformed session history (sequence|time)/,
      )
    }
  })

  it('keeps a model-only surface replacement out of the human transcript', () => {
    // A compaction appends a replacement copy that shadows the compacted range
    // instead of entering the surface at its own position. Its content is the
    // summary the model reads, never words the user wrote, so the row must not
    // become a user/assistant/tool record — while its durable sequence still
    // has to reach the client so the live watermark does not see a hole.
    const replacement = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      type: 'user/message',
      seq: 6,
      time: '2026-01-01T00:00:02.000Z',
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 },
      data: {
        id: 'compaction-checkpoint',
        role: 'user',
        content: [{ type: 'text', text: 'Summary of the shadowed range.' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
      },
      ...overrides,
    })
    const page = rc6Mapper.history({ events: [{ event: replacement({}) }], hasMore: false }, 's1')
    expect(page.events).toEqual([])
    const markers = rc6Mapper.history({ events: [{ event: replacement({}) }], hasMore: false }, 's1', {
      includeSystemMarkers: true,
    })
    expect(markers.events.map((entry) => [entry.sequence, entry.event.type])).toEqual([[6, 'session.system']])
    expect(markers.events[0]?.event).not.toHaveProperty('payload')
    expect(rc6Mapper.event('user/message', { ...replacement({}), sessionId: 's1' })).toEqual({
      type: 'session.system',
      sessionId: 's1',
    })
    // The alpha wire spells the shadowed span `startSeq`/`endSeq`, the older
    // one `start`/`end`; both mark the same model-only copy.
    expect(
      rc6Mapper.event('assistant/message', {
        sessionId: 's1',
        surfaceOp: { op: 'replace', start: 1, end: 2 },
        data: {
          turn: 1,
          step: 1,
          message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'restated' }] },
        },
      }),
    ).toEqual({ type: 'session.system', sessionId: 's1' })
    expect(
      rc6Mapper.event('tool/result', {
        sessionId: 's1',
        surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
        data: { callId: 'call-1', name: 'read', status: 'completed', result: 'restated' },
      }),
    ).toEqual({ type: 'session.system', sessionId: 's1' })
    // An append-origin message keeps its ordinary transcript mapping.
    expect(
      rc6Mapper.event('user/message', {
        ...replacement({ surfaceOp: 'append' }),
        sessionId: 's1',
      }),
    ).toMatchObject({ type: 'message.user', markdown: 'Summary of the shadowed range.' })
  })

  it('answers a pending question with the server rpc id and option label only once', async () => {
    const responses: { readonly rpcId: string; readonly value: unknown }[] = []
    const repository = new Rc6InteractionRepository({
      ...transport({ result: { ok: true, value: {} } }),
      respondEnvelope: (rpcId, result) => {
        responses.push({ rpcId, value: result })
        return Promise.resolve({ accepted: true })
      },
    })
    repository.remember({
      type: 'question.requested',
      question: {
        id: 'q1',
        rpcId: 'rpc-question',
        sessionId: 's1',
        prompt: 'Choose',
        choices: [{ id: 'Allow', label: 'Allow' }],
        allowFreeText: false,
      },
    })
    await repository.respondToQuestion('q1', ['Allow'])
    await repository.respondToQuestion('q1', ['Allow'])
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      rpcId: 'rpc-question',
      value: {
        ok: true,
        value: { sessionId: 's1', answer: { answers: [{ id: 'q1', selected: ['Allow'] }] } },
      },
    })
  })

  it('answers a pending permission using the stored option semantics', async () => {
    const responses: { readonly rpcId: string; readonly value: unknown }[] = []
    const repository = new Rc6InteractionRepository({
      ...transport({ result: { ok: true, value: {} } }),
      respondEnvelope: (rpcId, result) => {
        responses.push({ rpcId, value: result })
        return Promise.resolve({ accepted: true })
      },
    })
    repository.remember({
      type: 'permission.requested',
      request: {
        id: 'approval-1',
        rpcId: 'rpc-approval',
        sessionId: 's1',
        title: 'Run command',
        description: 'The command needs approval.',
        risk: 'medium',
        options: [
          { id: 'allow-command', label: 'Allow command', kind: 'allow-once' },
          { id: 'deny-command', label: 'Deny command', kind: 'deny' },
        ],
      },
    })

    await repository.respondToPermission('approval-1', 'allow-command')
    await expect(repository.respondToPermission('approval-1', 'deny-command')).resolves.toBeUndefined()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      rpcId: 'rpc-approval',
      value: {
        ok: true,
        value: { sessionId: 's1', approvalId: 'approval-1', outcome: 'allowed-once' },
      },
    })
  })

  it('rejects an unknown permission option without responding to DSH', async () => {
    const responses: unknown[] = []
    const repository = new Rc6InteractionRepository({
      ...transport({ result: { ok: true, value: {} } }),
      respondEnvelope: (_rpcId, result) => {
        responses.push(result)
        return Promise.resolve({ accepted: true })
      },
    })
    repository.remember({
      type: 'permission.requested',
      request: {
        id: 'approval-2',
        rpcId: 'rpc-approval-2',
        sessionId: 's1',
        title: 'Run command',
        description: 'The command needs approval.',
        risk: 'medium',
        options: [{ id: 'allow-command', label: 'Allow command', kind: 'allow-once' }],
      },
    })

    await expect(repository.respondToPermission('approval-2', 'not-a-real-option')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(responses).toHaveLength(0)
  })

  it('validates success, error, and malformed response fixtures', async () => {
    await expect(
      callRpc(transport({ result: { ok: true, value: { version: '0.1.0-rc.6' } } }), 'host.describe', {}),
    ).resolves.toEqual({ version: '0.1.0-rc.6' })
    await expect(
      callRpc(
        transport({ result: { ok: false, error: { code: 'agent-busy', message: 'busy' } } }),
        'session.prompt',
        {},
      ),
    ).rejects.toMatchObject({ code: 'BACKEND_BUSY' })
    await expect(callRpc(transport({ result: { ok: true } }), 'session.list', {})).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('keeps an RPC failure detail longer than 320 characters', async () => {
    // The Connection RPC error envelope types `message` as an unbounded string
    // on the host side, and the official client shows the failure text the host
    // sent. This repository's own protocol budget for a host error message is
    // 1,024 characters, so an adapter-side cut at 320 drops the tail of the
    // host's only explanation on every failed route with nothing on screen
    // naming the loss.
    const detail = `Command rejected: ${'field "tools[3].description" is invalid; '.repeat(24)}`.trim()
    expect(detail.length).toBeGreaterThan(320)
    const failure = await callRpc(
      transport({ result: { ok: false, error: { code: 'command-error', message: detail } } }),
      'session.prompt',
      {},
    ).then(
      () => undefined,
      (error: unknown) => error as AppError,
    )
    expect(failure?.message).toContain(detail)
  })

  it('discovers and executes slash commands through the pinned Typert Remote contract', async () => {
    const calls: { readonly method: string; readonly params: unknown }[] = []
    const commandTransport: DshTransport = {
      ...transport({ result: { ok: true, value: [] } }),
      remoteRequest: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve(
          (method === 'commands/list'
            ? { ok: true, value: [{ name: 'alpha', description: 'Alpha command' }] }
            : {
                ok: true,
                value: { commandId: 'command-1', result: { kind: 'success' } },
              }) as TResponse,
        )
      },
    }
    const repository = new Rc6CommandRepository(commandTransport)
    await expect(repository.list('session-1')).resolves.toEqual([
      { name: 'alpha', description: 'Alpha command' },
    ])
    await repository.execute('session-1', '/alpha value')
    expect(calls).toEqual([
      {
        method: 'commands/list',
        params: { agentId: 'session-1' },
      },
      {
        method: 'commands/execute',
        params: { agentId: 'session-1', line: '/alpha value' },
      },
    ])
  })

  it('refuses an attachment on a host whose commands/execute declares no attachment parameter', async () => {
    // 0.1.0-rc.7 and older take only `(agent, line)`. The descriptor rejects an
    // extra field outright, so an attachment that cannot travel has to fail
    // before the request leaves the Host.
    const calls: { readonly method: string; readonly params: unknown }[] = []
    const commandTransport: DshTransport = {
      ...transport({ result: { ok: true, value: [] } }),
      remoteRequest: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve({ ok: true, value: [] } as TResponse)
      },
    }
    await expect(
      new Rc6CommandRepository(commandTransport).execute('session-1', '/goal inspect', [
        { uri: 'data:image/png;base64,AQ==', name: 'diagram.png', mimeType: 'image/png' },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(calls).toEqual([])
  })

  it('does not request a command directory without an active session', async () => {
    await expect(
      new Rc6CommandRepository(transport({ result: { ok: true, value: [] } })).list(),
    ).resolves.toEqual([])
  })

  it('reports an unmatched slash line as unknown instead of failing the submission', async () => {
    // The host resolves `commands/execute` only against its command directory
    // and answers an ok envelope without a value for every other line (its
    // Remote signature resolves to `CommandExecution | undefined`, and JSON has
    // no way to carry the `undefined`). A user-invocable skill is addressed
    // exactly like that (`/skill-name args`), so the absence has to reach the
    // caller: it decides between a skill prompt gesture and plain text, while
    // the adapter itself never sends a model prompt.
    const calls: { readonly method: string; readonly params: unknown }[] = []
    const commandTransport: DshTransport = {
      ...transport({ result: { ok: true } }),
      remoteRequest: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve({ ok: true } as TResponse)
      },
    }
    await expect(
      new Rc6CommandRepository(commandTransport).execute('session-1', '/dsh-badge'),
    ).resolves.toEqual({
      kind: 'unknown',
    })
    expect(calls).toEqual([
      { method: 'commands/execute', params: { agentId: 'session-1', line: '/dsh-badge' } },
    ])
  })

  it('keeps an absent value a protocol error for a value-returning Remote caller', async () => {
    const commandTransport: DshTransport = {
      ...transport({ result: { ok: true } }),
      remoteRequest: <TResponse>() => Promise.resolve({ ok: true } as TResponse),
    }
    await expect(new Rc6CommandRepository(commandTransport).list('session-1')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('keeps secrets and prompt bodies out of mapped unknown payloads', () => {
    const event = rc6Mapper.event('future/event', {
      apiKey: 'secret',
      prompt: 'private prompt',
      output: 'private output',
      safe: 'ok',
    })
    expect(JSON.stringify(event)).not.toContain('secret')
    expect(JSON.stringify(event)).not.toContain('private prompt')
    expect(JSON.stringify(event)).toContain('safe')
  })

  it('fails explicitly when the connected DSH version is unsupported', async () => {
    const candidate = {
      endpoint: { host: '127.0.0.1', port: 3939, baseUrl: 'http://127.0.0.1:3939' },
      ownership: 'external',
      capabilities: { protocolVersion: 'rc6', dshVersion: '0.1.0-rc.5', features: new Set<string>() },
    } as const
    await expect(new VersionedBackendFactory([]).connect(candidate)).rejects.toBeInstanceOf(AppError)
    await expect(new VersionedBackendFactory([]).connect(candidate)).rejects.toMatchObject({
      code: 'DSH_INCOMPATIBLE',
    })
  })
})

describe('rc6 queue frame degradation', () => {
  it('fails closed on a malformed session/queue frame instead of publishing an empty queue', () => {
    // A malformed frame mapped to `items: []` would make the session
    // repository wipe the queue and every queue-owner entry while the host
    // still holds the items, turning later update/remove/steer calls into
    // STALE_INTERACTION. Degrade it like the session/jobs case instead: the
    // mapper throws, the stream frame becomes a redacted unknown event, and
    // the last known queue state survives.
    expect(() => rc6Mapper.event('session/queue', { sessionId: 's1', items: {} })).toThrow(
      /Malformed session\/queue items/,
    )
    expect(() => rc6Mapper.event('session/queue', { sessionId: 's1' })).toThrow(
      /Malformed session\/queue items/,
    )
  })

  it('rejects malformed host/session-added frames instead of dropping required fields', () => {
    expect(() => rc6Mapper.event('host/session-added', { sessionId: 's1' })).toThrow(
      'Malformed host/session-added',
    )
    expect(() =>
      rc6Mapper.event('host/session-added', { sessionId: 's1', blank: true, parentSessionId: '' }),
    ).toThrow('Malformed host/session-added')
    expect(() =>
      rc6Mapper.event('host/session-added', { sessionId: 's1', blank: true, origin: 'other' }),
    ).toThrow('Malformed host/session-added')
  })
})

describe('rc6 host snapshot frame degradation', () => {
  it('rejects malformed order and archive snapshots instead of filtering them into partial state', () => {
    expect(() => rc6Mapper.event('host/workspace-order-changed', { workspaceIds: ['w1', 3] })).toThrow(
      /Malformed workspace order/,
    )
    expect(() => rc6Mapper.event('host/archived-sessions-changed', { sessionIds: ['s1', ''] })).toThrow(
      /Malformed archived session ids/,
    )
    expect(() => rc6Mapper.event('host/workspace-order-changed', {})).toThrow(/Malformed workspace order/)
  })
})

describe('rc6 stateful frame degradation', () => {
  it('rejects malformed subscription and projection coordinates instead of manufacturing defaults', () => {
    expect(rc6Mapper.event('session/subscribed', { sessionId: 's1', lastSeq: -1 })).toMatchObject({
      type: 'session.subscribed',
      lastSequence: -1,
    })
    for (const value of [
      { sessionId: 's1', lastSeq: undefined },
      { sessionId: 's1', lastSeq: '2' },
      { sessionId: 's1', lastSeq: -2 },
      { lastSeq: 2 },
    ]) {
      expect(() => rc6Mapper.event('session/subscribed', value)).toThrow(
        /Malformed session\/subscribed lastSeq/,
      )
    }
    for (const value of [
      { sessionId: 's1', key: '', seq: 1, value: {} },
      { sessionId: 's1', key: 'goal', seq: '1', value: {} },
      { sessionId: 's1', key: 'goal', seq: -1, value: {} },
      { sessionId: 's1', key: 'goal', value: {} },
      { sessionId: 's1', key: 'goal', seq: 1 },
    ]) {
      expect(() => rc6Mapper.event('session/projection', value)).toThrow(/Malformed session\/projection/)
    }
  })

  it('keeps the approval pairing id the command is resolved through', () => {
    // `approval/requested` carries no command. DSH's own client reads it from
    // the running tool call the request is paired with by `callId`
    // (`ApprovalPanel` -> `commandOf(args.command)`), and a shell call card's
    // title IS the command. Dropping the pairing here leaves the approval card
    // asking the user to authorize a command it cannot show.
    expect(
      rc6Mapper.event('approval/requested', {
        sessionId: 's1',
        approvalId: 'approval-1',
        toolName: 'bash',
        callId: 'call-1',
        reason: 'The command writes outside the workspace.',
        displayReason: {
          en: 'Allow this command to modify workspace files?',
          zh: '允许此命令修改工作区文件吗？',
        },
      }),
    ).toEqual({
      type: 'permission.requested',
      request: {
        id: 'approval-1',
        sessionId: 's1',
        title: 'bash',
        description: 'The command writes outside the workspace.',
        displayReason: {
          en: 'Allow this command to modify workspace files?',
          zh: '允许此命令修改工作区文件吗？',
        },
        callId: 'call-1',
        risk: 'unknown',
        options: [
          { id: 'allowed-once', label: 'Allow once', kind: 'allow-once' },
          { id: 'rejected', label: 'Reject', kind: 'deny' },
        ],
      },
    })
  })

  it('rejects a malformed localized approval display reason', () => {
    // DSH 0.1.7-rc.2 at 477b4f420553e8a52c2fbccc464d7561b239c443 keeps
    // `displayReason` on the live approval request only; it requires an English
    // fallback and string values for every locale.
    for (const displayReason of [null, [], { zh: '需要审批' }, { en: 'Approval required', zh: 7 }]) {
      expect(() =>
        rc6Mapper.event('approval/requested', {
          sessionId: 's1',
          approvalId: 'approval-1',
          toolName: 'bash',
          displayReason,
        }),
      ).toThrow(/Malformed approval\/requested/)
    }
  })

  it('rejects malformed interaction and host notice frames instead of clearing or inventing state', () => {
    expect(() =>
      rc6Mapper.event('approval/requested', { sessionId: 's1', approvalId: '', toolName: 'shell' }),
    ).toThrow(/Malformed approval\/requested/)
    expect(() =>
      rc6Mapper.event('approval/requested', { sessionId: 's1', approvalId: 'a1', toolName: 1 }),
    ).toThrow(/Malformed approval\/requested/)
    expect(() =>
      rc6Mapper.event('approval/resolved', { sessionId: 's1', approvalId: 'a1', outcome: 'future' }),
    ).toThrow(/Malformed approval\/resolved/)
    expect(() => rc6Mapper.event('approval/resolved', { sessionId: 's1', outcome: 'rejected' })).toThrow(
      /Malformed approval\/resolved/,
    )
    expect(() =>
      rc6Mapper.event('question/resolved', { sessionId: 's1', questionRpcId: '', outcome: 'answered' }),
    ).toThrow(/Malformed question\/resolved/)
    expect(() =>
      rc6Mapper.event('question/resolved', { sessionId: 's1', questionRpcId: 'q1', outcome: 'future' }),
    ).toThrow(/Malformed question\/resolved/)
    expect(() => rc6Mapper.event('host/session-status', { sessionId: 's1' })).toThrow(
      /Malformed host\/session-status/,
    )
    expect(() => rc6Mapper.event('host/session-removed', {})).toThrow(/Malformed host\/session-removed/)
    expect(() => rc6Mapper.event('host/remote-event', { event: '', args: [] })).toThrow(
      /Malformed host\/remote-event/,
    )
    expect(() => rc6Mapper.event('host/remote-event', { event: 'safe', args: {} })).toThrow(
      /Malformed host\/remote-event/,
    )
    expect(() => rc6Mapper.event('host/agent-error', { sessionId: 's1' })).toThrow(
      /Malformed host\/agent-error/,
    )
  })

  it('keeps an agent-error chain longer than 512 characters', () => {
    // `host/agent-error` is the only outlet for a live failure with no turn
    // position, and the host sends its whole `errorChain` (e.g. `TypeError:
    // fetch failed` plus every cause). The notice row renders that text in
    // full, so clipping it would drop most of the user's only diagnosis for
    // the failure with nothing on screen to reveal the loss.
    const message =
      `TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:1 - ${'cause detail '.repeat(48)}`.trim()
    expect(message.length).toBeGreaterThan(512)
    expect(rc6Mapper.event('host/agent-error', { sessionId: 's1', message })).toEqual({
      type: 'notice',
      sessionId: 's1',
      level: 'error',
      text: message,
    })
  })
})

describe('rc6 todo frame degradation', () => {
  it('maps the whole-list snapshot and fails closed on malformed lists or entries', () => {
    expect(
      rc6Mapper.event('todo/write', {
        sessionId: 's1',
        todos: [
          { content: 'Inspect the contract', status: 'in_progress' },
          { content: 'Write the regression', status: 'pending' },
        ],
      }),
    ).toEqual({
      type: 'todo.updated',
      sessionId: 's1',
      todos: [
        { id: 'todo:0', content: 'Inspect the contract', status: 'in-progress' },
        { id: 'todo:1', content: 'Write the regression', status: 'pending' },
      ],
    })

    expect(() => rc6Mapper.event('todo/write', { sessionId: 's1' })).toThrow(/Malformed todo\/write todos/)
    expect(() => rc6Mapper.event('todo/write', { sessionId: 's1', todos: {} })).toThrow(
      /Malformed todo\/write todos/,
    )
    expect(() =>
      rc6Mapper.event('todo/write', {
        sessionId: 's1',
        todos: [{ status: 'pending' }],
      }),
    ).toThrow(/Malformed todo content/)
    expect(() =>
      rc6Mapper.event('todo/write', {
        sessionId: 's1',
        todos: [{ content: 'broken', status: 'future' }],
      }),
    ).toThrow(/Malformed todo status/)
  })
})
