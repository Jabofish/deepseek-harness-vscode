import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SettingsRepository } from '../src/repositories/settings-repository.js'

interface Call {
  readonly method: string
  readonly params: unknown
}

interface RevisionDescribeFixture {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: readonly {
    readonly ns: string
    readonly revision: number
    readonly value: Readonly<Record<string, unknown>>
    readonly [key: string]: unknown
  }[]
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
      revision: 4,
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

    expect(schema.namespaces).toEqual([
      { ns: 'agent-loop', applies: 'restart', revision: 1, userFields: [], secrets: [] },
    ])
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

describe('Rc6SettingsRepository snapshots', () => {
  it('pairs schema revision and redacted values from one settings.describe response', async () => {
    const calls: Call[] = []
    let readCount = 0
    const shellNamespace = DESCRIBE_FIXTURE.namespaces[0]
    if (shellNamespace === undefined) throw new Error('fixture namespace missing')
    const baseTransport = transportFor({ 'settings.describe': DESCRIBE_FIXTURE }, calls)
    const transport: DshTransport = {
      ...baseTransport,
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        if (method !== 'settings.describe') return Promise.reject(new Error(`unexpected RPC ${method}`))
        readCount += 1
        const revision = readCount === 1 ? 4 : 5
        const timeoutMs = readCount === 1 ? 12_000 : 18_000
        return Promise.resolve({
          result: {
            ok: true,
            value: {
              ...DESCRIBE_FIXTURE,
              namespaces: [{ ...shellNamespace, revision, value: { timeoutMs }, user: { timeoutMs } }],
            },
          },
        } as TResponse)
      },
    }
    const repository = new Rc6SettingsRepository(transport)

    const snapshot = await repository.readSnapshot()

    expect(calls).toHaveLength(1)
    expect(snapshot.schema.namespaces[0]?.revision).toBe(4)
    expect(snapshot.values.shell).toEqual({ timeoutMs: 12_000 })
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

    await repository.unset('shell.timeoutMs', 4)

    const mutate = calls.find((call) => call.method === 'settings.mutate')
    expect(mutate?.params).toEqual({
      ns: 'shell',
      ops: [{ op: 'unset', path: ['timeoutMs'] }],
      expectedRevision: 4,
    })
  })

  it('refuses a path without a field segment', async () => {
    const repository = new Rc6SettingsRepository(transportFor({ 'settings.describe': DESCRIBE_FIXTURE }))

    await expect(repository.unset('shell', 4)).rejects.toThrow(/namespace\.field/)
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

    await expect(repository.update('shell.timeoutMs', 30_000, 4)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(calls.map((call) => call.method)).toEqual(['settings.describe'])
  })
})

describe('Rc6SettingsRepository mutate', () => {
  it('forwards an atomic set batch and the caller supplied compare-and-swap revision', async () => {
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

    await repository.mutate(
      'shell',
      [{ op: 'set', path: ['provider', 'gateway'], value: { api: 'openai-completions' } }],
      12,
    )

    expect(calls.at(-1)).toEqual({
      method: 'settings.mutate',
      params: {
        ns: 'shell',
        ops: [{ op: 'set', path: ['provider', 'gateway'], value: { api: 'openai-completions' } }],
        expectedRevision: 12,
      },
    })
  })

  it('rejects a secret marker in a generic mutation before writing it', async () => {
    const calls: Call[] = []
    const repository = new Rc6SettingsRepository(
      transportFor({ 'settings.describe': DESCRIBE_FIXTURE }, calls),
    )

    await expect(
      repository.mutate(
        'web-search-deepseek',
        [{ op: 'set', path: ['apiKeyEnv'], value: '[configured]' }],
        4,
      ),
    ).rejects.toThrow(/credential surface/i)
    expect(calls.map((call) => call.method)).toEqual(['settings.describe'])
  })
})

describe('Rc6SettingsRepository document action', () => {
  it('opens the host-owned settings document without exposing a path', async () => {
    const calls: Call[] = []
    const repository = new Rc6SettingsRepository(
      transportFor({ 'settings.openDocument': { opened: true } }, calls),
    )

    await repository.openDocument?.()

    expect(calls).toEqual([{ method: 'settings.openDocument', params: {} }])
  })

  it('rejects a malformed open-document response', async () => {
    const repository = new Rc6SettingsRepository(transportFor({ 'settings.openDocument': { opened: false } }))

    await expect(repository.openDocument?.()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})

describe('Rc6SettingsRepository revision conflicts', () => {
  it('does not let a fresh Host cache revision authorize a write from an older Webview snapshot', async () => {
    const calls: Call[] = []
    const shellNamespace = DESCRIBE_FIXTURE.namespaces[0]
    if (shellNamespace === undefined) throw new Error('fixture namespace missing')
    let revision = 4
    let timeoutMs = 12_000
    const describeValue = (): RevisionDescribeFixture => ({
      writable: true,
      hasDocument: true,
      namespaces: [
        {
          ...shellNamespace,
          revision,
          value: { timeoutMs, maxOutputBytes: 200_000 },
          user: { timeoutMs },
        },
      ],
    })
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'settings.describe')
          return Promise.resolve({ result: { ok: true, value: describeValue() } } as TResponse)
        if (method === 'settings.mutate') {
          const request = params as {
            readonly expectedRevision: number
            readonly ops: readonly { readonly value?: unknown }[]
          }
          if (request.expectedRevision !== revision)
            return Promise.resolve({
              result: { ok: false, error: { code: 'settings-conflict', message: 'conflict' } },
            } as TResponse)
          timeoutMs = Number(request.ops[0]?.value)
          revision += 1
          return Promise.resolve({ result: { ok: true, value: describeValue().namespaces[0] } } as TResponse)
        }
        return Promise.reject(new Error(`unexpected RPC ${method}`))
      },
      remoteRequest: <TResponse>() =>
        Promise.reject<TResponse>(new Error('the Remote carrier is not part of this contract')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }
    const repository = new Rc6SettingsRepository(transport)
    const displayedSchema = await repository.schema()
    const displayedValues = await repository.read()
    const displayedRevision = displayedSchema.namespaces[0]?.revision
    expect(displayedRevision).toBe(4)
    expect((displayedValues.shell as { timeoutMs: number }).timeoutMs).toBe(12_000)

    // Another DSH surface changes the setting while this Webview keeps its old form open.
    revision = 5
    timeoutMs = 18_000
    // An unrelated Host settings read refreshes the shared adapter cache to revision 5.
    await repository.schema()

    await expect(repository.update('shell.timeoutMs', 12_000, displayedRevision ?? -1)).rejects.toMatchObject(
      { code: 'SETTINGS_CONFLICT' },
    )
    expect(timeoutMs).toBe(18_000)
    expect((calls.at(-1)?.params as { expectedRevision: number }).expectedRevision).toBe(4)
  })

  it('re-describes after a rejected mutate so the invited retry uses a fresh revision', async () => {
    const calls: Call[] = []
    let mutateCalls = 0
    const shellNamespace = DESCRIBE_FIXTURE.namespaces[0]
    if (shellNamespace === undefined) throw new Error('fixture namespace missing')
    const describeValue = (revision: number): typeof DESCRIBE_FIXTURE => ({
      writable: true,
      hasDocument: true,
      namespaces: [{ ...shellNamespace, revision }],
    })
    const transport: DshTransport = {
      request: <TResponse>(method: string, params: unknown) => {
        calls.push({ method, params })
        if (method === 'settings.describe')
          return Promise.resolve({
            result: { ok: true, value: describeValue(mutateCalls === 0 ? 1 : 2) },
          } as TResponse)
        if (method === 'settings.mutate') {
          mutateCalls += 1
          if (mutateCalls === 1)
            return Promise.resolve({
              result: { ok: false, error: { code: 'settings-conflict', message: 'conflict' } },
            } as TResponse)
          const namespace = describeValue(2).namespaces[0]
          return Promise.resolve({ result: { ok: true, value: namespace } } as TResponse)
        }
        return Promise.reject(new Error(`unexpected RPC ${method}`))
      },
      remoteRequest: <TResponse>() =>
        Promise.reject<TResponse>(new Error('the Remote carrier is not part of this contract')),
      openEventStream: async function* () {
        /* fixture stream */
      },
      close: () => Promise.resolve(),
    }
    const repository = new Rc6SettingsRepository(transport)

    // The host bumped the revision externally; the first compare-and-swap
    // loses with the dedicated settings conflict classification.
    await expect(repository.update('shell.timeoutMs', 15_000, 1)).rejects.toMatchObject({
      code: 'SETTINGS_CONFLICT',
    })

    // An adapter retry must use a revision from a new user-visible snapshot,
    // never silently adopt the latest cache revision for the old form.
    await repository.schema()
    await repository.update('shell.timeoutMs', 15_000, 2)

    const mutates = calls.filter((call) => call.method === 'settings.mutate')
    expect(mutates).toHaveLength(2)
    expect((mutates[1]?.params as { expectedRevision: number }).expectedRevision).toBe(2)
  })
})

describe('structured settings credential boundary', () => {
  it.each(['update', 'unset'] as const)(
    'rejects %s over a secret or its container before writing',
    async (operation) => {
      const calls: Call[] = []
      const repository = new Rc6SettingsRepository(
        transportFor(
          {
            'settings.describe': {
              ...DESCRIBE_FIXTURE,
              namespaces: [
                { ...DESCRIBE_FIXTURE.namespaces[0], secrets: [{ path: ['options', 'token'], set: true }] },
              ],
            },
          },
          calls,
        ),
      )
      for (const path of ['shell.options', 'shell.options.token', 'shell.options.token.child']) {
        const result =
          operation === 'update'
            ? repository.update(path, { token: 'replacement' }, 4)
            : repository.unset(path, 4)
        await expect(result).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      }
      expect(calls.filter((call) => call.method !== 'settings.describe')).toEqual([])
    },
  )
  it('sends an object as one path mutation with the current revision', async () => {
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
    await repository.update('shell.options', { args: ['one', 'two'], enabled: false }, 4)
    expect(calls.at(-1)).toEqual({
      method: 'settings.mutate',
      params: {
        ns: 'shell',
        expectedRevision: 4,
        ops: [{ op: 'set', path: ['options'], value: { args: ['one', 'two'], enabled: false } }],
      },
    })
  })
})

describe('nested setting overrides', () => {
  it('marks only present user paths, including false, empty strings and arrays', async () => {
    const repository = new Rc6SettingsRepository(
      transportFor({
        'settings.describe': {
          writable: true,
          hasDocument: true,
          namespaces: [
            {
              ns: 'nested',
              applies: 'live',
              revision: 1,
              secrets: [],
              value: {},
              user: { options: { enabled: false, label: '', items: [] } },
              schema: {
                uid: 6,
                refs: {
                  1: { type: 'boolean' },
                  2: { type: 'string' },
                  3: { type: 'array' },
                  4: { type: 'string' },
                  5: { type: 'object', dict: { enabled: 1, label: 2, items: 3, inherited: 4 } },
                  6: { type: 'object', dict: { options: 5 } },
                },
              },
            },
          ],
        },
      }),
    )
    const schema = await repository.schema()
    expect(schema.namespaces[0]?.userFields).toEqual([
      'options',
      'options.enabled',
      'options.label',
      'options.items',
    ])
  })
})
