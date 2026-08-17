import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6CredentialRepository } from '../src/repositories/credential-repository.js'

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

/** Describe answer exactly as the pinned `credentials.describe` shapes it. */
const DESCRIBE_FIXTURE = {
  credentials: {
    DEEPSEEK_API_KEY: { configured: true, writable: true },
    READ_ONLY_REF: { configured: false, writable: false },
  },
}

const PROVIDER_SCHEMA = {
  uid: 1,
  refs: {
    1: { type: 'object', dict: { apiKeyEnv: 2, displayName: 3 } },
    2: { type: 'string', meta: { role: 'credential-ref' } },
    3: { type: 'string' },
  },
}

const NESTED_PROVIDER_SCHEMA = {
  uid: 5,
  refs: {
    1: { type: 'string', meta: { role: 'credential-ref', description: 'API key' } },
    2: { type: 'string' },
    3: { type: 'object', dict: { apiKeyEnv: 1, baseURL: 2 } },
    4: { type: 'dict', inner: 3 },
    5: { type: 'object', dict: { providers: 4 } },
  },
}

describe('Rc6CredentialRepository explicit references', () => {
  it('describes one reference without ever returning the stored value', async () => {
    const repository = new Rc6CredentialRepository(transportFor({ 'credentials.describe': DESCRIBE_FIXTURE }))

    const state = await repository.describeReference('DEEPSEEK_API_KEY')

    expect(state).toEqual({ ref: 'DEEPSEEK_API_KEY', configured: true, writable: true })
  })

  it('reports an unknown reference as unconfigured but still described', async () => {
    const repository = new Rc6CredentialRepository(transportFor({ 'credentials.describe': DESCRIBE_FIXTURE }))

    const state = await repository.describeReference('SOME_OTHER_REF')

    expect(state).toEqual({ ref: 'SOME_OTHER_REF', configured: false, writable: false })
  })

  it('writes and erases through credentials.set / credentials.unset by reference', async () => {
    const calls: Call[] = []
    const repository = new Rc6CredentialRepository(
      transportFor(
        { 'credentials.set': {}, 'credentials.unset': {}, 'credentials.describe': DESCRIBE_FIXTURE },
        calls,
      ),
    )

    await repository.setReference('DEEPSEEK_API_KEY', 'sk-secret-value')
    await repository.unsetReference('DEEPSEEK_API_KEY')

    expect(calls).toEqual([
      {
        method: 'credentials.set',
        params: { ref: 'DEEPSEEK_API_KEY', value: 'sk-secret-value' },
      },
      { method: 'credentials.unset', params: { ref: 'DEEPSEEK_API_KEY' } },
    ])
  })

  it('refuses an empty value and a malformed reference', async () => {
    const repository = new Rc6CredentialRepository(transportFor({}))

    await expect(repository.setReference('DEEPSEEK_API_KEY', '')).rejects.toThrow(/empty/i)
    await expect(repository.setReference('bad ref!', 'x')).rejects.toThrow(/invalid/i)
    await expect(repository.describeReference('bad ref!')).rejects.toThrow(/invalid/i)
    await expect(repository.describeReference('1STARTS_WITH_DIGIT')).rejects.toThrow(/invalid/i)
    await expect(repository.describeReference('HAS-DASH')).rejects.toThrow(/invalid/i)
    await expect(repository.describeReference('HAS.DOT')).rejects.toThrow(/invalid/i)
  })

  it('rejects a malformed describe answer', async () => {
    const repository = new Rc6CredentialRepository(
      transportFor({ 'credentials.describe': { credentials: 'nope' } }),
    )

    await expect(repository.describeReference('DEEPSEEK_API_KEY')).rejects.toThrow(/malformed credential/i)
  })

  it('rejects a present reference whose required state fields are malformed', async () => {
    const repository = new Rc6CredentialRepository(
      transportFor({
        'credentials.describe': {
          credentials: {
            DEEPSEEK_API_KEY: { configured: 'yes', writable: true },
          },
        },
      }),
    )

    await expect(repository.describeReference('DEEPSEEK_API_KEY')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
})

describe('Rc6CredentialRepository provider fields', () => {
  it('resolves the credential reference from settings value at the provider settingsPath', async () => {
    const calls: Call[] = []
    const repository = new Rc6CredentialRepository(
      transportFor(
        {
          'llm.providers': {
            providers: [
              {
                provider: 'openai',
                displayName: 'OpenAI',
                settingsNs: 'llm-pi-ai',
                settingsPath: ['providers', 'openai'],
                active: true,
              },
            ],
          },
          'settings.describe': {
            writable: true,
            hasDocument: true,
            namespaces: [
              {
                ns: 'llm-pi-ai',
                schema: NESTED_PROVIDER_SCHEMA,
                value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
                applies: 'live',
                secrets: [],
                revision: 0,
              },
            ],
          },
          'credentials.describe': {
            credentials: { OPENAI_API_KEY: { configured: false, writable: true } },
          },
          'credentials.set': {},
        },
        calls,
      ),
    )

    await repository.setSecret('openai', 'apiKeyEnv', 'sk-host-only')

    expect(calls).toEqual([
      { method: 'llm.providers', params: {} },
      { method: 'settings.describe', params: {} },
      { method: 'credentials.describe', params: { refs: ['OPENAI_API_KEY'] } },
      {
        method: 'credentials.set',
        params: { ref: 'OPENAI_API_KEY', value: 'sk-host-only' },
      },
    ])
  })

  it('refuses an environment-shadowed credential reference before attempting a write', async () => {
    const calls: Call[] = []
    const repository = new Rc6CredentialRepository(
      transportFor(
        {
          'llm.providers': {
            providers: [
              {
                provider: 'deepseek-official',
                displayName: 'DeepSeek',
                settingsNs: 'llm-deepseek',
                settingsPath: [],
                active: true,
              },
            ],
          },
          'settings.describe': {
            writable: true,
            hasDocument: true,
            namespaces: [
              {
                ns: 'llm-deepseek',
                schema: PROVIDER_SCHEMA,
                value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
                applies: 'live',
                secrets: [],
                revision: 0,
              },
            ],
          },
          'credentials.describe': {
            credentials: {
              DEEPSEEK_API_KEY: { configured: true, source: 'env', writable: false },
            },
          },
          'credentials.set': {},
        },
        calls,
      ),
    )

    await expect(repository.setSecret('deepseek-official', 'apiKeyEnv', 'replacement')).rejects.toMatchObject(
      { code: 'PERMISSION_DENIED' },
    )
    expect(calls.some((call) => call.method === 'credentials.set')).toBe(false)
  })

  it('requires the provider schema field to declare the credential-ref role', async () => {
    const calls: Call[] = []
    const repository = new Rc6CredentialRepository(
      transportFor(
        {
          'llm.providers': {
            providers: [
              {
                provider: 'openai',
                displayName: 'OpenAI',
                settingsNs: 'llm-pi-ai',
                settingsPath: [],
                active: true,
              },
            ],
          },
          'settings.describe': {
            writable: true,
            hasDocument: true,
            namespaces: [
              {
                ns: 'llm-pi-ai',
                schema: PROVIDER_SCHEMA,
                value: { apiKeyEnv: 'OPENAI_API_KEY', displayName: 'OpenAI' },
                applies: 'live',
                secrets: [],
                revision: 0,
              },
            ],
          },
          'credentials.describe': {
            credentials: { OPENAI_API_KEY: { configured: false, writable: true } },
          },
          'credentials.set': {},
        },
        calls,
      ),
    )

    await repository.setSecret('openai', 'apiKeyEnv', 'sk-host-only')
    expect(calls.some((call) => call.method === 'credentials.set')).toBe(true)

    const ordinaryField = new Rc6CredentialRepository(
      transportFor({
        'llm.providers': {
          providers: [
            {
              provider: 'openai',
              displayName: 'OpenAI',
              settingsNs: 'llm-pi-ai',
              settingsPath: [],
              active: true,
            },
          ],
        },
        'settings.describe': {
          writable: true,
          hasDocument: true,
          namespaces: [
            {
              ns: 'llm-pi-ai',
              schema: PROVIDER_SCHEMA,
              value: { apiKeyEnv: 'OPENAI_API_KEY', displayName: 'OpenAI' },
              applies: 'live',
              secrets: [],
              revision: 0,
            },
          ],
        },
      }),
    )
    await expect(ordinaryField.setSecret('openai', 'displayName', 'evil')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })
})
