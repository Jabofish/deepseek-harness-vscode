import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate, ConnectedBackend } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'

import { VersionedBackendFactory } from '../src/backend-factory.js'
import { Rc6VersionAdapter } from '../src/versions/rc6/adapter.js'
import { Rc7VersionAdapter } from '../src/versions/rc7/adapter.js'
import { Rc8VersionAdapter } from '../src/versions/rc8/adapter.js'
import { rc8Mapper } from '../src/versions/rc8/mapper.js'
import { Rc8CommandRepository } from '../src/repositories/command-repository.js'
import { unwrapRpcResult } from '../src/versions/rc6/rpc.js'

const endpoint = { host: '127.0.0.1' as const, port: 3939, baseUrl: 'http://127.0.0.1:3939' }
const candidate: BackendCandidate = { endpoint, source: 'configured', confidence: 100 }

function options(value: { readonly home?: string }): ConstructorParameters<typeof Rc8VersionAdapter>[0] {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Response(init?.body ?? null).text()
      const request = JSON.parse(body) as { readonly rpcId?: string }
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              version: '0.0.1',
              cwd: 'fixture',
              attachedSessions: 0,
              canOpenPath: true,
              ...(value.home === undefined ? {} : { home: value.home }),
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }),
  }
}

function connected(version: string, protocolVersion = 'rc8'): ConnectedBackend {
  return {
    endpoint,
    ownership: 'external',
    capabilities: { protocolVersion, dshVersion: version, features: new Set() },
  }
}

