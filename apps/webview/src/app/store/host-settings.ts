import type {
  DshRuntimeUpdateProgress,
  DshSettingsSchema,
  DshUpdateSnapshot,
  ExtensionSettingsSummary,
} from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import {
  listValues,
  sameModelDescriptorList,
  sameModelProviderList,
  strictListValues,
} from './list-equality.js'
import {
  isAgentConfiguration,
  isModelDescriptor,
  isModelProvider,
  isPermissionPreset,
} from './model-catalog.js'
import type { DshSettingsSnapshot, StateSetter } from './types.js'
import { object } from './unknown-record.js'

export async function refreshProvidersAndModels(
  client: ProtocolClient,
  setState: StateSetter,
): Promise<void> {
  const [providersResult, modelsResult] = await Promise.allSettled([
    client.request<unknown>({ type: 'providers.list', requestId: requestId() }),
    client.request<unknown>({ type: 'models.list', requestId: requestId(), payload: {} }),
  ])
  const providers =
    providersResult.status === 'fulfilled'
      ? listValues(providersResult.value).filter(isModelProvider)
      : undefined
  const models =
    modelsResult.status === 'fulfilled' ? strictListValues(modelsResult.value, isModelDescriptor) : undefined
  setState((current) => {
    const nextProviders =
      providers === undefined || sameModelProviderList(current.providers, providers)
        ? current.providers
        : providers
    const nextModels =
      models === undefined || sameModelDescriptorList(current.models, models) ? current.models : models
    if (nextProviders === current.providers && nextModels === current.models) return current
    return { ...current, providers: nextProviders, models: nextModels }
  })
}

export function parseExtensionSettings(value: unknown): ExtensionSettingsSummary | undefined {
  const settings = object(value)
  const extensionVersion = settings?.extensionVersion
  const connection = object(settings?.connection)
  const runtime = object(settings?.runtime)
  const security = object(settings?.security)
  const defaultAgent = object(settings?.defaultAgent)
  if (
    typeof extensionVersion !== 'string' ||
    extensionVersion.length === 0 ||
    extensionVersion.length > 128 ||
    connection === undefined ||
    runtime === undefined ||
    security === undefined ||
    (connection.mode !== 'auto' &&
      connection.mode !== 'custom' &&
      connection.mode !== 'attach-only' &&
      connection.mode !== 'new-isolated') ||
    typeof connection.customEndpointConfigured !== 'boolean' ||
    typeof runtime.customExecutableConfigured !== 'boolean' ||
    typeof runtime.autoStart !== 'boolean' ||
    !isPermissionPreset(security.defaultPermissionPreset) ||
    !isAgentConfiguration(defaultAgent)
  )
    return undefined
  return {
    extensionVersion,
    connection: {
      mode: connection.mode,
      customEndpointConfigured: connection.customEndpointConfigured,
    },
    runtime: {
      customExecutableConfigured: runtime.customExecutableConfigured,
      autoStart: runtime.autoStart,
    },
    security: {
      defaultPermissionPreset: security.defaultPermissionPreset,
    },
    defaultAgent: {
      preset: defaultAgent.preset,
      toolMode: defaultAgent.toolMode,
      permissionPreset: defaultAgent.permissionPreset,
      planMode: defaultAgent.planMode,
      ...(defaultAgent.sandboxMode === undefined ? {} : { sandboxMode: defaultAgent.sandboxMode }),
      ...(defaultAgent.approvalPolicy === undefined ? {} : { approvalPolicy: defaultAgent.approvalPolicy }),
      model: {
        providerId: defaultAgent.model.providerId,
        modelId: defaultAgent.model.modelId,
        ...(defaultAgent.model.reasoningLevel === undefined
          ? {}
          : { reasoningLevel: defaultAgent.model.reasoningLevel }),
      },
    },
  }
}

