import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6PluginRepository } from '../src/repositories/plugin-repository.js'

interface RemoteCall {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
}

type RemoteAnswer =
  { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'error'; readonly code: string }

function transportFor(
  answers: Readonly<Record<string, RemoteAnswer>>,
  calls: RemoteCall[] = [],
): DshTransport {
  return {
    request: <TResponse>() =>
      Promise.reject<TResponse>(new Error('the inventory rides the Remote carrier, not the RPC map')),
    remoteRequest: <TResponse>(
      endpoint: string,
      args: Readonly<Record<string, unknown>>,
    ): Promise<TResponse> => {
      calls.push({ endpoint, args })
      const answer = answers[endpoint]
      if (answer === undefined) return Promise.reject<TResponse>(new Error(`unexpected Remote ${endpoint}`))
      if (answer.kind === 'error')
        return Promise.resolve({ ok: false, error: { code: answer.code } } as TResponse)
      return Promise.resolve({ ok: true, value: answer.value } as TResponse)
    },
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

/** Snapshot exactly as the pinned `pluginInventory/list` answers it. */
const SNAPSHOT_FIXTURE = {
  entries: [
    {
      entryId: 'ui-settings',
      moduleName: '@deepseek-ai/dsh-client-ui-settings',
      enabled: true,
      fiberPhase: 'active',
    },
    {
      entryId: 'web-search',
      moduleName: 'cordis:cordis-plugin-web-search-deepseek',
      enabled: true,
      fiberPhase: 'pending',
    },
    {
      entryId: 'bash',
      moduleName: '@deepseek-ai/dsh-host-bash',
      enabled: false,
      fiberPhase: null,
    },
    {
      entryId: 'agent-loop',
      moduleName: '@deepseek-ai/dsh-host-agent-loop',
      enabled: true,
      fiberPhase: 'loading',
    },
    {
      entryId: 'cordis-runner',
      moduleName: 'cordis:dsh-host-cordis-runner',
      enabled: true,
      fiberPhase: 'failed',
    },
    {
      entryId: 'goals',
      moduleName: '@deepseek-ai/dsh-host-goal',
      enabled: true,
      fiberPhase: 'unloading',
    },
  ],
}

describe('Rc6PluginRepository inventory', () => {
  it('reads the loader projection through the pluginInventory/list direct Remote', async () => {
    const calls: RemoteCall[] = []
    const repository = new Rc6PluginRepository(
      transportFor({ 'pluginInventory/list': { kind: 'value', value: SNAPSHOT_FIXTURE } }, calls),
    )

    const snapshot = await repository.inventory()

    expect(calls).toEqual([{ endpoint: 'pluginInventory/list', args: {} }])
    expect(snapshot.entries.map((entry) => entry.fiberPhase)).toEqual([
      'active',
      'pending',
      null,
      'loading',
      'failed',
      'unloading',
    ])
    expect(snapshot.entries[0]).toEqual({
      entryId: 'ui-settings',
      moduleName: '@deepseek-ai/dsh-client-ui-settings',
      enabled: true,
      fiberPhase: 'active',
    })
  })

  it('keeps the loader order and does not sort or deduplicate entries', async () => {
    const repository = new Rc6PluginRepository(
      transportFor({
        'pluginInventory/list': {
          kind: 'value',
          value: {
            entries: [
              { entryId: 'b', moduleName: 'module-b', enabled: true, fiberPhase: 'active' },
              { entryId: 'b', moduleName: 'module-b-again', enabled: false, fiberPhase: null },
              { entryId: 'a', moduleName: 'module-a', enabled: true, fiberPhase: 'active' },
            ],
          },
        },
      }),
    )

    const snapshot = await repository.inventory()

    expect(snapshot.entries.map((entry) => entry.entryId)).toEqual(['b', 'b', 'a'])
  })

  it('rejects a malformed snapshot instead of guessing entries', async () => {
    const repository = new Rc6PluginRepository(
      transportFor({
        'pluginInventory/list': {
          kind: 'value',
          value: {
            entries: [
              { entryId: 'ok', moduleName: 'fine', enabled: true, fiberPhase: 'active' },
              { entryId: 42, moduleName: 'bad-id', enabled: true, fiberPhase: 'active' },
            ],
          },
        },
      }),
    )

    await expect(repository.inventory()).rejects.toThrow(/malformed plugin inventory/i)
  })

  it('rejects an unknown fiber phase rather than smuggling it through', async () => {
    const repository = new Rc6PluginRepository(
      transportFor({
        'pluginInventory/list': {
          kind: 'value',
          value: {
            entries: [{ entryId: 'x', moduleName: 'm', enabled: true, fiberPhase: 'mounted' }],
          },
        },
      }),
    )

    await expect(repository.inventory()).rejects.toThrow(/malformed plugin inventory/i)
  })

  it('rejects an entries payload that is not an array', async () => {
    const repository = new Rc6PluginRepository(
      transportFor({ 'pluginInventory/list': { kind: 'value', value: { entries: 'nope' } } }),
    )

    await expect(repository.inventory()).rejects.toThrow(/malformed plugin inventory/i)
  })

  it('surfaces a host-side refusal as an AppError', async () => {
    const repository = new Rc6PluginRepository(
      transportFor({
        'pluginInventory/list': { kind: 'error', code: 'definition-unavailable' },
      }),
    )

    await expect(repository.inventory()).rejects.toThrow(/pluginInventory\/list failed/i)
  })
})
