import {
  AppError,
  deriveProviderCredentialReference,
  isValidCustomProviderId,
  type CustomProviderCreateResult,
  type CustomProviderDraft,
  type ModelProvider,
} from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

const MAX_CUSTOM_PROVIDER_MODELS = 1024
const MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH = 256
const MAX_CUSTOM_PROVIDER_MODEL_NAME_LENGTH = 512
const SENSITIVE_MODEL_KEYS = new Set(
  [
    'apiKey',
    'accessToken',
    'authorization',
    'password',
    'secret',
    'secretKey',
    'privateKey',
    'token',
    'credential',
    'credentials',
    'auth',
    'headers',
    'cookies',
  ].map(normalizeModelKey),
)

/** Host-side orchestration for provider settings and write-only credentials. */
export class ProviderSettingsUseCases {
  public constructor(private readonly backendService: BackendService) {}

  /**
   * Create one provider profile and, when the Host collected a key, store the
   * key only after the compare-and-swap profile write has committed.
   */
  public async createCustomProvider(
    input: CustomProviderDraft,
    apiKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<CustomProviderCreateResult> {
    const draft = validateDraft(input)
    const backend = this.backendService.requireBackend()
    const providers = await backend.models.listProviders(signal)
    validateTarget(draft, providers)

    const normalizedKey = apiKey === undefined ? undefined : apiKey.trim()
    const keyRef =
      normalizedKey === undefined || normalizedKey === ''
        ? undefined
        : deriveProviderCredentialReference(draft.providerId)
    const profile = {
      ...(draft.displayName === undefined || draft.displayName.trim() === ''
        ? {}
        : { displayName: draft.displayName.trim() }),
      ...(keyRef === undefined ? {} : { apiKeyEnv: keyRef }),
      api: draft.api,
      baseURL: draft.baseUrl,
      models: draft.models.map((model) => ({ ...model })),
    }

    await backend.settings.mutate(
      draft.settingsNamespace,
      [
        {
          op: 'set',
          path: [...draft.collectionPath, draft.providerId],
          value: profile,
        },
      ],
      draft.expectedRevision,
      signal,
    )

    if (keyRef === undefined || normalizedKey === undefined || normalizedKey === '')
      return { profileCommitted: true, credentialConfigured: false }

    try {
      await backend.credentials.setReference(keyRef, normalizedKey, signal)
      return { profileCommitted: true, credentialConfigured: true }
    } catch (error) {
      if (signal?.aborted === true) throw error
      return {
        profileCommitted: true,
        credentialConfigured: false,
        credentialError: safeCredentialFailure(),
      }
    }
  }
}

function validateDraft(input: CustomProviderDraft): CustomProviderDraft {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw invalidDraft('The provider draft is invalid.')
  const candidate = input as unknown as Readonly<Record<string, unknown>>
  const providerId = typeof candidate.providerId === 'string' ? candidate.providerId.trim() : ''
  if (!isValidCustomProviderId(providerId)) throw invalidDraft('The provider ID is invalid.')
  const namespace = typeof candidate.settingsNamespace === 'string' ? candidate.settingsNamespace.trim() : ''
  if (namespace === '') throw invalidDraft('The provider settings namespace is required.')
  const collectionPathInput = candidate.collectionPath
  if (
    !Array.isArray(collectionPathInput) ||
    collectionPathInput.length === 0 ||
    collectionPathInput.some((part) => typeof part !== 'string' || part.trim() === '' || part !== part.trim())
  )
    throw invalidDraft('The provider settings path is invalid.')
  const collectionPath = collectionPathInput as readonly string[]
  const displayNameInput = candidate.displayName
  if (displayNameInput !== undefined && typeof displayNameInput !== 'string')
    throw invalidDraft('The provider display name is invalid.')
  const displayName = typeof displayNameInput === 'string' ? displayNameInput.trim() : undefined
  const api = typeof candidate.api === 'string' ? candidate.api.trim() : ''
  if (api === '') throw invalidDraft('The provider API protocol is required.')
  const baseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl.trim() : ''
  if (baseUrl === '') throw invalidDraft('The provider base URL is required.')
  const expectedRevision = candidate.expectedRevision
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw invalidDraft('The provider settings revision is invalid.')
  const modelsInput = candidate.models
  if (
    !Array.isArray(modelsInput) ||
    modelsInput.length === 0 ||
    modelsInput.length > MAX_CUSTOM_PROVIDER_MODELS
  )
    throw invalidDraft('At least one provider model is required.')

  const ids = new Set<string>()
  const models = modelsInput.map((model) => {
    if (typeof model !== 'object' || model === null || Array.isArray(model))
      throw invalidDraft('A provider model is invalid.')
    const record = model as Readonly<Record<string, unknown>>
    if (containsSensitiveModelKey(record))
      throw invalidDraft('Provider model metadata must not contain credential fields.')
    const id = record.id
    const normalizedId = typeof id === 'string' ? id.trim() : ''
    if (
      normalizedId === '' ||
      normalizedId.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH ||
      ids.has(normalizedId)
    )
      throw invalidDraft('Provider model IDs must be non-empty and unique.')
    const name = record.name
    if (
      name !== undefined &&
      (typeof name !== 'string' || name.trim() === '' || name.length > MAX_CUSTOM_PROVIDER_MODEL_NAME_LENGTH)
    )
      throw invalidDraft('A provider model name is invalid.')
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const value = record[field]
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0))
        throw invalidDraft(`Provider model ${field} is invalid.`)
    }
    ids.add(normalizedId)
    const stringName = typeof name === 'string' ? name : undefined
    const normalized: Record<string, unknown> = { ...record, id: normalizedId }
    if (stringName === undefined || stringName.trim() === '') delete normalized.name
    else normalized.name = stringName.trim()
    return normalized
  })

  return {
    settingsNamespace: namespace,
    collectionPath,
    providerId,
    ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    api,
    baseUrl,
    models,
    expectedRevision,
  }
}

