import {
  AppError,
  deriveProviderCredentialReference,
  type CredentialReferenceState,
  type CredentialRepository,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc } from '../versions/rc6/rpc.js'
import { schemasteryNodeAtPath } from '../versions/rc6/schemastery.js'
import { callCredentialRpc } from './shared/credential-rpc.js'
import { recordOrUndefined, validProviderView, validSettingsNamespace } from './shared/guards.js'

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
    const resolved = await this.resolveReference(providerId, field, true, signal)
    if (resolved.bind !== undefined) {
      const receipt = await callRpc<unknown>(
        this.transport,
        'settings.mutate',
        {
          ns: resolved.bind.namespace,
          ops: [{ op: 'set', path: resolved.bind.path, value: resolved.ref }],
          expectedRevision: resolved.bind.revision,
        },
        signal,
      )
      if (!validSettingsNamespace(receipt)) throw malformedCredentialSchema()
    }
    assertEmptyReceipt(
      await callCredentialRpc<unknown>(
        this.transport,
        'credentials.set',
        { ref: resolved.ref, value },
        signal,
      ),
      'credentials.set',
    )
  }

  public async removeSecret(providerId: string, field: string, signal?: AbortSignal): Promise<void> {
    const { ref } = await this.resolveReference(providerId, field, false, signal)
    assertEmptyReceipt(
      await callCredentialRpc<unknown>(this.transport, 'credentials.unset', { ref }, signal),
      'credentials.unset',
    )
  }

  public async describeReference(ref: string, signal?: AbortSignal): Promise<CredentialReferenceState> {
    assertReference(ref)
    const described = await callCredentialRpc<{ credentials: unknown }>(
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
    // Both the pinned RC2 Remote and the older Host contract describe every
    // requested valid ref. A missing entry is a malformed response, not a
    // signal that a writable credential is missing.
    if (!Object.prototype.hasOwnProperty.call(credentials, ref)) throw malformedCredentialDescribe()
    const rawView = (credentials as Record<string, unknown>)[ref]
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
      await callCredentialRpc<unknown>(this.transport, 'credentials.set', { ref, value }, signal),
      'credentials.set',
    )
  }

  public async unsetReference(ref: string, signal?: AbortSignal): Promise<void> {
    assertReference(ref)
    assertEmptyReceipt(
      await callCredentialRpc<unknown>(this.transport, 'credentials.unset', { ref }, signal),
      'credentials.unset',
    )
  }

  private async resolveReference(
    providerId: string,
    field: string,
    bindMissing: boolean,
    signal?: AbortSignal,
  ): Promise<ResolvedCredentialReference> {
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
    const rawSettingsPath = provider?.settingsPath
    const settingsPath =
      Array.isArray(rawSettingsPath) &&
      rawSettingsPath.every((part): part is string => typeof part === 'string' && part.length > 0)
        ? rawSettingsPath
        : undefined
    if (namespace === undefined || namespace.trim() === '' || settingsPath === undefined)
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
    let credentialRole = false
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
      credentialRole = true
    }
    const reference = readPath(settings?.value, credentialPath)
    if (typeof reference !== 'string' || reference === '') {
      // A new pi-ai route may intentionally omit apiKeyEnv so provider-native
      // authentication remains available. When the user later presses the
      // existing Host-only Configure action, bind the conventional reference
      // atomically before storing the secret. This is the missing bridge
      // between upstream's blank-key create path and the local credential UI.
      if (
        !bindMissing ||
        namespace !== 'llm-pi-ai' ||
        field !== 'apiKeyEnv' ||
        !credentialRole ||
        settings === undefined ||
        typeof settings.revision !== 'number' ||
        !Number.isSafeInteger(settings.revision) ||
        settings.revision < 0
      )
        throw unavailableCredentialReference()
      const derived = deriveProviderCredentialReference(providerId)
      assertReference(derived)
      // The reference may not be present in credentials.describe yet. That
      // absence is exactly the expected first-write state for a keyless custom
      // route, and the credentials.set RPC remains the authority on whether a
      // new reference may be stored. Do not treat an absent description as a
      // read-only environment shadow.
      return {
        ref: derived,
        bind: {
          namespace,
          path: credentialPath,
          revision: settings.revision,
        },
      }
    }
    assertReference(reference)

    const view = await this.describeReference(reference, signal)
    const conventionalCustomReference =
      namespace === 'llm-pi-ai' &&
      field === 'apiKeyEnv' &&
      credentialRole &&
      reference === deriveProviderCredentialReference(providerId) &&
      !view.configured
    if (!view.writable && !conventionalCustomReference)
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The DSH credential reference is not writable.',
        retryable: false,
      })
    return { ref: reference }
  }
}

interface ResolvedCredentialReference {
  readonly ref: string
  readonly bind?: {
    readonly namespace: string
    readonly path: readonly string[]
    readonly revision: number
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
