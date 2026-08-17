import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SettingsRepository } from '../src/repositories/settings-repository.js'

interface Call {
  readonly method: string
  readonly params: unknown
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
      Promise.reject<TResponse>(new Error('the Remote carrier is not part of this contract')),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

/**
 * Describe answer shaped exactly like the pinned `settings.describe`: one
 * plugin-owned shell namespace with a user-layer override and no secrets,
 * plus the web-search namespace carrying a write-only field.
 */
const DESCRIBE_FIXTURE = {
  writable: true,
  hasDocument: true,
  namespaces: [
    {
      ns: 'shell',
      schema: {
        uid: 3,
        refs: {
          1: { type: 'number', meta: { required: true } },
          2: { type: 'number' },
          3: { type: 'object', dict: { timeoutMs: 1, maxOutputBytes: 2 } },
        },
      },
      value: { timeoutMs: 12_000, maxOutputBytes: 200_000 },
      base: { timeoutMs: 120_000, maxOutputBytes: 200_000 },
      user: { timeoutMs: 12_000 },
      applies: 'live',
      secrets: [],
      revision: 4,
    },
    {
      ns: 'web-search-deepseek',
      schema: {
        uid: 4,
        refs: {
          1: { type: 'string' },
          2: { type: 'string' },
          3: { type: 'number' },
          4: { type: 'object', dict: { apiKeyEnv: 1, baseURL: 2, maxUses: 3 } },
        },
      },
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: undefined, maxUses: 3 },
      applies: 'live',
      secrets: [{ path: ['apiKeyEnv'], set: true }],
      revision: 2,
    },
  ],
}

