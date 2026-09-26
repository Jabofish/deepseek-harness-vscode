import { describe, expect, it, vi } from 'vitest'
import type { AgentConfiguration } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'

type RecordedCall =
  | { readonly kind: 'rpc'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'remote'; readonly method: string; readonly params: unknown }

function fixture(): { readonly transport: DshTransport; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const transport: DshTransport = {
    request: <TResponse>(method: string, params: unknown): Promise<TResponse> => {
      calls.push({ kind: 'rpc', method, params })
      if (method === 'session.list')
        return Promise.resolve({
          result: {
            ok: true,
            value: {
              items: [
                {
                  sessionId: 'session-1',
                  updatedAt: 1_000,
                  running: false,
                  blank: false,
                  agentPreset: 'standard',
                },
              ],
            },
          },
        } as TResponse)
      if (method === 'session.history')
        return Promise.resolve({
          result: {
            ok: true,
            value: {
              events: [
                {
                  event: {
                    type: 'request/header',
                    seq: 1,
                    time: 1_000,
                    data: {
                      header: { config: { provider: 'provider-old', model: 'model-old' } },
                    },
                  },
                },
                {
                  event: { type: 'plan/mode', seq: 2, time: 2_000, data: { active: false } },
                },
              ],
              hasMore: false,
              projections: { asOfSeq: 2, values: { plan: { active: false, pending: false } } },
            },
          },
        } as TResponse)
      if (method === 'session.selectModel')
        return Promise.resolve({
          result: {
            ok: true,
            value: { selected: { provider: 'provider-new', model: 'model-new' } },
          },
        } as TResponse)
      return Promise.reject(new Error(`unexpected RPC ${method}`))
    },
    remoteRequest: <TResponse>(
      method: string,
      params: Readonly<Record<string, unknown>>,
    ): Promise<TResponse> => {
      calls.push({ kind: 'remote', method, params })
      return Promise.resolve({ ok: true, value: { result: { kind: 'success' } } } as TResponse)
    },
    openEventStream: async function* () {
      /* no stream frames are needed for this repository fixture */
    },
    close: () => Promise.resolve(),
  }
  return { transport, calls }
}

function configuration(
  permissionPreset: string,
  model: AgentConfiguration['model'] = { providerId: 'provider-old', modelId: 'model-old' },
): AgentConfiguration {
  return {
    preset: 'standard',
    toolMode: 'native',
    permissionPreset,
    planMode: false,
    model,
  }
}

function commandLines(calls: readonly RecordedCall[]): readonly string[] {
  return calls.flatMap((call) => {
    if (
      call.kind !== 'remote' ||
      call.method !== 'commands/execute' ||
      typeof call.params !== 'object' ||
      call.params === null
    )
      return []
    const line = (call.params as Readonly<Record<string, unknown>>).line
    return typeof line === 'string' ? [line] : []
  })
}

describe('permission configuration capability boundary', () => {
  it('rejects a real preset change when a catalog-capable profile has no permissions projection', async () => {
    const { transport, calls } = fixture()
    const readPermissionPresets = vi.fn(() => Promise.resolve(['workspace-write', 'read-only']))
    const repository = new Rc6SessionRepository(transport, undefined, undefined, { readPermissionPresets })
    await repository.list()

    await expect(repository.setConfiguration('session-1', configuration('read-only'))).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(readPermissionPresets).not.toHaveBeenCalled()
    expect(commandLines(calls)).toEqual([])
  })

  it('allows another configuration update without writing an unknown display fallback', async () => {
    const { transport, calls } = fixture()
    const readPermissionPresets = vi.fn(() => Promise.resolve(['workspace-write', 'read-only']))
    const repository = new Rc6SessionRepository(transport, undefined, undefined, { readPermissionPresets })
    await repository.list()

    await repository.setConfiguration(
      'session-1',
      configuration('workspace-write', { providerId: 'provider-new', modelId: 'model-new' }),
    )

    expect(calls.some((call) => call.kind === 'rpc' && call.method === 'session.selectModel')).toBe(true)
    expect(commandLines(calls)).toEqual([])
    expect(readPermissionPresets).not.toHaveBeenCalled()
  })

  it('preserves the legacy fallback command behavior for profiles without the reader', async () => {
    const { transport, calls } = fixture()
    const repository = new Rc6SessionRepository(transport)
    await repository.list()

    await repository.setConfiguration(
      'session-1',
      configuration('workspace-write', { providerId: 'provider-new', modelId: 'model-new' }),
    )

    expect(calls.some((call) => call.kind === 'rpc' && call.method === 'session.selectModel')).toBe(true)
    expect(commandLines(calls)).toEqual(['/permission workspace-write'])
  })

  it('preserves explicit permission command behavior for a profile without the catalog reader', async () => {
    const { transport, calls } = fixture()
    const repository = new Rc6SessionRepository(transport)
    await repository.list()

    await repository.setConfiguration('session-1', configuration('read-only'))

    expect(commandLines(calls)).toEqual(['/permission read-only'])
  })
})
