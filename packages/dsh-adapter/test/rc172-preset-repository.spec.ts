import { describe, expect, it } from 'vitest'

import type { DshTransport } from '../src/contracts.js'
import { normalizeAlphaResult, type AlphaResult } from '../src/versions/alpha/transport-support.js'
import { normalizeRc172ErrorCode } from '../src/versions/rc172/error-vocabulary.js'
import { Rc172PresetRepository } from '../src/versions/rc172/preset-repository.js'

interface RemoteCall {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal | undefined
}

function recordingTransport(responses: readonly unknown[]): {
  readonly transport: DshTransport
  readonly calls: RemoteCall[]
} {
  const pending = [...responses]
  const calls: RemoteCall[] = []
  const transport: DshTransport = {
    request: <TResponse>() => Promise.reject<TResponse>(new Error('preset tests issue no ordinary RPC')),
    remoteRequest: <TResponse>(
      endpoint: string,
      args: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<TResponse> => {
      calls.push({ endpoint, args, signal })
      if (pending.length === 0) return Promise.reject(new Error('unexpected preset Remote request'))
      const response = pending.shift()
      if (response instanceof Error) return Promise.reject(response)
      // The real transport normalises the wire error vocabulary inside
      // `post()`, before a response reaches any repository. Replay that step
      // here so the tests exercise the codes a repository actually receives,
      // not the raw spellings that never survive the transport.
      return Promise.resolve(
        normalizeAlphaResult(response as AlphaResult, normalizeRc172ErrorCode) as TResponse,
      )
    },
    openEventStream: async function* () {
      /* preset operations do not open streams */
    },
    close: () => Promise.resolve(),
  }
  return { transport, calls }
}

describe('DSH 0.1.7-rc.2 Agent Preset Remote contract', () => {
  it('projects the `{ presets }` roster and classifies shipped and custom presets', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: {
          presets: [
            { id: 'standard', isDefault: true },
            { id: 'custom-mode', isDefault: false, name: 'Custom mode', description: 'A user preset' },
            { id: 'broken-preset', isDefault: false, broken: 'A declared plugin could not load.' },
          ],
        },
      },
    ])
    const signal = new AbortController().signal

    const roster = await new Rc172PresetRepository(transport).list(signal)

    expect(roster).toEqual({
      presets: [
        {
          id: 'standard',
          trust: 'system',
          isDefault: true,
        },
        {
          id: 'custom-mode',
          trust: 'user',
          isDefault: false,
          name: 'Custom mode',
          description: 'A user preset',
        },
        {
          id: 'broken-preset',
          trust: 'user',
          isDefault: false,
          broken: 'A declared plugin could not load.',
        },
      ],
      authorable: false,
      canOpenPresetLocation: false,
      canRemoveUserPresets: false,
      compositionReadable: true,
      defaultSettingPath: 'agent-preset-registry.selectedDefault',
    })
    expect(roster).not.toHaveProperty('modeSelectionEnabled')
    expect(calls).toEqual([{ endpoint: 'agentPresets/list', args: {}, signal }])
  })

  it('treats the optional registry invocation failure as an empty roster with no default', async () => {
    // The wire reports the unmounted registry as `gateway/invocation-unavailable`;
    // the transport normalises it to `unknown-command` and retains the original
    // spelling as `wireCode`. The fallback has to recognise the condition from
    // what actually arrives, or session creation hard-fails on exactly the
    // deployments this fallback exists for.
    const { transport, calls } = recordingTransport([
      {
        ok: false,
        error: {
          code: 'gateway/invocation-unavailable',
          message: 'The optional preset registry is not mounted.',
          details: { endpoint: 'agentPresets/list' },
        },
      },
    ])
    const signal = new AbortController().signal

    await expect(new Rc172PresetRepository(transport).list(signal)).resolves.toEqual({
      presets: [],
      authorable: false,
      canOpenPresetLocation: false,
      canRemoveUserPresets: false,
      compositionReadable: false,
    })
    expect(calls).toEqual([{ endpoint: 'agentPresets/list', args: {}, signal }])
  })

  it('reads the declared document and selects it through the rc.2 Remote methods', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: {
          agentPreset: 'custom-mode',
          content: '- id: example-tool\n  name: Example tool\n',
          name: 'Custom mode',
          description: 'A user preset',
        },
      },
      { ok: true, value: 'custom-mode' },
    ])
    const signal = new AbortController().signal
    const repository = new Rc172PresetRepository(transport)

    await expect(repository.read('custom-mode', signal)).resolves.toEqual({
      id: 'custom-mode',
      trust: 'user',
      content: '- id: example-tool\n  name: Example tool\n',
      name: 'Custom mode',
      description: 'A user preset',
    })
    await expect(repository.select('session-1', 'custom-mode', signal)).resolves.toBeUndefined()
    expect(calls).toEqual([
      { endpoint: 'agentPresets/read', args: { agentPreset: 'custom-mode' }, signal },
      {
        endpoint: 'agentPresets/select',
        args: { agentId: 'session-1', agentPreset: 'custom-mode' },
        signal,
      },
    ])
  })

  it('rejects invalid inputs before sending an RPC', async () => {
    const { transport, calls } = recordingTransport([])
    const repository = new Rc172PresetRepository(transport)

    await expect(repository.read('  ')).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await expect(repository.select('', 'standard')).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await expect(repository.select('session-1', ' ')).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(calls).toEqual([])
  })

  it('rejects malformed roster entries and document projections without exposing payloads', async () => {
    const { transport } = recordingTransport([
      { ok: true, value: { presets: [{ id: 'standard', isDefault: 'yes' }] } },
      {
        ok: true,
        value: { agentPreset: 'other-preset', content: 'private composition body' },
      },
    ])
    const repository = new Rc172PresetRepository(transport)

    await expect(repository.list()).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed rc172 preset roster entry.',
    })
    await expect(repository.read('standard')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed rc172 preset document.',
    })
  })
})
