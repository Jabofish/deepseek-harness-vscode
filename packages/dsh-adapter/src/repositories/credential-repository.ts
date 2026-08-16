import { AppError, type CredentialRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'

export class Rc6CredentialRepository implements CredentialRepository {
  private readonly references = new Map<string, string>()

  public constructor(private readonly transport: DshTransport) {}

  public async setSecret(
    providerId: string,
    field: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (value.length === 0) throw new Error('Credential value cannot be empty')
    const ref = await this.resolveReference(providerId, field, signal)
    await callRpc(this.transport, 'credentials.set', { ref, value }, signal)
  }

  public async removeSecret(providerId: string, field: string, signal?: AbortSignal): Promise<void> {
    const ref = await this.resolveReference(providerId, field, signal)
    await callRpc(this.transport, 'credentials.unset', { ref }, signal)
  }

  private async resolveReference(providerId: string, field: string, signal?: AbortSignal): Promise<string> {
    const cacheKey = `${providerId}\u0000${field}`
    const cached = this.references.get(cacheKey)
    if (cached !== undefined) return cached
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(providerId) || !/^[A-Za-z0-9_.-]{1,256}$/.test(field))
      throw invalidCredentialField()

    const providers = await callRpc<{ providers: unknown }>(this.transport, 'llm.providers', {}, signal)
    const provider = Array.isArray(providers.providers)
      ? providers.providers
          .map(asRecord)
          .find((entry) => entry.provider === providerId || entry.id === providerId)
      : undefined
    const namespace = typeof provider?.settingsNs === 'string' ? provider.settingsNs : undefined
    if (namespace === undefined) throw unavailableCredentialReference()

    const described = await callRpc<{ namespaces: unknown }>(this.transport, 'settings.describe', {}, signal)
    const settings = Array.isArray(described.namespaces)
      ? described.namespaces.map(asRecord).find((entry) => entry.ns === namespace)
      : undefined
    const reference =
      settings === undefined ? undefined : findCredentialReference(settings.schema, field.split('.'))
    if (reference === undefined) throw unavailableCredentialReference()

    const describedCredential = await callRpc<{ credentials: unknown }>(
      this.transport,
      'credentials.describe',
      { refs: [reference] },
      signal,
    )
    const view = asRecord(asRecord(describedCredential.credentials)[reference])
    if (view.writable !== true)
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The DSH credential reference is not writable.',
        retryable: false,
      })
    this.references.set(cacheKey, reference)
    return reference
  }
}

function findCredentialReference(schema: unknown, path: readonly string[]): string | undefined {
  const node = schemaAtPath(schema, path)
  const record = asRecord(node)
  for (const key of ['apiKeyEnv', 'credentialRef', 'secretRef', 'credential']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function schemaAtPath(value: unknown, path: readonly string[]): unknown {
  if (path.length === 0) return value
  const record = asRecord(value)
  const properties = asRecord(record.properties ?? record.fields ?? record.shape)
  const next = properties[path[0] ?? '']
  return next === undefined ? undefined : schemaAtPath(next, path.slice(1))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function invalidCredentialField(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The selected credential field is invalid.',
    retryable: false,
  })
}

function unavailableCredentialReference(): AppError {
  return new AppError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'The DSH did not expose an authoritative credential reference for this field.',
    retryable: false,
  })
}
