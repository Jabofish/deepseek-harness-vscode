import { describe, expect, it, vi } from 'vitest'
import type {
  CustomProviderDraft,
  DshBackend,
  ModelProvider,
  SettingsPathOperation,
} from '@dsh-vscode/domain'
import { BackendService } from '../src/services/backend-service.js'
import { ProviderSettingsUseCases } from '../src/use-cases/provider-settings-use-cases.js'

const templateProvider: ModelProvider = {
  id: 'openai',
  name: 'OpenAI',
  kind: 'remote',
  configurable: true,
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'openai'],
  fields: [
    {
      key: 'api',
      label: 'API protocol',
      secret: false,
      required: true,
      enumValues: ['openai-completions', 'anthropic-messages'],
    },
  ],
}

const draft: CustomProviderDraft = {
  settingsNamespace: 'llm-pi-ai',
  collectionPath: ['providers'],
  providerId: 'gateway',
  displayName: 'Gateway',
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:9000/v1',
  models: [{ id: 'gateway-chat', name: 'Gateway Chat', contextWindow: 128_000 }],
  expectedRevision: 7,
}

type SettingsMutate = (
  namespace: string,
  operations: readonly SettingsPathOperation[],
  expectedRevision?: number,
  signal?: AbortSignal,
) => Promise<void>
type SetReference = (ref: string, value: string, signal?: AbortSignal) => Promise<void>

function providerUseCasesFor(
  settings: { readonly mutate: SettingsMutate },
  credentials: { readonly setReference: SetReference },
  providers: readonly ModelProvider[] = [templateProvider],
): ProviderSettingsUseCases {
  const backend = {
    events: { subscribe: vi.fn(() => () => undefined) },
    models: { listProviders: vi.fn().mockResolvedValue(providers) },
    settings,
    credentials,
  } as unknown as DshBackend
  const service = new BackendService()
  service.attach(backend, () => undefined)
  return new ProviderSettingsUseCases(service)
}

