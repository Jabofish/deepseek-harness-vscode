import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6PresetRepository } from '../src/repositories/preset-repository.js'

interface Call {
  method: string
  params: unknown
}

function transportFor(responses: Readonly<Record<string, unknown>>, calls: Call[] = []): DshTransport {
  return {
    request: <TResponse>(method: string, params: unknown) => {
      calls.push({ method, params })
      const response = responses[method]
      if (response === undefined) return Promise.reject(new Error(`unexpected RPC ${method}`))
      return Promise.resolve({ result: { ok: true, value: response } } as TResponse)
    },
    remoteRequest: <TResponse>() =>
      Promise.reject<TResponse>(new Error('remote transport is not part of this contract')),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

/** Roster exactly as the pinned rc.6 `agentPreset.list` answers it. */
const ROSTER_FIXTURE = {
  presets: [
    {
      id: 'standard',
      trust: 'system',
      isDefault: true,
      name: 'Standard',
      description: 'The default composition.',
    },
    { id: 'cordis', trust: 'system', isDefault: false, name: 'Cordis' },
    {
      id: 'my-copy',
      trust: 'user',
      isDefault: false,
      name: 'My copy',
      description: 'A local composition.',
    },
    { id: 'broken-copy', trust: 'user', isDefault: false, broken: 'missing agent.cordis.yml' },
  ],
  authorable: true,
  hasDocument: true,
}

describe('Rc6PresetRepository roster read', () => {
  it('maps the roster with the authorable and hasDocument deployment facts', async () => {
    const calls: Call[] = []
    const repository = new Rc6PresetRepository(transportFor({ 'agentPreset.list': ROSTER_FIXTURE }, calls))

    const roster = await repository.list()

    expect(calls).toEqual([{ method: 'agentPreset.list', params: {} }])
    expect(roster.authorable).toBe(true)
    expect(roster.canOpenPresetLocation).toBe(true)
    expect(roster.canRemoveUserPresets).toBe(true)
    expect(roster.hasDocument).toBe(true)
    expect(roster.presets.map((preset) => preset.id)).toEqual([
      'standard',
      'cordis',
      'my-copy',
      'broken-copy',
    ])
    expect(roster.presets[3]?.broken).toBe('missing agent.cordis.yml')
  })

  it('rejects the whole roster when any entry has malformed trust', async () => {
    const repository = new Rc6PresetRepository(
      transportFor({
        'agentPreset.list': {
          presets: [
            { id: 'standard', trust: 'system', isDefault: true },
            { id: 'mystery', trust: 'other', isDefault: false },
          ],
          authorable: true,
          hasDocument: false,
        },
      }),
    )

    await expect(repository.list()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})

describe('Rc6PresetRepository document read', () => {
  it('maps the pinned agentPreset.read document shape', async () => {
    const calls: Call[] = []
    const repository = new Rc6PresetRepository(
      transportFor(
        {
          'agentPreset.read': {
            agentPreset: 'standard',
            trust: 'system',
            content: 'instructions:\n  - be careful\n',
            name: 'Standard',
            description: 'The default composition.',
          },
        },
        calls,
      ),
    )

    const document = await repository.read('standard')

    expect(calls).toEqual([{ method: 'agentPreset.read', params: { agentPreset: 'standard' } }])
    expect(document).toEqual({
      id: 'standard',
      trust: 'system',
      content: 'instructions:\n  - be careful\n',
      name: 'Standard',
      description: 'The default composition.',
    })
  })

  it('refuses a malformed document rather than guessing fields', async () => {
    const repository = new Rc6PresetRepository(
      transportFor({ 'agentPreset.read': { agentPreset: 'standard', content: '…' } }),
    )

    await expect(repository.read('standard')).rejects.toThrow(/malformed preset document/)
  })
})

describe('Rc6PresetRepository document location', () => {
  it('rejects an opened:false response without the required path', async () => {
    const repository = new Rc6PresetRepository(
      transportFor({ 'agentPreset.openDocument': { opened: false } }),
    )

    await expect(repository.openDocument('my-copy')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('rejects an unknown opened discriminator', async () => {
    const repository = new Rc6PresetRepository(
      transportFor({ 'agentPreset.openDocument': { opened: 'later', path: '/tmp/preset' } }),
    )

    await expect(repository.openDocument('my-copy')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
