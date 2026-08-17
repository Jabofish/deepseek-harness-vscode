import {
  AppError,
  type DiscoveredModel,
  type ModelDescriptor,
  type ModelProvider,
  type ModelRepository,
  type ModelDiscoveryInput,
  type SessionModelCatalog,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'
import {
  schemasteryChildEntries,
  schemasteryNodeAtPath,
  type SerializedSchemaNode,
} from '../versions/rc6/schemastery.js'

interface ProviderFieldDraft {
  readonly field: ModelProvider['fields'][number]
  readonly credentialRef?: string
}

export class Rc6ModelRepository implements ModelRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async listProviders(signal?: AbortSignal): Promise<readonly ModelProvider[]> {
    const value = recordOrUndefined(await callRpc<unknown>(this.transport, 'llm.providers', {}, signal))
    if (value === undefined || !Array.isArray(value.providers) || !value.providers.every(validProviderView))
      throw malformedModels('provider list')
    const providers = value.providers.map((provider) => rc6Mapper.provider(provider))
    const settings = recordOrUndefined(
      await callRpc<unknown>(this.transport, 'settings.describe', {}, signal),
    )
    if (
      settings === undefined ||
      typeof settings.writable !== 'boolean' ||
      typeof settings.hasDocument !== 'boolean' ||
      !Array.isArray(settings.namespaces) ||
      !settings.namespaces.every(validSettingsNamespace)
    )
      throw malformedModels('settings namespace list')
    const namespaces = settings.namespaces.map((entry) => recordOrUndefined(entry) as Record<string, unknown>)
    const drafts = providers.map((provider) => {
      const namespace = namespaces.map(asRecord).find((entry) => entry.ns === provider.settingsNs)
      if (namespace === undefined) return { provider, fields: [] as readonly ProviderFieldDraft[] }
      return {
        provider,
        fields: describeProviderFields(namespace, provider.settingsPath ?? []),
      }
    })
    const credentialRefs = [
      ...new Set(
        drafts.flatMap((draft) =>
          draft.fields.flatMap((field) => (field.credentialRef === undefined ? [] : [field.credentialRef])),
        ),
      ),
    ]
    const credentialStates = await describeCredentialReferences(this.transport, credentialRefs, signal)
    return drafts.map(({ provider, fields: derived }) => {
      if (derived.length === 0) return provider
      const fields = new Map(provider.fields.map((field) => [field.key, field]))
      for (const draft of derived) {
        const state =
          draft.credentialRef === undefined ? undefined : credentialStates.get(draft.credentialRef)
        fields.set(draft.field.key, {
          ...draft.field,
          ...(state === undefined ? {} : { writable: state.writable }),
          ...(state?.configured === true ? { value: '[configured]' } : {}),
        })
      }
      return { ...provider, fields: [...fields.values()] }
    })
  }

  public async listModels(providerId?: string, signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    const value = recordOrUndefined(await callRpc<unknown>(this.transport, 'llm.models', {}, signal))
    if (
      value === undefined ||
      !Array.isArray(value.groups) ||
      !value.groups.every(validModelProviderGroup) ||
      !Array.isArray(value.failures) ||
      !value.failures.every(validModelCatalogFailure)
    )
      throw malformedModels('model catalog')
    const models = value.groups.flatMap((group) => {
      const record = recordOrUndefined(group) as Record<string, unknown>
      const provider = record.id as string
      if (providerId !== undefined && provider !== providerId) return []
      return (record.models as readonly unknown[]).map((model) =>
        rc6Mapper.model({ ...asRecord(model), providerId: provider }),
      )
    })
    return models
  }

  public async listSessionModels(sessionId: string, signal?: AbortSignal): Promise<SessionModelCatalog> {
    const value = recordOrUndefined(
      await callRpc<unknown>(this.transport, 'session.models', { sessionId }, signal),
    )
    const current = recordOrUndefined(value?.current)
    if (
      value === undefined ||
      current === undefined ||
      !validModelSelection(current) ||
      typeof value.routable !== 'boolean' ||
      !Array.isArray(value.groups) ||
      !value.groups.every(validModelProviderGroup) ||
      !Array.isArray(value.failures) ||
      !value.failures.every(validModelCatalogFailure)
    )
      throw malformedModels('session model catalog')
    const models = value.groups.flatMap((group) => {
      const record = recordOrUndefined(group) as Record<string, unknown>
      const providerId = record.id as string
      return (record.models as readonly unknown[]).map((model) =>
        rc6Mapper.model({ ...asRecord(model), providerId }),
      )
    })
    const failures = value.failures.map((failure) => {
      const record = recordOrUndefined(failure) as Record<string, unknown>
      return { providerId: record.id as string, message: (record.message as string).slice(0, 512) }
    })
    return {
      current: {
        providerId: current.provider,
        modelId: current.model,
        ...(current.reasoningEffort === undefined ? {} : { reasoningLevel: current.reasoningEffort }),
      },
      routable: value.routable,
      models,
      failures,
    }
  }

  public async discoverModels(
    input: ModelDiscoveryInput,
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredModel[]> {
    const value = recordOrUndefined(
      await callRpc<unknown>(
        this.transport,
        'llm.discoverModels',
        {
          settingsNs: input.settingsNamespace,
          ...(input.providerId === undefined ? {} : { provider: input.providerId }),
          ...(input.baseUrl === undefined ? {} : { baseURL: input.baseUrl }),
          ...(input.api === undefined ? {} : { api: input.api }),
          ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        },
        signal,
      ),
    )
    if (value === undefined || !Array.isArray(value.models) || !value.models.every(validDiscoveredModel))
      throw malformedModels('discovered model list')
    return value.models.map((model) => {
      const record = recordOrUndefined(model) as Record<string, unknown>
      return {
        id: record.id as string,
        label: record.name === undefined ? (record.id as string) : (record.name as string),
        ...(record.contextWindow === undefined ? {} : { contextWindow: record.contextWindow as number }),
        ...(record.maxTokens === undefined ? {} : { maxTokens: record.maxTokens as number }),
      }
    })
  }
}

function malformedModels(kind: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed ${kind}.`,
    retryable: false,
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validProviderView(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    nonEmptyString(record.provider) &&
    nonEmptyString(record.displayName) &&
    typeof record.settingsNs === 'string' &&
    Array.isArray(record.settingsPath) &&
    record.settingsPath.every((part): part is string => typeof part === 'string') &&
    typeof record.active === 'boolean' &&
    (record.declared === undefined || typeof record.declared === 'boolean')
  )
}

function validSettingsNamespace(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    nonEmptyString(record.ns) &&
    Object.prototype.hasOwnProperty.call(record, 'schema') &&
    Object.prototype.hasOwnProperty.call(record, 'value') &&
    (record.base === undefined || Object.prototype.hasOwnProperty.call(record, 'base')) &&
    (record.user === undefined || Object.prototype.hasOwnProperty.call(record, 'user')) &&
    (record.applies === 'live' || record.applies === 'restart') &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) >= 0 &&
    Array.isArray(record.secrets) &&
    record.secrets.every((secret) => {
      const item = recordOrUndefined(secret)
      return (
        item !== undefined &&
        Array.isArray(item.path) &&
        item.path.length > 0 &&
        item.path.every((part): part is string => nonEmptyString(part)) &&
        typeof item.set === 'boolean'
      )
    })
  )
}

function validModelSelection(value: unknown): value is Record<string, unknown> & {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
} {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    nonEmptyString(record.provider) &&
    nonEmptyString(record.model) &&
    (record.reasoningEffort === undefined || nonEmptyString(record.reasoningEffort))
  )
}

function validModelProviderGroup(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    nonEmptyString(record.id) &&
    nonEmptyString(record.name) &&
    Array.isArray(record.models) &&
    record.models.every(validModelCatalogModel)
  )
}

function validModelCatalogModel(value: unknown): boolean {
  const record = recordOrUndefined(value)
  const reasoning = recordOrUndefined(record?.reasoning)
  return (
    record !== undefined &&
    nonEmptyString(record.id) &&
    nonEmptyString(record.name) &&
    (record.description === undefined || typeof record.description === 'string') &&
    (reasoning === undefined || validModelReasoning(reasoning))
  )
}

function validModelReasoning(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.efforts) &&
    value.efforts.length > 0 &&
    value.efforts.every((effort) => {
      const item = recordOrUndefined(effort)
      return (
        item !== undefined &&
        nonEmptyString(item.id) &&
        nonEmptyString(item.name) &&
        (item.description === undefined || typeof item.description === 'string')
      )
    }) &&
    (value.defaultEffort === undefined || nonEmptyString(value.defaultEffort))
  )
}

function validModelCatalogFailure(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    nonEmptyString(record.id) &&
    nonEmptyString(record.name) &&
    typeof record.message === 'string'
  )
}

function validDiscoveredModel(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    nonEmptyString(record.id) &&
    (record.name === undefined || nonEmptyString(record.name)) &&
    (record.contextWindow === undefined ||
      (Number.isSafeInteger(record.contextWindow) && (record.contextWindow as number) > 0)) &&
    (record.maxTokens === undefined ||
      (Number.isSafeInteger(record.maxTokens) && (record.maxTokens as number) > 0))
  )
}

function describeProviderFields(
  namespace: Record<string, unknown>,
  settingsPath: readonly string[],
): readonly ProviderFieldDraft[] {
  try {
    const root = schemasteryNodeAtPath(namespace.schema, settingsPath)
    if (root === undefined) return []
    const fields: ProviderFieldDraft[] = []
    const visit = (
      entries: readonly (readonly [string, SerializedSchemaNode])[],
      path: readonly string[],
    ): void => {
      for (const [key, child] of entries) {
        const next = [...path, key]
        const nested = schemasteryChildEntries(namespace.schema, child)
        if (nested.length > 0) {
          visit(nested, next)
          continue
        }
        const meta = asRecord(child.meta)
        const role = meta.role
        // Literal secret-role fields have no credential reference and must be
        // edited through settings, not mislabeled as credentials.set targets.
        if (role === 'secret') continue
        const value = readPath(namespace.value, [...settingsPath, ...next])
        const credentialRef =
          role === 'credential-ref' && typeof value === 'string' && value !== '' ? value : undefined
        const description = typeof meta.description === 'string' ? meta.description : undefined
        fields.push({
          field: {
            key: next.join('.'),
            label: description === undefined || description === '' ? key : description,
            secret: role === 'credential-ref',
            required: meta.required === true,
            ...(role !== 'credential-ref' && typeof value === 'string' ? { value } : {}),
          },
          ...(credentialRef === undefined ? {} : { credentialRef }),
        })
      }
    }
    visit(schemasteryChildEntries(namespace.schema, root), [])
    return fields
  } catch {
    throw malformedModels('provider settings schema')
  }
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    const record = asRecord(current)
    current = record[part]
  }
  return current
}

async function describeCredentialReferences(
  transport: DshTransport,
  refs: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, { readonly configured: boolean; readonly writable: boolean }>> {
  const states = new Map<string, { readonly configured: boolean; readonly writable: boolean }>()
  for (let offset = 0; offset < refs.length; offset += 64) {
    const batch = refs.slice(offset, offset + 64)
    const described = await callRpc<{ credentials: unknown }>(
      transport,
      'credentials.describe',
      { refs: batch },
      signal,
    )
    const credentials = asOptionalRecord(described.credentials)
    if (credentials === undefined) throw malformedModels('credential state')
    for (const ref of batch) {
      const view = asOptionalRecord(credentials[ref])
      if (
        view === undefined ||
        typeof view.configured !== 'boolean' ||
        typeof view.writable !== 'boolean' ||
        (view.source !== undefined && typeof view.source !== 'string')
      )
        throw malformedModels('credential state')
      states.set(ref, { configured: view.configured, writable: view.writable })
    }
  }
  return states
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