function validateTarget(input: CustomProviderDraft, providers: readonly ModelProvider[]): void {
  const existing = providers.find((provider) => provider.id === input.providerId)
  if (existing !== undefined) throw invalidDraft('This provider ID is already in use.')

  const hasCollection = providers.some((provider) => {
    if (
      provider.settingsNs !== input.settingsNamespace ||
      provider.settingsPath === undefined ||
      provider.settingsPath.length < 2
    )
      return false
    const prefix = provider.settingsPath.slice(0, -1)
    return (
      prefix.length === input.collectionPath.length &&
      prefix.every((part, index) => part === input.collectionPath[index])
    )
  })
  if (!hasCollection)
    throw new AppError({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'The connected DSH did not advertise a writable custom-provider settings collection.',
      retryable: false,
    })

  const template = providers.find((provider) => {
    if (
      provider.settingsNs !== input.settingsNamespace ||
      provider.settingsPath === undefined ||
      provider.settingsPath.length < 2
    )
      return false
    const prefix = provider.settingsPath.slice(0, -1)
    return (
      prefix.length === input.collectionPath.length &&
      prefix.every((part, index) => part === input.collectionPath[index])
    )
  })
  const protocols = template?.fields.find((field) => field.key === 'api')?.enumValues
  if (protocols === undefined || protocols.length === 0)
    throw new AppError({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'The connected DSH did not advertise custom-provider API protocols.',
      retryable: false,
    })
  if (!protocols.includes(input.api))
    throw invalidDraft('The selected provider API protocol is not supported by DSH.')
}

function invalidDraft(message: string): AppError {
  return new AppError({ code: 'INVALID_CONFIGURATION', message, retryable: false })
}

function safeCredentialFailure(): string {
  // Do not reflect arbitrary credentials-service text: a backend error may
  // include a pasted key or an environment value. The UI only needs the safe
  // recovery action, which retries credentials.set without repeating mutate.
  return 'The API key could not be stored. Try again from the provider row.'
}

function normalizeModelKey(key: string): string {
  return key.replace(/[-_]/gu, '').toLowerCase()
}

function containsSensitiveModelKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveModelKey(entry, seen))
  return Object.entries(value).some(
    ([key, child]) =>
      SENSITIVE_MODEL_KEYS.has(normalizeModelKey(key)) || containsSensitiveModelKey(child, seen),
  )
}
