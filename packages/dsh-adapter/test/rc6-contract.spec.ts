import { describe, expect, it } from 'vitest'

import type { DshTransport } from '../src/contracts.js'

import { rc6Mapper } from '../src/versions/rc6/mapper.js'

import { Rc6InteractionRepository } from '../src/repositories/interaction-repository.js'

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

  it('projects late question replies as structured safe Q/A and never forwards the machine payload', () => {
    const event = rc6Mapper.event('user/message', {
      sessionId: 's1',
      message: {
        id: 'reply-1',
        source: { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'answer_to_pending_question',
              tool: 'ask_user_question',
              callId: 'call-1',
              questions: [
                {
                  id: 'scope',
                  question: 'Which scope?',
                  header: 'Scope',
                  options: [{ label: 'workspace', description: 'Current workspace only' }],
                  internalTrace: 'do-not-forward',
                },
              ],
              answers: [{ id: 'scope', selected: ['workspace'], custom: 'include tests' }],
            }),
          },
        ],
      },
    })

    expect(event).toMatchObject({
      type: 'message.user',
      markdown: '',
      source: 'user-question-reply',
      questionReply: {
        callId: 'call-1',
        questions: [
          {
            id: 'scope',
            prompt: 'Which scope?',
            header: 'Scope',
            choices: [{ id: 'workspace', label: 'workspace', description: 'Current workspace only' }],
          },
        ],
        answers: [{ id: 'scope', selected: ['workspace'], custom: 'include tests' }],
      },
    })
    expect(JSON.stringify(event)).not.toContain('answer_to_pending_question')
    expect(JSON.stringify(event)).not.toContain('do-not-forward')
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
})

describe('rc6 stateful frame degradation', () => {
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
