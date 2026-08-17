import { AppError, type CredentialReferenceState, type CredentialRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'
import { schemasteryNodeAtPath } from '../versions/rc6/schemastery.js'

/** Reference names the pinned credentials domain accepts (`credentials.*`). */
const REFERENCE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export class Rc6CredentialRepository implements CredentialRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async setSecret(
    providerId: string,
    field: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (value.length === 0) throw new Error('Credential value cannot be empty')
    const ref = await this.resolveReference(providerId, field, signal)
    assertEmptyReceipt(
      await callRpc<unknown>(this.transport, 'credentials.set', { ref, value }, signal),
      'credentials.set',
    )
  }

  public async removeSecret(providerId: string, field: string, signal?: AbortSignal): Promise<void> {
    const ref = await this.resolveReference(providerId, field, signal)
    assertEmptyReceipt(
      await callRpc<unknown>(this.transport, 'credentials.unset', { ref }, signal),
      'credentials.unset',
    )
  }

  public async describeReference(ref: string, signal?: AbortSignal): Promise<CredentialReferenceState> {
    assertReference(ref)
    const described = await callRpc<{ credentials: unknown }>(
      this.transport,
      'credentials.describe',
      { refs: [ref] },
      signal,
    )
    if (typeof described !== 'object' || described === null || Array.isArray(described))
      throw malformedCredentialDescribe()
    const credentials = (described as { credentials?: unknown }).credentials
    if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials))
      throw malformedCredentialDescribe()
    // An unlisted ref is simply unconfigured — absence is a fact, not an error.
    const rawView = (credentials as Record<string, unknown>)[ref]
    if (rawView === undefined) return { ref, configured: false, writable: false }
    const view = asRecord(rawView)
    if (
      typeof view.configured !== 'boolean' ||
      typeof view.writable !== 'boolean' ||
      (view.source !== undefined && typeof view.source !== 'string')
    )
      throw malformedCredentialDescribe()
    return { ref, configured: view.configured, writable: view.writable }
  }

  public async setReference(ref: string, value: string, signal?: AbortSignal): Promise<void> {
    if (value.length === 0) throw new Error('Credential value cannot be empty')
    assertReference(ref)
    assertEmptyReceipt(
      await callRpc<unknown>(this.transport, 'credentials.set', { ref, value }, signal),
      'credentials.set',
    )
  }

  public async unsetReference(ref: string, signal?: AbortSignal): Promise<void> {
    assertReference(ref)
    assertEmptyReceipt(
      await callRpc<unknown>(this.transport, 'credentials.unset', { ref }, signal),
      'credentials.unset',
    )
  }

  private async resolveReference(providerId: string, field: string, signal?: AbortSignal): Promise<string> {
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(providerId) || !/^[A-Za-z0-9_.-]{1,256}$/.test(field))
      throw invalidCredentialField()

    const providers = recordOrUndefined(await callRpc<unknown>(this.transport, 'llm.providers', {}, signal))
    if (
      providers === undefined ||
      !Array.isArray(providers.providers) ||
      !providers.providers.every(validProviderView)
    )
      throw malformedCredentialDescribe()
    const provider = providers.providers
      .map((entry) => recordOrUndefined(entry) as Record<string, unknown>)
      .find((entry) => entry.provider === providerId)
    const namespace = typeof provider?.settingsNs === 'string' ? provider.settingsNs : undefined
    const settingsPath = Array.isArray(provider?.settingsPath)
      ? provider.settingsPath.filter((part): part is string => typeof part === 'string' && part !== '')
      : undefined
    if (
      namespace === undefined ||
      namespace.trim() === '' ||
      settingsPath === undefined ||
      settingsPath.length !== (provider?.settingsPath as readonly unknown[]).length
    )
      throw unavailableCredentialReference()

    const described = recordOrUndefined(
      await callRpc<unknown>(this.transport, 'settings.describe', {}, signal),
    )
    if (
      described === undefined ||
      typeof described.writable !== 'boolean' ||
      typeof described.hasDocument !== 'boolean' ||
      !Array.isArray(described.namespaces) ||
      !described.namespaces.every(validSettingsNamespace)
    )
      throw malformedCredentialSchema()
    const settings = described.namespaces
      .map((entry) => recordOrUndefined(entry) as Record<string, unknown>)
      .find((entry) => entry.ns === namespace)
    const credentialPath = [...settingsPath, ...field.split('.')]
    if (settings !== undefined && 'schema' in settings) {
      const schema = settings.schema
      let schemaNode
      try {
        schemaNode = schemasteryNodeAtPath(schema, credentialPath)
      } catch {
        throw malformedCredentialSchema()
      }
      const role = schemaNode?.meta
      const roleName =
        typeof role === 'object' && role !== null && !Array.isArray(role) && 'role' in role
          ? (role as { readonly role?: unknown }).role
          : undefined
      if (roleName !== 'credential-ref') throw unavailableCredentialReference()
    }
    const reference = readPath(settings?.value, credentialPath)
    if (typeof reference !== 'string' || reference === '') throw unavailableCredentialReference()
    assertReference(reference)

    const view = await this.describeReference(reference, signal)
    if (!view.writable)
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The DSH credential reference is not writable.',
        retryable: false,
      })
    return reference
  }
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) current = asRecord(current)[part]
  return current
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

function validProviderView(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    typeof record.provider === 'string' &&
    record.provider.trim() !== '' &&
    typeof record.displayName === 'string' &&
    record.displayName.trim() !== '' &&
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
    typeof record.ns === 'string' &&
    record.ns.trim() !== '' &&
    Object.prototype.hasOwnProperty.call(record, 'schema') &&
    Object.prototype.hasOwnProperty.call(record, 'value') &&
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
        item.path.every((part): part is string => typeof part === 'string' && part.trim() !== '') &&
        typeof item.set === 'boolean'
      )
    })
  )
}

function invalidCredentialField(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The selected credential field is invalid.',
    retryable: false,
  })
}

/** Reject reference names outside the pinned credentials domain's grammar. */
function assertReference(ref: string): void {
  if (!REFERENCE_PATTERN.test(ref))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The credential reference is invalid.',
      retryable: false,
    })
}

function malformedCredentialDescribe(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed credential description.',
    retryable: false,
  })
}

function malformedCredentialSchema(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed provider settings schema.',
    retryable: false,
  })
}

function assertEmptyReceipt(value: unknown, method: string): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
    return
  throw new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed ${method} receipt.`,
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