export function parseDshUpdateSnapshot(value: unknown): DshUpdateSnapshot | undefined {
  const snapshot = object(value)
  if (
    snapshot === undefined ||
    (snapshot.status !== 'ready' && snapshot.status !== 'unavailable') ||
    !Array.isArray(snapshot.availableVersions) ||
    !snapshot.availableVersions.every(
      (entry): entry is string => typeof entry === 'string' && entry.length <= 128,
    ) ||
    typeof snapshot.updateAvailable !== 'boolean' ||
    typeof snapshot.checkedAt !== 'string'
  )
    return undefined
  const optionalString = (key: string): string | undefined => {
    const entry = snapshot[key]
    return entry === undefined ? undefined : typeof entry === 'string' ? entry : undefined
  }
  const currentSource = optionalString('currentSource')
  const currentVersion = optionalString('currentVersion')
  const globalVersion = optionalString('globalVersion')
  const latestVersion = optionalString('latestVersion')
  const latestTagVersion = optionalString('latestTagVersion')
  const nextTagVersion = optionalString('nextTagVersion')
  const failure = optionalString('failure')
  if (
    currentSource !== undefined &&
    currentSource !== 'configured' &&
    currentSource !== 'path' &&
    currentSource !== 'npm-global' &&
    currentSource !== 'bundled'
  )
    return undefined
  if (
    failure !== undefined &&
    failure !== 'npm-not-found' &&
    failure !== 'registry-unavailable' &&
    failure !== 'invalid-response'
  )
    return undefined
  const restartRequired = snapshot.restartRequired
  if (restartRequired !== undefined && typeof restartRequired !== 'boolean') return undefined
  return {
    status: snapshot.status,
    ...(currentVersion === undefined ? {} : { currentVersion }),
    ...(currentSource === undefined ? {} : { currentSource }),
    ...(globalVersion === undefined ? {} : { globalVersion }),
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(latestTagVersion === undefined ? {} : { latestTagVersion }),
    ...(nextTagVersion === undefined ? {} : { nextTagVersion }),
    availableVersions: snapshot.availableVersions,
    updateAvailable: snapshot.updateAvailable,
    checkedAt: snapshot.checkedAt,
    ...(failure === undefined ? {} : { failure }),
    ...(restartRequired === true ? { restartRequired: true } : {}),
  }
}

export function parseDshUpdateProgress(value: unknown): DshRuntimeUpdateProgress | undefined {
  const progress = object(value)
  if (progress === undefined) return undefined
  const phase = progress.phase
  if (
    phase !== 'checking' &&
    phase !== 'downloading' &&
    phase !== 'installing' &&
    phase !== 'verifying' &&
    phase !== 'completed' &&
    phase !== 'failed'
  )
    return undefined
  const version = progress.version
  if (version !== undefined && (typeof version !== 'string' || version.length === 0 || version.length > 128))
    return undefined
  return {
    phase,
    ...(version === undefined ? {} : { version }),
  }
}

export function parseDshSettingsSnapshot(value: unknown): DshSettingsSnapshot | undefined {
  const settings = object(value)
  const schema = object(settings?.schema)
  if (
    schema === undefined ||
    typeof schema.version !== 'string' ||
    typeof schema.writable !== 'boolean' ||
    typeof schema.hasDocument !== 'boolean' ||
    !Array.isArray(schema.fields) ||
    !schema.fields.every(isSettingsField) ||
    !Array.isArray(schema.namespaces) ||
    !schema.namespaces.every(isSettingsNamespace)
  )
    return undefined
  const values = object(settings?.values)
  if (values === undefined) return undefined
  return {
    schema: {
      version: schema.version,
      writable: schema.writable,
      hasDocument: schema.hasDocument,
      fields: schema.fields,
      namespaces: schema.namespaces,
    },
    values,
  }
}

export function isSettingsNamespace(value: unknown): value is DshSettingsSchema['namespaces'][number] {
  const namespace = object(value)
  return (
    namespace !== undefined &&
    typeof namespace.ns === 'string' &&
    (namespace.applies === 'live' || namespace.applies === 'restart') &&
    Number.isSafeInteger(namespace.revision) &&
    (namespace.revision as number) >= 0 &&
    Array.isArray(namespace.userFields) &&
    namespace.userFields.every((field) => typeof field === 'string') &&
    Array.isArray(namespace.secrets) &&
    namespace.secrets.every(
      (secret) =>
        object(secret) !== undefined &&
        typeof object(secret)?.field === 'string' &&
        typeof object(secret)?.set === 'boolean',
    )
  )
}

export function isSettingsField(value: unknown): value is DshSettingsSchema['fields'][number] {
  const field = object(value)
  return (
    field !== undefined &&
    typeof field.path === 'string' &&
    typeof field.label === 'string' &&
    typeof field.required === 'boolean' &&
    typeof field.restartRequired === 'boolean' &&
    (field.enumValues === undefined ||
      (Array.isArray(field.enumValues) && field.enumValues.every((entry) => typeof entry === 'string'))) &&
    (field.type === 'string' ||
      field.type === 'number' ||
      field.type === 'boolean' ||
      field.type === 'enum' ||
      field.type === 'secret' ||
      field.type === 'object' ||
      field.type === 'array')
  )
}
