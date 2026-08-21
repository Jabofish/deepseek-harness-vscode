import { describe, expect, it } from 'vitest'

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

describe('Rc6ModelRepository provider configuration', () => {
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

  it('rejects malformed credential state instead of presenting a writable secret button', async () => {
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
        'credentials.describe': {
          credentials: { OPENAI_API_KEY: { configured: 'yes', writable: true } },
        },
      }),
    )

    await expect(repository.listProviders()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('discovers models through the pinned llm route without requiring a Webview secret', async () => {
    const calls: Call[] = []
    const repository = new Rc6ModelRepository(
      transportFor(
        {
          'llm.discoverModels': {
            models: [
              { id: 'gateway-chat', name: 'Gateway Chat', contextWindow: 128_000, maxTokens: 8_000 },
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
      { id: 'gateway-chat', label: 'Gateway Chat', contextWindow: 128_000, maxTokens: 8_000 },
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
