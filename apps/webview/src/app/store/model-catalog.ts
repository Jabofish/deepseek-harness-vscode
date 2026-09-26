import {
  type AgentConfiguration,
  type CustomProviderCreateResult,
  type DiscoveredModel,
  type ModelCatalogFailure,
  type ModelDescriptor,
  type ModelProvider,
  type ModelSelection,
} from '@dsh-vscode/domain'
import { type AppState } from './types.js'
import { isToolMode } from './event-values.js'
import { type ComposerPreferences } from './initial-state.js'
import { object } from './unknown-record.js'

export function isModelProvider(value: unknown): value is ModelProvider {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.configurable === 'boolean' &&
    (item.active === undefined || typeof item.active === 'boolean') &&
    (item.declared === undefined || typeof item.declared === 'boolean') &&
    (item.settingsNs === undefined || typeof item.settingsNs === 'string') &&
    (item.settingsPath === undefined ||
      (Array.isArray(item.settingsPath) && item.settingsPath.every((part) => typeof part === 'string'))) &&
    Array.isArray(item.fields) &&
    item.fields.every(isProviderField)
  )
}

export function isProviderField(value: unknown): boolean {
  const field = object(value)
  return (
    field !== undefined &&
    typeof field.key === 'string' &&
    typeof field.label === 'string' &&
    typeof field.secret === 'boolean' &&
    typeof field.required === 'boolean' &&
    (field.enumValues === undefined ||
      (Array.isArray(field.enumValues) && field.enumValues.every((entry) => typeof entry === 'string'))) &&
    (field.writable === undefined || typeof field.writable === 'boolean') &&
    (field.value === undefined || typeof field.value === 'string')
  )
}

export function isModelDescriptor(value: unknown): value is ModelDescriptor {
  const item = object(value)
  if (
    item === undefined ||
    typeof item.id !== 'string' ||
    typeof item.providerId !== 'string' ||
    typeof item.label !== 'string' ||
    !validModelInputModalities(item.inputModalities) ||
    typeof item.supportsReasoning !== 'boolean' ||
    (item.defaultReasoningLevel !== undefined && !nonBlankString(item.defaultReasoningLevel))
  )
    return false
  if (item.reasoningLevels === undefined) return true
  // A level the picker cannot name is one it must not offer: the label is what
  // the user reads and the id is what travels back, and neither may be blank.
  return (
    Array.isArray(item.reasoningLevels) &&
    item.reasoningLevels.every((level) => {
      const entry = object(level)
      return entry !== undefined && nonBlankString(entry.id) && nonBlankString(entry.label)
    })
  )
}

export function validModelInputModalities(value: unknown): boolean {
  // The pinned RC2 catalog contract is an optional array of advertised values;
  // unlike the user settings override, an empty catalog declaration is valid.
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => entry === 'text' || entry === 'image'))
  )
}

export function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function isModelCatalogFailure(value: unknown): value is ModelCatalogFailure {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.providerId === 'string' &&
    item.providerId.trim() !== '' &&
    typeof item.providerName === 'string' &&
    item.providerName.trim() !== '' &&
    typeof item.message === 'string'
  )
}

/**
 * A route the host named. It is not the same statement as the session's
 * configuration, where empty ids mean "no choice recorded": every id here is
 * required, because a directory that names half a route has not named one.
 */
export function isModelSelection(value: unknown): value is ModelSelection {
  const item = object(value)
  return (
    item !== undefined &&
    nonBlankString(item.providerId) &&
    nonBlankString(item.modelId) &&
    (item.reasoningLevel === undefined || nonBlankString(item.reasoningLevel))
  )
}

export function sameModelSelection(left: ModelSelection | undefined, right: ModelSelection): boolean {
  return (
    left !== undefined &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.reasoningLevel === right.reasoningLevel
  )
}

export function isDiscoveredModel(value: unknown): value is DiscoveredModel {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    item.id.length <= 256 &&
    typeof item.label === 'string' &&
    item.label.trim() !== '' &&
    item.label.length <= 512 &&
    (item.contextWindow === undefined ||
      (typeof item.contextWindow === 'number' &&
        Number.isSafeInteger(item.contextWindow) &&
        item.contextWindow > 0)) &&
    (item.maxTokens === undefined ||
      (typeof item.maxTokens === 'number' && Number.isSafeInteger(item.maxTokens) && item.maxTokens > 0))
  )
}

export function parseDiscoveredModels(value: unknown): readonly DiscoveredModel[] | undefined {
  const root = object(value)
  const rows = Array.isArray(value) ? value : root?.models
  if (!Array.isArray(rows)) return undefined
  return rows.length > 512 || !rows.every(isDiscoveredModel) ? undefined : rows
}

export function parseCustomProviderCreateResult(value: unknown): CustomProviderCreateResult | undefined {
  const result = object(value)
  if (
    result === undefined ||
    typeof result.profileCommitted !== 'boolean' ||
    typeof result.credentialConfigured !== 'boolean' ||
    (result.credentialError !== undefined && typeof result.credentialError !== 'string')
  )
    return undefined
  return {
    profileCommitted: result.profileCommitted,
    credentialConfigured: result.credentialConfigured,
    ...(typeof result.credentialError === 'string' && result.credentialError !== ''
      ? { credentialError: result.credentialError.slice(0, 512) }
      : {}),
  }
}

export function isPermissionPreset(value: unknown): value is AgentConfiguration['permissionPreset'] {
  return typeof value === 'string' && value.trim() !== ''
}

export function isAgentConfiguration(value: unknown): value is AgentConfiguration {
  const item = object(value)
  const model = object(item?.model)
  return (
    item !== undefined &&
    typeof item.preset === 'string' &&
    isToolMode(item.toolMode) &&
    isPermissionPreset(item.permissionPreset) &&
    typeof item.planMode === 'boolean' &&
    (item.sandboxMode === undefined || typeof item.sandboxMode === 'string') &&
    (item.approvalPolicy === undefined || typeof item.approvalPolicy === 'string') &&
    model !== undefined &&
    typeof model.providerId === 'string' &&
    typeof model.modelId === 'string' &&
    (model.reasoningLevel === undefined || typeof model.reasoningLevel === 'string')
  )
}

export function createDefaultConfiguration(
  state: Pick<AppState, 'presets' | 'models'>,
  preferences: ComposerPreferences,
): AgentConfiguration {
  const preset = state.presets.find((entry) => entry.isDefault)?.id ?? state.presets[0]?.id ?? 'standard'
  const model =
    preferences.model !== undefined &&
    (state.models.length === 0 ||
      state.models.some(
        (entry) =>
          entry.providerId === preferences.model?.providerId && entry.id === preferences.model?.modelId,
      ))
      ? preferences.model
      : { providerId: '', modelId: '' }
  return {
    preset,
    toolMode: 'native',
    permissionPreset: 'workspace-write',
    planMode: false,
    model,
  }
}
export function normalizedModelSelection(value: unknown): ModelSelection | undefined {
  const model = object(value)
  if (
    model === undefined ||
    typeof model.providerId !== 'string' ||
    typeof model.modelId !== 'string' ||
    model.providerId.trim() === '' ||
    model.modelId.trim() === ''
  )
    return undefined
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(typeof model.reasoningLevel === 'string' && model.reasoningLevel.trim() !== ''
      ? { reasoningLevel: model.reasoningLevel }
      : {}),
  }
}