describe('Rc6SettingsRepository schema namespaces', () => {
  it('carries per-namespace user-layer and secret facts the field list cannot express', async () => {
    const repository = new Rc6SettingsRepository(transportFor({ 'settings.describe': DESCRIBE_FIXTURE }))

    const schema = await repository.schema()

    expect(schema).toMatchObject({ version: 'rc6-settings-v2', writable: true, hasDocument: true })

    const shell = schema.namespaces.find((entry) => entry.ns === 'shell')
    expect(shell).toEqual({
      ns: 'shell',
      applies: 'live',
      userFields: ['timeoutMs'],
      secrets: [],
    })
    const webSearch = schema.namespaces.find((entry) => entry.ns === 'web-search-deepseek')
    expect(webSearch?.secrets).toEqual([{ field: 'apiKeyEnv', set: true }])
    expect(webSearch?.userFields).toEqual([])
    // Flattened fields stay namespace-prefixed for the rows that consume them.
    expect(schema.fields.map((field) => field.path)).toEqual([
      'shell.timeoutMs',
      'shell.maxOutputBytes',
      'web-search-deepseek.apiKeyEnv',
      'web-search-deepseek.baseURL',
      'web-search-deepseek.maxUses',
    ])
  })

  it('treats a missing user layer as no overrides rather than malformed data', async () => {
    const fixture = {
      writable: true,
      hasDocument: false,
      namespaces: [
        {
          ns: 'agent-loop',
          schema: {
            uid: 2,
            refs: {
              1: { type: 'number' },
              2: { type: 'object', dict: { maxParallelToolCalls: 1 } },
            },
          },
          value: {},
          applies: 'restart',
          secrets: [],
          revision: 1,
        },
      ],
    }
    const repository = new Rc6SettingsRepository(transportFor({ 'settings.describe': fixture }))

    const schema = await repository.schema()

    expect(schema.namespaces).toEqual([{ ns: 'agent-loop', applies: 'restart', userFields: [], secrets: [] }])
  })

  it('decodes the pinned Schemastery union envelope into a required enum row', async () => {
    const fixture = {
      writable: true,
      hasDocument: false,
      namespaces: [
        {
          ns: 'permission',
          schema: {
            uid: 5,
            refs: {
              1: { type: 'const', value: 'read-only' },
              2: { type: 'const', value: 'workspace-write' },
              3: { type: 'const', value: 'danger-full-access' },
              4: { type: 'union', list: [1, 2, 3], meta: { required: true } },
              5: { type: 'object', dict: { defaultPreset: 4 } },
            },
          },
          value: { defaultPreset: 'workspace-write' },
          applies: 'live',
          secrets: [],
          revision: 0,
        },
      ],
    }
    const repository = new Rc6SettingsRepository(transportFor({ 'settings.describe': fixture }))

    await expect(repository.schema()).resolves.toMatchObject({
      fields: [
        {
          path: 'permission.defaultPreset',
          type: 'enum',
          required: true,
          enumValues: ['read-only', 'workspace-write', 'danger-full-access'],
        },
      ],
    })
  })

  it('rejects missing deployment facts and malformed schema/secret descriptors', async () => {
    const withoutFacts = { namespaces: DESCRIBE_FIXTURE.namespaces }
    const badSchema = {
      ...DESCRIBE_FIXTURE,
      namespaces: [{ ...DESCRIBE_FIXTURE.namespaces[0], schema: { type: 'object' } }],
    }
    const badSecret = {
      ...DESCRIBE_FIXTURE,
      namespaces: [{ ...DESCRIBE_FIXTURE.namespaces[0], secrets: [{ path: ['token'], set: 'yes' }] }],
    }

    await expect(
      new Rc6SettingsRepository(transportFor({ 'settings.describe': withoutFacts })).schema(),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(
      new Rc6SettingsRepository(transportFor({ 'settings.describe': badSchema })).schema(),
    ).rejects.toThrow(/Schemastery/i)
    await expect(
      new Rc6SettingsRepository(transportFor({ 'settings.describe': badSecret })).schema(),
    ).rejects.toThrow(/malformed settings/i)
  })
})

describe('Rc6SettingsRepository replace', () => {
  it('rejects a non-object namespace section before issuing settings.replace', async () => {
    const calls: Call[] = []
    const repository = new Rc6SettingsRepository(
      transportFor(
        {
          'settings.describe': DESCRIBE_FIXTURE,
          'settings.replace': DESCRIBE_FIXTURE.namespaces[0],
        },
        calls,
      ),
    )

    await expect(repository.replace({ shell: [] })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(calls.map((call) => call.method)).toEqual(['settings.describe'])
  })
})

describe('Rc6SettingsRepository unset', () => {
  it('removes one field override through settings.mutate op unset with the current revision', async () => {
    const calls: Call[] = []
    const repository = new Rc6SettingsRepository(
      transportFor(
        {
          'settings.describe': DESCRIBE_FIXTURE,
          'settings.mutate': DESCRIBE_FIXTURE.namespaces[0],
        },
        calls,
      ),
    )
    await repository.schema()

    await repository.unset('shell.timeoutMs')

    const mutate = calls.find((call) => call.method === 'settings.mutate')
    expect(mutate?.params).toEqual({
      ns: 'shell',
      ops: [{ op: 'unset', path: ['timeoutMs'] }],
      expectedRevision: 4,
    })
  })

  it('refuses a path without a field segment', async () => {
    const repository = new Rc6SettingsRepository(transportFor({ 'settings.describe': DESCRIBE_FIXTURE }))

    await expect(repository.unset('shell')).rejects.toThrow(/namespace\.field/)
  })

  it('does not issue a mutation when settings.describe reports read-only', async () => {
    const calls: Call[] = []
    const repository = new Rc6SettingsRepository(
      transportFor(
        {
          'settings.describe': { ...DESCRIBE_FIXTURE, writable: false },
          'settings.mutate': DESCRIBE_FIXTURE.namespaces[0],
        },
        calls,
      ),
    )

    await expect(repository.update('shell.timeoutMs', 30_000)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(calls.map((call) => call.method)).toEqual(['settings.describe'])
  })
})
