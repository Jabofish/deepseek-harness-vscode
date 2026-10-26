import { describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
import { Rc6ModelRepository } from '../src/repositories/model-repository.js'

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
      if (response instanceof Error) return Promise.reject(response)
      return Promise.resolve({ result: { ok: true, value: response } } as TResponse)
    },
    remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote call')),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

const PROVIDER_SCHEMA = {
  uid: 5,
  refs: {
    1: {
      type: 'string',
      meta: { role: 'credential-ref', description: 'API key' },
    },
    2: { type: 'string' },
    3: { type: 'object', dict: { apiKeyEnv: 1, baseURL: 2 } },
    4: { type: 'dict', inner: 3 },
    5: { type: 'object', dict: { providers: 4 } },
  },
}

const PROVIDER_SCHEMA_WITH_API_PROTOCOL = {
  uid: 8,
  refs: {
    1: { type: 'string', meta: { role: 'credential-ref', description: 'API key' } },
    2: { type: 'string' },
    3: { type: 'const', value: 'openai-completions' },
    4: { type: 'const', value: 'anthropic-messages' },
    5: { type: 'union', list: [3, 4], meta: { required: true } },
    6: { type: 'object', dict: { apiKeyEnv: 1, baseURL: 2, api: 5 } },
    7: { type: 'dict', inner: 6 },
    8: { type: 'object', dict: { providers: 7 } },
  },
}

