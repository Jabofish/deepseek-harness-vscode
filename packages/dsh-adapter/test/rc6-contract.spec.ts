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
      rc6Mapper.event('host/session-added', { sessionId: 's1', blank: true }),
      rc6Mapper.event('host/workspace-removed', { workspaceId: 'w1' }),
      rc6Mapper.event('host/remote-event', { event: 'safe', args: [] }),
    ]
    expect(mapped.every((event) => event.type !== 'unknown')).toBe(true)
    expect(
      rc6Mapper.event('assistant/chunk', {
        sessionId: 's1',
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { text: 'Hi' } },
      }),
    ).toMatchObject({ type: 'message.delta', delta: 'Hi' })
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
      rc6Mapper.event('session/jobs', {
        sessionId: 's1',
        jobs: [{ id: 'job-1', kind: 'bash', label: 'build', status: 'stopping', startedAt: 1 }],
      }),
    ).toMatchObject({ type: 'jobs.updated', jobs: [{ id: 'job-1', status: 'stopping' }] })
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

  it('dispatches slash commands through the pinned session.prompt contract', async () => {
    const calls: { readonly method: string; readonly params: unknown }[] = []
    const commandTransport: DshTransport = {
      ...transport({ result: { ok: true, value: [] } }),
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve({
          result: {
            ok: true,
            value: { accepted: true, command: { kind: 'success', text: 'done' } },
          },
        } as TResponse)
      },
    }
    const repository = new Rc6CommandRepository(commandTransport)
    await expect(repository.list('session-1')).resolves.toEqual([])
    await repository.execute('session-1', '/alpha value')
    expect(calls).toEqual([
      {
        method: 'session.prompt',
        params: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: '/alpha value' }] },
      },
    ])
  })

  it('does not invent a command directory when rc.6 has no list RPC', async () => {
    await expect(
      new Rc6CommandRepository(transport({ result: { ok: true, value: [] } })).list('session-1'),
    ).resolves.toEqual([])
  })

  it('rejects an undefined slash-command response as malformed', async () => {
    await expect(
      new Rc6CommandRepository(transport({ result: { ok: true, value: undefined } })).execute(
        'session-1',
        '/not-registered',
      ),
    ).rejects.toMatchObject({
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
