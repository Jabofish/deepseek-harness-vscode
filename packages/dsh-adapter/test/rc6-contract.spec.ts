import { describe, expect, it } from 'vitest'
import type { RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendFactory } from '../src/backend-factory.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { Rc6CommandRepository } from '../src/repositories/command-repository.js'
import { Rc6InteractionRepository } from '../src/repositories/interaction-repository.js'

const rpcMethods = [
  'session.list',
  'session.search',
  'session.create',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.attachment',
  'session.updateQueue',
  'session.cancel',
  'subagent.list',
  'subagent.history',
  'subagent.prompt',
  'subagent.interrupt',
  'host.describe',
  'host.pickDirectory',
  'host.listDirectory',
  'host.createDirectory',
  'host.openPath',
  'workspace.list',
  'workspace.create',
  'workspace.rename',
  'workspace.delete',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'workspace.archiveSession',
  'skill.list',
  'agentPreset.list',
  'agentPreset.select',
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.providers',
  'llm.models',
  'llm.discoverModels',
] as const satisfies readonly (keyof RpcMethodMap)[]

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
  })

  it('maps official host and mux event families without parsing terminal output', () => {
    const mapped = [
      rc6Mapper.event('session/subscribed', { sessionId: 's1', lastSeq: 2 }),
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
    expect(mapped[4]).toEqual({
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

  it('maps the rc.6 session projection, history, queue, jobs, and question correlation', () => {
    expect(
      rc6Mapper.sessionSummary({
        sessionId: 's1',
        updatedAt: 1_700_000_000_000,
        running: false,
        blank: false,
        projections: { values: { title: 'Actual title' } },
      }),
    ).toMatchObject({ id: 's1', title: 'Actual title', status: 'completed' })
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
        path: 'D:/CS/WebCraft',
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
              data: { message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] } },
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
    // Unknown intent tags degrade to the generic flow (upstream contract:
    // a UI that does not know a tag renders the generic option list).
    const unknownIntent = rc6Mapper.event('question/requested', {
      rpcId: 'rpc-unknown-intent',
      sessionId: 's1',
      questions: [{ id: 'q9', question: 'Pick', intent: { kind: 'future-tag' } }],
    })
    expect(unknownIntent).toMatchObject({
      type: 'question.requested',
      question: { id: 'q9', items: [{ id: 'q9' }] },
    })
    expect(
      unknownIntent.type === 'question.requested' && unknownIntent.question.items?.[0]?.intent,
    ).toBeUndefined()
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
            message: { content: [{ type: 'text', text: 'Steer' }] },
          },
        ],
      }),
    ).toMatchObject({ type: 'queue.updated', items: [{ id: 'queued-1', mode: 'steer', text: 'Steer' }] })
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

  it('forwards validated image data for image-capable slash commands and retains error outcomes', async () => {
    const calls: { readonly method: string; readonly params: unknown }[] = []
    const commandTransport: DshTransport = {
      ...transport({ result: { ok: true, value: [] } }),
      remoteRequest: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve(
          (method === 'commands/execute'
            ? {
                ok: true,
                value: { commandId: 'command-2', result: { kind: 'error', text: 'needs more detail' } },
              }
            : { ok: true, value: [] }) as TResponse,
        )
      },
    }
    const repository = new Rc6CommandRepository(commandTransport)
    await expect(
      repository.execute('session-1', '/goal inspect', [
        { uri: 'data:image/png;base64,AQ==', name: 'diagram.png', mimeType: 'image/png' },
      ]),
    ).resolves.toEqual({ kind: 'error', text: 'needs more detail' })
    expect(calls[0]).toEqual({
      method: 'commands/execute',
      params: {
        agentId: 'session-1',
        line: '/goal inspect',
        images: [{ mediaType: 'image/png', data: 'AQ==', name: 'diagram.png' }],
      },
    })
  })

  it('does not request a command directory without an active session', async () => {
    await expect(
      new Rc6CommandRepository(transport({ result: { ok: true, value: [] } })).list(),
    ).resolves.toEqual([])
  })

  it('reports an unmatched slash command without sending a model prompt', async () => {
    await expect(
      new Rc6CommandRepository({
        ...transport({ result: { ok: true, value: undefined } }),
        remoteRequest: <TResponse>() => Promise.resolve({ ok: true, value: undefined } as TResponse),
      }).execute('session-1', '/not-registered'),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
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