describe('ProviderSettingsUseCases', () => {
  it('commits the profile with the captured revision before storing a Host-only key', async () => {
    const mutate = vi.fn<SettingsMutate>().mockResolvedValue(undefined)
    const setReference = vi.fn<SetReference>().mockResolvedValue(undefined)

    await expect(
      providerUseCasesFor({ mutate }, { setReference }).createCustomProvider(draft, ' sk-gateway '),
    ).resolves.toEqual({ profileCommitted: true, credentialConfigured: true })

    expect(mutate).toHaveBeenCalledWith(
      'llm-pi-ai',
      [
        {
          op: 'set',
          path: ['providers', 'gateway'],
          value: {
            displayName: 'Gateway',
            apiKeyEnv: 'GATEWAY_API_KEY',
            api: 'openai-completions',
            baseURL: 'http://127.0.0.1:9000/v1',
            models: [{ id: 'gateway-chat', name: 'Gateway Chat', contextWindow: 128_000 }],
          },
        },
      ],
      7,
      undefined,
    )
    expect(setReference).toHaveBeenCalledWith('GATEWAY_API_KEY', 'sk-gateway', undefined)
  })

  it('omits the credential reference for a keyless native-auth profile', async () => {
    const mutate = vi.fn<SettingsMutate>().mockResolvedValue(undefined)
    const setReference = vi.fn<SetReference>().mockResolvedValue(undefined)

    await expect(
      providerUseCasesFor({ mutate }, { setReference }).createCustomProvider(draft, undefined),
    ).resolves.toEqual({
      profileCommitted: true,
      credentialConfigured: false,
    })

    const operation = mutate.mock.calls[0]?.[1]?.[0]
    expect(operation?.op).toBe('set')
    if (operation?.op === 'set') {
      expect(operation.value).toEqual({
        displayName: 'Gateway',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9000/v1',
        models: [{ id: 'gateway-chat', name: 'Gateway Chat', contextWindow: 128_000 }],
      })
    }
    expect(setReference).not.toHaveBeenCalled()
  })

  it('preserves valid modality declarations and unrelated provider model metadata', async () => {
    const mutate = vi.fn<SettingsMutate>().mockResolvedValue(undefined)
    const setReference = vi.fn<SetReference>().mockResolvedValue(undefined)
    const models = [
      {
        id: 'gateway-chat',
        input: ['text', 'image'],
        inputModalities: ['text', 'image'],
        providerFeatures: { cachedPrompts: true },
      },
    ]

    await expect(
      providerUseCasesFor({ mutate }, { setReference }).createCustomProvider({ ...draft, models }, undefined),
    ).resolves.toEqual({ profileCommitted: true, credentialConfigured: false })

    const operation = mutate.mock.calls[0]?.[1]?.[0]
    expect(operation?.op).toBe('set')
    if (operation?.op === 'set')
      expect(operation.value).toEqual({
        displayName: 'Gateway',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9000/v1',
        models,
      })
  })

  it('preserves an empty pi-ai input list as the inherited-input sentinel', async () => {
    const mutate = vi.fn<SettingsMutate>().mockResolvedValue(undefined)
    const setReference = vi.fn<SetReference>().mockResolvedValue(undefined)
    const models = [{ id: 'gateway-chat', input: [] }]

    await expect(
      providerUseCasesFor({ mutate }, { setReference }).createCustomProvider({ ...draft, models }, undefined),
    ).resolves.toEqual({ profileCommitted: true, credentialConfigured: false })

    const operation = mutate.mock.calls[0]?.[1]?.[0]
    expect(operation?.op).toBe('set')
    if (operation?.op === 'set')
      expect(operation.value).toEqual({
        displayName: 'Gateway',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9000/v1',
        models,
      })
  })

  it('reports a credential-only failure without retrying the committed profile', async () => {
    const mutate = vi.fn<SettingsMutate>().mockResolvedValue(undefined)
    const setReference = vi.fn<SetReference>().mockRejectedValue(new Error('credential store unavailable'))

    await expect(
      providerUseCasesFor({ mutate }, { setReference }).createCustomProvider(draft, 'sk-gateway'),
    ).resolves.toEqual({
      profileCommitted: true,
      credentialConfigured: false,
      credentialError: 'The API key could not be stored. Try again from the provider row.',
    })
    expect(mutate).toHaveBeenCalledOnce()
    expect(setReference).toHaveBeenCalledOnce()
  })

  it('rejects collisions, unsupported protocols, and an unadvertised settings collection', async () => {
    const cases: readonly [string, CustomProviderDraft, readonly ModelProvider[], string][] = [
      ['collision', { ...draft, providerId: 'openai' }, [templateProvider], 'INVALID_CONFIGURATION'],
      ['protocol', { ...draft, api: 'unknown-protocol' }, [templateProvider], 'INVALID_CONFIGURATION'],
      [
        'collection',
        draft,
        [{ ...templateProvider, settingsPath: ['other', 'openai'] }],
        'CAPABILITY_UNAVAILABLE',
      ],
    ]

    for (const [name, input, providers, code] of cases) {
      const mutate = vi.fn<SettingsMutate>().mockResolvedValue(undefined)
      const setReference = vi.fn<SetReference>().mockResolvedValue(undefined)
      await expect(
        providerUseCasesFor({ mutate }, { setReference }, providers).createCustomProvider(input, undefined),
        name,
      ).rejects.toMatchObject({ code })
      expect(mutate).not.toHaveBeenCalled()
    }
  })

  it('rejects malformed or credential-shaped model metadata before settings.mutate', async () => {
    const malformedModels: readonly CustomProviderDraft['models'][] = [
      [{ id: 'x'.repeat(257) }],
      [{ id: 'gateway-chat', contextWindow: Number.MAX_SAFE_INTEGER + 1 }],
      [{ id: 'gateway-chat', input: 'image' }],
      [{ id: 'gateway-chat', input: ['audio'] }],
      [{ id: 'gateway-chat', inputModalities: 'image' }],
      [{ id: 'gateway-chat', inputModalities: ['audio'] }],
      [{ id: 'gateway-chat', inputModalities: [] }],
      [{ id: 'gateway-chat', metadata: { apiKey: 'must-stay-in-host' } }],
    ]

    for (const models of malformedModels) {
      const mutate = vi.fn<SettingsMutate>().mockResolvedValue(undefined)
      const setReference = vi.fn<SetReference>().mockResolvedValue(undefined)
      await expect(
        providerUseCasesFor({ mutate }, { setReference }).createCustomProvider(
          { ...draft, models },
          undefined,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
      expect(mutate).not.toHaveBeenCalled()
    }
  })
})
