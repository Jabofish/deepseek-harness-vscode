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

export class Rc6ModelRepository implements ModelRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async listProviders(signal?: AbortSignal): Promise<readonly ModelProvider[]> {
    const value = await callRpc<{ providers: unknown }>(this.transport, 'llm.providers', {}, signal)
    if (!Array.isArray(value.providers)) throw malformedModels('provider list')
    const providers = value.providers.map((provider) => rc6Mapper.provider(provider))
    const settings = await callRpc<{ namespaces: unknown }>(this.transport, 'settings.describe', {}, signal)
    if (!Array.isArray(settings.namespaces)) throw malformedModels('settings namespace list')
    const namespaces = settings.namespaces.map((entry) => {
      const namespace = asRecord(entry)
      if (typeof namespace.ns !== 'string') throw malformedModels('settings namespace')
      return namespace
    })
    return providers.map((provider) => {
      const namespace = namespaces.map(asRecord).find((entry) => entry.ns === provider.settingsNs)
      if (namespace === undefined) return provider
      const derived = describeProviderFields(namespace)
      if (derived.length === 0) return provider
      const fields = new Map(provider.fields.map((field) => [field.key, field]))
      for (const field of derived) fields.set(field.key, field)
      return { ...provider, fields: [...fields.values()] }
    })
  }

  public async listModels(providerId?: string, signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    const value = await callRpc<{ groups: unknown }>(this.transport, 'llm.models', {}, signal)
    if (!Array.isArray(value.groups)) throw malformedModels('model catalog')
    const models = value.groups.flatMap((group) => {
      const record = asRecord(group)
      const provider = typeof record.id === 'string' ? record.id : ''
      if (provider === '' || !Array.isArray(record.models)) throw malformedModels('model provider group')
      if (providerId !== undefined && provider !== providerId) return []
      return record.models.map((model) => rc6Mapper.model({ ...asRecord(model), providerId: provider }))
    })
    return models
  }

  public async listSessionModels(sessionId: string, signal?: AbortSignal): Promise<SessionModelCatalog> {
    const value = await callRpc<{
      current: unknown
      routable: unknown
      groups: unknown
      failures: unknown
    }>(this.transport, 'session.models', { sessionId }, signal)
    const current = asRecord(value.current)
    if (!Array.isArray(value.groups) || !Array.isArray(value.failures))
      throw malformedModels('session model catalog')
    const models = value.groups.flatMap((group) => {
      const record = asRecord(group)
      const providerId = typeof record.id === 'string' ? record.id : ''
      if (providerId === '' || !Array.isArray(record.models))
        throw malformedModels('session model provider group')
      return record.models.map((model) => rc6Mapper.model({ ...asRecord(model), providerId }))
    })
    const failures = value.failures.map((failure) => {
      const record = asRecord(failure)
      if (typeof record.id !== 'string' || typeof record.message !== 'string')
        throw malformedModels('session model failure')
      return { providerId: record.id, message: record.message.slice(0, 512) }
    })
    if (
      typeof current.provider !== 'string' ||
      typeof current.model !== 'string' ||
      typeof value.routable !== 'boolean'
    )
      throw malformedModels('session model catalog')
    return {
      current: {
        providerId: current.provider,
        modelId: current.model,
        ...(typeof current.reasoningEffort === 'string' ? { reasoningLevel: current.reasoningEffort } : {}),
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
    const value = await callRpc<{ models: unknown }>(
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
    )
    if (!Array.isArray(value.models)) throw malformedModels('discovered model list')
    return value.models.map((model) => {
      const record = asRecord(model)
      if (typeof record.id !== 'string') throw malformedModels('discovered model')
      return {
        id: record.id,
        label: typeof record.name === 'string' && record.name.length > 0 ? record.name : record.id,
        ...(typeof record.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {}),
        ...(typeof record.maxTokens === 'number' ? { maxTokens: record.maxTokens } : {}),
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

function describeProviderFields(namespace: Record<string, unknown>): ModelProvider['fields'] {
  const secretPaths = new Map<string, boolean>()
  if (Array.isArray(namespace.secrets))
    for (const entry of namespace.secrets) {
      const record = asRecord(entry)
      const path = pathOf(record.path)
      if (path.length > 0) secretPaths.set(path.join('.'), record.set === true)
    }
  const fields: ModelProvider['fields'][number][] = []
  const visit = (value: unknown, path: readonly string[]): void => {
    const record = asRecord(value)
    const properties = asRecord(record.properties ?? record.fields ?? record.shape)
    for (const [key, child] of Object.entries(properties)) {
      const next = [...path, key]
      const childRecord = asRecord(child)
      const nested = asRecord(childRecord.properties ?? childRecord.fields ?? childRecord.shape)
      if (Object.keys(nested).length > 0) visit(child, next)
      else {
        const fieldPath = next.join('.')
        const secret = secretPaths.has(fieldPath) || childRecord.type === 'secret'
        const valueAtPath = secret ? undefined : readPath(namespace.value, next)
        fields.push({
          key: fieldPath,
          label: key,
          secret,
          required: childRecord.required === true,
          ...(secret
            ? secretPaths.get(fieldPath) === true
              ? { value: '[configured]' }
              : {}
            : typeof valueAtPath === 'string'
              ? { value: valueAtPath }
              : {}),
        })
      }
    }
  }
  visit(namespace.schema, [])
  for (const [path, configured] of secretPaths) {
    if (fields.some((field) => field.key === path)) continue
    fields.push({
      key: path,
      label: path.split('.').at(-1) ?? 'Secret',
      secret: true,
      required: false,
      ...(configured ? { value: '[configured]' } : {}),
    })
  }
  return fields
}

function pathOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === 'string' && part.length > 0)
    : []
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    const record = asRecord(current)
    current = record[part]
  }
  return current
}