describe('DeepSeek Harness rc.8 compatibility contract', () => {
  it('recognizes the rc.8 host-describe addition without exposing the home path', async () => {
    const adapter = new Rc8VersionAdapter(options({ home: 'C:\\Users\\fixture' }))
    await expect(adapter.probe({ ...candidate, runtimeVersion: '0.1.0-rc.8' })).resolves.toMatchObject({
      protocolVersion: 'rc8',
      dshVersion: '0.1.0-rc.8',
    })
  })

  it('keeps an unknown version launchable and exposes only a safe compatibility warning', async () => {
    const adapter = new Rc8VersionAdapter(options({ home: 'fixture-home' }))
    const result = await adapter.probe({ ...candidate, runtimeVersion: 'dsh-next-development' })
    expect(result).toMatchObject({ dshVersion: 'dsh-next-development' })
    expect(result?.compatibilityWarning).toContain('basic compatibility mode')
  })

  it('falls back to the legacy adapter when an older host has no home field', async () => {
    const adapter = new Rc8VersionAdapter(options({}))
    await expect(adapter.probe({ ...candidate, runtimeVersion: '0.1.0-rc.8' })).resolves.toBeUndefined()
    const legacy = new Rc6VersionAdapter(options({}))
    await expect(legacy.probe({ ...candidate, runtimeVersion: '0.1.0-rc.6' })).resolves.toMatchObject({
      protocolVersion: 'rc6',
      dshVersion: '0.1.0-rc.6',
    })
  })

  it('keeps rc.6, rc.7, and rc.8 exact factory paths and falls back for a future version', async () => {
    const adapters = [
      new Rc8VersionAdapter(options({ home: 'fixture-home' })),
      new Rc7VersionAdapter(options({})),
      new Rc6VersionAdapter(options({})),
    ] as const
    const factory = new VersionedBackendFactory(adapters)
    for (const version of ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8']) {
      const backend = await factory.connect(connected(version, version.slice(-3)))
      expect(backend.connection.capabilities.dshVersion).toBe(version)
      await backend.close()
    }
    const future = await factory.connect(connected('0.1.0-rc.99', 'future'))
    expect(future.connection.capabilities.dshVersion).toBe('0.1.0-rc.99')
    await future.close()

    const futureRc8 = await factory.connect(connected('0.1.0-rc.99', 'rc8'))
    expect(futureRc8.connection.capabilities.dshVersion).toBe('0.1.0-rc.99')
    await futureRc8.close()
  })

  it('sends rc.8 commands/execute the required empty images array', async () => {
    const calls: { readonly method: string; readonly params: unknown }[] = []
    const commandTransport: DshTransport = {
      request: <TResponse>() => Promise.resolve(undefined as TResponse),
      remoteRequest: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        return Promise.resolve({
          ok: true,
          value: { commandId: 'command-rc8', result: { kind: 'success', text: 'Plan mode on.' } },
        } as TResponse)
      },
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }

    await new Rc8CommandRepository(commandTransport).execute('session-1', '/plan')
    expect(calls).toEqual([
      {
        method: 'commands/execute',
        params: { agentId: 'session-1', line: '/plan', images: [] },
      },
    ])
  })

  it('maps interrupted prefixes and Agent Team durable events into bounded domain views', () => {
    expect(
      rc8Mapper.event('assistant/message', {
        sessionId: 's1',
        data: {
          turn: 1,
          step: 2,
          interrupted: true,
          message: { id: 'm1', content: [{ type: 'text', text: 'partial' }] },
        },
      }),
    ).toMatchObject({
      type: 'message.completed',
      messageId: 'm1',
      interrupted: true,
      markdown: 'partial',
    })

    expect(
      rc8Mapper.event('team/member', {
        sessionId: 's1',
        data: {
          version: 1,
          teamId: 'team-1',
          member: { id: 'member-1', name: 'Planner', phase: 'active', description: 'ignored' },
        },
      }),
    ).toMatchObject({ type: 'team.updated', activity: { kind: 'member', memberId: 'member-1' } })
    expect(
      rc8Mapper.event('team/task', {
        sessionId: 's1',
        data: {
          version: 1,
          teamId: 'team-1',
          task: {
            id: 'task-1',
            revision: 2,
            subject: 'Review',
            description: 'private detail is not projected',
            status: 'in_progress',
            blockedBy: ['task-0'],
            writeScopes: ['src/'],
          },
        },
      }),
    ).toMatchObject({
      type: 'team.updated',
      activity: { kind: 'task', taskId: 'task-1', blockedByCount: 1, writeScopeCount: 1 },
    })
    expect(
      rc8Mapper.event('team/message/queued', {
        sessionId: 's1',
        data: {
          version: 1,
          teamId: 'team-1',
          message: {
            id: 'message-1',
            senderId: 's1',
            senderName: 'Planner',
            targetId: 'member-1',
            delivery: 'quiet',
            content: [{ type: 'text', text: 'check this' }],
          },
        },
      }),
    ).toMatchObject({ type: 'team.updated', activity: { kind: 'message.queued', content: 'check this' } })
    expect(
      rc8Mapper.event('team/message/delivered', {
        sessionId: 's1',
        data: { version: 1, teamId: 'team-1', messageId: 'message-1', targetId: 'member-1' },
      }),
    ).toMatchObject({ type: 'team.updated', activity: { kind: 'message.delivered' } })
    expect(rc8Mapper.event('team/task', { sessionId: 's1', data: { version: 2 } }).type).toBe('unknown')
  })

  it('maps rc.8 attachment admission reasons without leaking the upstream message', () => {
    expect(() =>
      unwrapRpcResult(
        {
          result: {
            ok: false,
            error: {
              code: 'attachment-error',
              message: 'absolute host path should not leave the adapter',
              details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' },
            },
          },
        },
        'session.sendPrompt',
      ),
    ).toThrow(/dimension limit/i)
    expect(() =>
      unwrapRpcResult(
        {
          result: {
            ok: false,
            error: {
              code: 'attachment-error',
              message: 'absolute host path should not leave the adapter',
              details: { reason: 'IMAGE_DIMENSION_TOO_LARGE' },
            },
          },
        },
        'session.sendPrompt',
      ),
    ).not.toThrow(/absolute host path/i)
  })

  it('maps model-unavailable to a configuration failure instead of an auth failure', () => {
    expect(() =>
      unwrapRpcResult(
        {
          result: {
            ok: false,
            error: {
              code: 'model-unavailable',
              message: 'provider route is not configured',
            },
          },
        },
        'session.selectModel',
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })

  it('retains a bounded internal Remote diagnostic while redacting credential-shaped values', () => {
    expect(() =>
      unwrapRpcResult(
        {
          result: {
            ok: false,
            error: {
              code: 'internal',
              message: 'commands/execute rejected images; token=super-secret',
            },
          },
        },
        'commands/execute',
      ),
    ).toThrow(/images/)
    expect(() =>
      unwrapRpcResult(
        {
          result: {
            ok: false,
            error: {
              code: 'internal',
              message: 'commands/execute rejected images; token=super-secret',
            },
          },
        },
        'commands/execute',
      ),
    ).not.toThrow(/super-secret/)
  })

  it('preserves official mutation locations for produced-file chips', () => {
    expect(
      rc8Mapper.event('tool/result', {
        sessionId: 's1',
        data: {
          turn: 1,
          step: 1,
          callId: 'write-1',
          view: {
            view: {
              card: 'diff',
              title: 'Write report',
              locations: [
                { path: 'out/report.md', line: 4 },
                { path: 'out/report.md', line: 8 },
              ],
            },
          },
          message: { content: 'updated' },
        },
      }),
    ).toMatchObject({
      type: 'tool.updated',
      tool: {
        category: 'diff',
        locations: [{ path: 'out/report.md', line: 4 }],
      },
    })
  })
})
