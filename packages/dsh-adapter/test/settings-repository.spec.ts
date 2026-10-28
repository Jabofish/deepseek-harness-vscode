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
})
