import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate, ConnectedBackend } from '@dsh-vscode/domain'

import {
  LegacyCommandRepository,
  LegacyRc1ExportRepository,
  LegacyRc1VersionAdapter,
  LegacyRc2VersionAdapter,
  LegacyRc5VersionAdapter,
  LegacyWorkspaceRepository,
  LoopbackApiClient,
  Rc02VersionAdapter,
  Rc03VersionAdapter,
  Rc6SessionRepository,
  Rc6SubagentRepository,
  createLegacyFrameParser,
  rc6Mapper,
} from '../src/index.js'
import type { DshTransport as AdapterTransport } from '../src/contracts.js'

const endpoint = { host: '127.0.0.1' as const, port: 4_393, baseUrl: 'http://127.0.0.1:4393' }
const candidate: BackendCandidate = { endpoint, source: 'configured', confidence: 100 }

const options = {
  requestTimeoutMs: 1_000,
  retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
  fetch: globalThis.fetch,
}

function connected(version: string, protocolVersion: string): ConnectedBackend {
  return {
    endpoint,
    ownership: 'external',
    capabilities: { protocolVersion, dshVersion: version, features: new Set() },
  }
}

function handshakeFetch(): typeof fetch {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = JSON.parse(await new Response(init?.body ?? null).text()) as { readonly rpcId?: string }
    return new Response(
      JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { version: '0.0.1', cwd: 'fixture', attachedSessions: 0 },
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
}

function successfulTransport(
  handler: (method: string, params: unknown) => unknown,
  calls: Array<{ readonly method: string; readonly params: unknown }>,
): AdapterTransport {
  return {
    request: <TResponse>(method: string, params: unknown) => {
      calls.push({ method, params })
      return Promise.resolve({ result: { ok: true, value: handler(method, params) } } as TResponse)
    },
    remoteRequest: <TResponse>() =>
      Promise.reject<TResponse>(new Error('remote is not part of this fixture')),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

describe('DSH 0.0.1 and 0.1.0 historical adapter contracts', () => {
  it('has one exact adapter for every npm-only historical release', async () => {
    const entries = [
      [new LegacyRc1VersionAdapter({ ...options, fetch: handshakeFetch() }), '0.0.1-rc.1', 'legacy-rc1'],
      [new LegacyRc2VersionAdapter({ ...options, fetch: handshakeFetch() }), '0.0.1-rc.2', 'legacy-rc2'],
      [new LegacyRc5VersionAdapter({ ...options, fetch: handshakeFetch() }), '0.0.1-rc.5', 'legacy-rc5'],
      [new Rc02VersionAdapter({ ...options, fetch: handshakeFetch() }), '0.1.0-rc.2', 'rc02'],
      [new Rc03VersionAdapter({ ...options, fetch: handshakeFetch() }), '0.1.0-rc.3', 'rc03'],
    ] as const

    for (const [adapter, version, protocolVersion] of entries) {
      await expect(adapter.probe({ ...candidate, runtimeVersion: version })).resolves.toMatchObject({
        adapterId: `dsh-${version}`,
        dshVersion: version,
        protocolVersion,
        compatibilityMode: 'exact',
      })
      expect(adapter.fallback).toBe(false)
      for (const [, otherVersion] of entries) {
        if (otherVersion === version) continue
        await expect(adapter.probe({ ...candidate, runtimeVersion: otherVersion })).resolves.toBeUndefined()
      }
    }
  })

  it('uses the pre-Remote command.* endpoints without applying the current Remote shape', async () => {
    const calls: Array<{ readonly method: string; readonly payload: Record<string, unknown> }> = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(await new Response(init?.body ?? null).text()) as {
        readonly rpcId: string
        readonly method: string
        readonly payload: Record<string, unknown>
      }
      calls.push({ method: request.method, payload: request.payload })
      const value =
        request.method === 'command.list'
          ? { commands: [{ name: 'plan', description: 'Toggle plan mode', input: { hint: 'on or off' } }] }
          : { matched: request.payload.line === '/plan', commandId: 'legacy-command-1' }
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: { ok: true, value },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const client = new LoopbackApiClient({ ...options, fetch, endpoint })
    const repository = new LegacyCommandRepository(client)

    await expect(repository.list('session-1')).resolves.toEqual([
      { name: 'plan', description: 'Toggle plan mode', input: { hint: 'on or off' } },
    ])
    await expect(repository.execute('session-1', '/plan')).resolves.toEqual({ kind: 'success' })
    await expect(repository.execute('session-1', '/missing')).resolves.toEqual({
      kind: 'error',
      text: 'The DSH slash command was not found in this session.',
    })
    expect(calls).toEqual([
      { method: 'command.list', payload: { sessionId: 'session-1' } },
      { method: 'command.execute', payload: { sessionId: 'session-1', line: '/plan' } },
      { method: 'command.execute', payload: { sessionId: 'session-1', line: '/missing' } },
    ])
    await client.close()
  })

  it('keeps rc.1 and rc.2 frame unions distinct, including transient fields and task snapshots', () => {
    const rc1 = createLegacyFrameParser('rc1')
    const rc2 = createLegacyFrameParser('rc2')
    const transient = {
      type: 'session/event',
      sessionId: 'session-1',
      event: {
        type: 'assistant/chunk',
        seq: 3,
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: 'text', text: 'hello' } },
        sourceEventSeqs: [2],
        surfaceOp: { kind: 'append' },
        ignorable: true,
      },
    }
    const taskFrame = {
      type: 'session/tasks',
      sessionId: 'session-1',
      tasks: [
        {
          id: 'task-1',
          kind: 'workflow',
          label: 'Build',
          status: 'running',
          startedAt: 10,
        },
      ],
    }

    expect(rc2.parse(transient, 'mux')).toMatchObject({ event: { ignorable: true } })
    expect(rc1.parse(transient, 'mux')).not.toHaveProperty('event.ignorable')
    expect(rc2.parse(taskFrame, 'mux')).toEqual(taskFrame)
    expect(() => rc1.parse(taskFrame, 'mux')).toThrow()
    expect(() => rc2.parse({ type: 'host/commands-changed' }, 'host')).toThrow()
    expect(rc1.parse({ type: 'host/commands-changed' }, 'host')).toEqual({ type: 'host/commands-changed' })
    expect(rc2.parse({ type: 'host/remote-event', event: 'commands/change', args: [] }, 'host')).toEqual({
      type: 'host/remote-event',
      event: 'commands/change',
      args: [],
    })
  })

  it('projects old task and invalidation frames into the current domain events', () => {
    expect(
      rc6Mapper.event('session/tasks', {
        sessionId: 'session-1',
        tasks: [
          {
            id: 'task-1',
            kind: 'workflow',
            label: 'Build',
            status: 'completed',
            startedAt: 1,
            finishedAt: 2,
          },
        ],
      }),
    ).toEqual({
      type: 'jobs.updated',
      sessionId: 'session-1',
      jobs: [
        { id: 'task-1', kind: 'workflow', label: 'Build', status: 'completed', startedAt: 1, finishedAt: 2 },
      ],
    })
    expect(rc6Mapper.event('host/commands-changed', {})).toEqual({
      type: 'remote.event',
      name: 'commands/change',
      args: [],
    })
    expect(rc6Mapper.event('host/settings-changed', { ns: 'provider.test' })).toEqual({
      type: 'remote.event',
      name: 'settings/document-updated',
      args: ['provider.test'],
    })
    expect(
      rc6Mapper.event('host/session-preset-changed', {
        sessionId: 'session-1',
        agentPreset: 'balanced',
      }),
    ).toEqual({
      type: 'remote.event',
      name: 'agent-preset/selected',
      args: ['session-1', 'balanced'],
    })
    expect(rc6Mapper.event('host/credentials-changed', { ref: 'provider.test' })).toEqual({
      type: 'remote.event',
      name: 'credentials/updated',
      args: ['provider.test'],
    })
    expect(rc6Mapper.event('host/models-changed', {})).toEqual({
      type: 'remote.event',
      name: 'llm/adapters-updated',
      args: [],
    })
  })

  it('omits rc.1 client-time-zone fields from session and subagent prompts', async () => {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = []
    const transport = successfulTransport((method) => {
      if (method === 'subagent.list')
        return {
          entries: [
            {
              kind: 'child',
              id: 'child-1',
              activity: 'running',
              hasChildren: false,
              mode: 'continuable',
              label: 'worker',
            },
          ],
          parentAvailable: true,
        }
      if (method === 'subagent.prompt') return { messageId: 'message-1' }
      if (method === 'session.prompt') return { accepted: true }
      throw new Error(`unexpected method ${method}`)
    }, calls)
    await new Rc6SessionRepository(transport, undefined, undefined, {
      includeClientTimeZone: false,
    }).sendPrompt({ sessionId: 'session-1', text: 'hello', attachments: [] })
    const subagents = new Rc6SubagentRepository(transport, { includeClientTimeZone: false })
    await subagents.list('parent-1')
    await subagents.send('child-1', 'follow-up')

    expect(calls).toEqual([
      {
        method: 'session.prompt',
        params: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] },
      },
      { method: 'subagent.list', params: { parentSessionId: 'parent-1' } },
      {
        method: 'subagent.prompt',
        params: {
          parentSessionId: 'parent-1',
          childSessionId: 'child-1',
          mode: 'continuable',
          content: [{ type: 'text', text: 'follow-up' }],
        },
      },
    ])
  })

  it('forwards explicit session ids through every historical session.create adapter', async () => {
    const createInput = {
      workspaceId: 'workspace-1',
      sessionId: 'session-existing',
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      },
    } as const
    const entries = [
      [new LegacyRc1VersionAdapter(options), '0.0.1-rc.1', 'legacy-rc1'],
      [new LegacyRc2VersionAdapter(options), '0.0.1-rc.2', 'legacy-rc2'],
      [new LegacyRc5VersionAdapter(options), '0.0.1-rc.5', 'legacy-rc5'],
      [new Rc02VersionAdapter(options), '0.1.0-rc.2', 'rc02'],
      [new Rc03VersionAdapter(options), '0.1.0-rc.3', 'rc03'],
    ] as const

    for (const [adapter, version, protocolVersion] of entries) {
      const calls: Array<{ readonly method: string; readonly payload: Record<string, unknown> }> = []
      const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(await new Response(init?.body ?? null).text()) as {
          readonly rpcId: string
          readonly method: string
          readonly payload: Record<string, unknown>
        }
        calls.push({ method: request.method, payload: request.payload })
        const value =
          request.method === 'session.create'
            ? { sessionId: request.payload.sessionId ?? 'session-generated' }
            : request.method === 'session.history'
              ? { events: [], hasMore: false }
              : request.method === 'workspace.list'
                ? { items: [], archivedSessionIds: [] }
                : {}
        return new Response(
          JSON.stringify({
            type: 'server-response',
            rpcId: request.rpcId,
            result: { ok: true, value },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      })
      const configured = new (adapter.constructor as new (adapterOptions: typeof options) => typeof adapter)({
        ...options,
        fetch,
      })
      const backend = await configured.createBackend(connected(version, protocolVersion))

      await expect(backend.sessions.create(createInput)).resolves.toMatchObject({ id: 'session-existing' })
      expect(calls.find((call) => call.method === 'session.create')?.payload).toEqual({
        workspaceId: 'workspace-1',
        sessionId: 'session-existing',
        agentPreset: 'standard',
      })
      await backend.close()
    }
  })

  it('keeps old repository capabilities explicit in backend assembly', async () => {
    const adapter = new LegacyRc1VersionAdapter({ ...options, fetch: handshakeFetch() })
    const backend = await adapter.createBackend(connected('0.0.1-rc.1', 'legacy-rc1'))

    expect(backend.commands).toBeInstanceOf(LegacyCommandRepository)
    expect(backend.workspaces).toBeInstanceOf(LegacyWorkspaceRepository)
    expect(backend.exports).toBeInstanceOf(LegacyRc1ExportRepository)
    await expect(backend.workspaces.insertBefore('workspace-1')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    await expect(
      backend.exports.exportSession(
        {
          sessionId: 'session-1',
          format: 'zip',
          includeAttachments: true,
          includeReasoning: true,
        },
        'export.zip',
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    await backend.close()
  })
})

it('rejects RC1 Jobs while preserving RC2 Jobs support', async () => {
  const rc1 = await new LegacyRc1VersionAdapter(options).createBackend(connected('0.0.1-rc.1', 'legacy-rc1'))
  const rc2 = await new LegacyRc2VersionAdapter(options).createBackend(connected('0.0.1-rc.2', 'legacy-rc2'))
  try {
    await expect(rc1.jobs.list('s1')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    await expect(rc2.jobs.list('s1')).resolves.toEqual([])
    await expect(rc1.sessions.setArchived('s1', false)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  } finally {
    await rc1.close()
    await rc2.close()
  }
})