describe('Rc6ModelRepository provider configuration', () => {
  it('preserves dynamic API protocol choices from the provider Schemastery union', async () => {
    const repository = new Rc6ModelRepository(
      transportFor({
        'llm.providers': {
          providers: [
            {
              provider: 'openai',
              displayName: 'OpenAI',
              settingsNs: 'llm-pi-ai',
              settingsPath: ['providers', 'openai'],
              active: false,
              declared: false,
            },
          ],
        },
        'settings.describe': {
          writable: true,
          hasDocument: true,
          namespaces: [
            {
              ns: 'llm-pi-ai',
              schema: PROVIDER_SCHEMA_WITH_API_PROTOCOL,
              value: { providers: { openai: { api: 'openai-completions' } } },
              applies: 'live',
              secrets: [],
              revision: 7,
            },
          ],
        },
      }),
    )

    const [provider] = await repository.listProviders()
    expect(provider?.id).toBe('openai')
    expect(provider?.fields.find((field) => field.key === 'api')).toEqual({
      key: 'api',
      label: 'api',
      secret: false,
      required: true,
      enumValues: ['openai-completions', 'anthropic-messages'],
      value: 'openai-completions',
    })
  })

  it('derives credential-ref fields through a provider settingsPath and reads only credential state', async () => {
    const calls: Call[] = []
    const repository = new Rc6ModelRepository(
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
                declared: true,
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
                value: {
                  providers: {
                    openai: {
                      apiKeyEnv: 'OPENAI_API_KEY',
                      baseURL: 'https://api.openai.com/v1',
                    },
                  },
                },
                applies: 'live',
                secrets: [],
                revision: 0,
              },
            ],
          },
          'credentials.describe': {
            credentials: {
              OPENAI_API_KEY: { configured: true, source: 'env', writable: false },
            },
          },
        },
        calls,
      ),
    )

    await expect(repository.listProviders()).resolves.toEqual([
      expect.objectContaining({
        id: 'openai',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        fields: [
          {
            key: 'apiKeyEnv',
            label: 'API key',
            secret: true,
            required: false,
            writable: false,
            value: '[configured]',
          },
          {
            key: 'baseURL',
            label: 'baseURL',
            secret: false,
            required: false,
            value: 'https://api.openai.com/v1',
          },
        ],
      }),
    ])
    expect(calls.at(-1)).toEqual({
      method: 'credentials.describe',
      params: { refs: ['OPENAI_API_KEY'] },
    })
  })

  it.each([
    ['malformed', { OPENAI_API_KEY: { configured: 'yes', writable: true } }],
    ['omitted', {}],
  ])(
    'rejects %s credential state instead of presenting a writable secret button',
    async (_kind, credentials) => {
      const repository = new Rc6ModelRepository(
        transportFor({
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
                schema: PROVIDER_SCHEMA,
                value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
                applies: 'live',
                secrets: [],
                revision: 0,
              },
            ],
          },
          'credentials.describe': { credentials },
        }),
      )

      await expect(repository.listProviders()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    },
  )

  it('strips credential provider details before a provider catalog error can escape', async () => {
    const password = 'password-value-from-provider'
    const rejection = new AppError({
      code: 'PERMISSION_DENIED',
      message: `credential provider refused password=${password}`,
      retryable: false,
      cause: new Error(`provider detail ${password}`),
      context: { diagnostic: password },
    })
    const repository = new Rc6ModelRepository(
      transportFor({
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
              schema: PROVIDER_SCHEMA,
              value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
              applies: 'live',
              secrets: [],
              revision: 0,
            },
          ],
        },
        'credentials.describe': rejection,
      }),
    )

    let failure: unknown
    try {
      await repository.listProviders()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AppError)
    const safeError = failure as AppError
    expect(safeError).toMatchObject({ code: 'PERMISSION_DENIED', retryable: false })
    expect(safeError.message).not.toContain(password)
    expect(safeError.message).not.toContain('password')
    expect(safeError.context).toBeUndefined()
    expect((safeError as AppError & { readonly cause?: unknown }).cause).toBeUndefined()
    expect(
      JSON.stringify({
        code: safeError.code,
        message: safeError.message,
        retryable: safeError.retryable,
        context: safeError.context,
        cause: (safeError as AppError & { readonly cause?: unknown }).cause,
      }),
    ).not.toContain(password)
  })

  it('discovers models through the pinned llm route without requiring a Webview secret', async () => {
    const calls: Call[] = []
    const repository = new Rc6ModelRepository(
      transportFor(
        {
          'llm.discoverModels': {
            models: [
              {
                id: 'gateway-chat',
                name: 'Gateway Chat',
                contextWindow: 128_000,
                maxTokens: 8_000,
                inputModalities: ['text', 'image'],
              },
              { id: 'gateway-reasoner' },
            ],
          },
        },
        calls,
      ),
    )

    await expect(
      repository.discoverModels({
        settingsNamespace: 'llm-pi-ai',
        providerId: 'gateway',
        baseUrl: 'http://127.0.0.1:9000/v1',
        api: 'openai-completions',
      }),
    ).resolves.toEqual([
      {
        id: 'gateway-chat',
        label: 'Gateway Chat',
        contextWindow: 128_000,
        maxTokens: 8_000,
        inputModalities: ['text', 'image'],
      },
      { id: 'gateway-reasoner', label: 'gateway-reasoner' },
    ])
    expect(calls).toEqual([
      {
        method: 'llm.discoverModels',
        params: {
          settingsNs: 'llm-pi-ai',
          provider: 'gateway',
          baseURL: 'http://127.0.0.1:9000/v1',
          api: 'openai-completions',
        },
      },
    ])
  })

  it('rejects malformed discovered model rows', async () => {
    const repository = new Rc6ModelRepository(
      transportFor({ 'llm.discoverModels': { models: [{ id: 'broken', contextWindow: 0 }] } }),
    )

    await expect(repository.discoverModels({ settingsNamespace: 'llm-pi-ai' })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
})

describe('Rc6ModelRepository model input capabilities', () => {
  it('rejects unsupported model input modality values instead of hiding the declaration', async () => {
    const repository = new Rc6ModelRepository(
      transportFor({
        'llm.models': {
          groups: [
            {
              id: 'gateway',
              name: 'Gateway',
              models: [{ id: 'model-a', name: 'Model A', inputModalities: ['video'] }],
            },
          ],
          failures: [],
        },
      }),
    )

    await expect(repository.listModels()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})

it('preserves installed model input modalities while mapping the provider catalog', async () => {
  const repository = new Rc6ModelRepository(
    transportFor({
      'llm.models': {
        groups: [
          {
            id: 'deepseek-account',
            name: 'DeepSeek Account',
            models: [
              {
                id: 'deepseek-v4',
                name: 'DeepSeek V4',
                inputModalities: ['text', 'image'],
              },
            ],
          },
        ],
        failures: [],
      },
    }),
  )

  await expect(repository.listModels()).resolves.toEqual([
    {
      id: 'deepseek-v4',
      providerId: 'deepseek-account',
      label: 'DeepSeek V4',
      inputModalities: ['text', 'image'],
      supportsReasoning: false,
    },
  ])
})

it('keeps a provider-local failure whole alongside the groups that did load', async () => {
  const message = `gateway rejected the credential: ${'the token expired at the last rotation; '.repeat(200)}`

  const repository = new Rc6ModelRepository(
    transportFor({
      'session.models': {
        current: { provider: 'deepseek', model: 'deepseek-chat' },
        routable: true,
        groups: [
          { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
        ],
        failures: [{ id: 'gateway', name: 'Gateway', message }],
      },
    }),
  )

  await expect(repository.listSessionModels('session-1')).resolves.toEqual({
    current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    routable: true,
    models: [
      { id: 'deepseek-chat', providerId: 'deepseek', label: 'DeepSeek Chat', supportsReasoning: false },
    ],
    failures: [{ providerId: 'gateway', providerName: 'Gateway', message }],
  })
})
