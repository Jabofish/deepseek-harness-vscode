import type { ModelProvider, SettingsPathOperation } from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import {
  DSH_UI_SETTING_PATHS,
  findDshSettingsField,
  isConversationFontSizePx,
  isPerformanceUsageMode,
  isTranscriptViewMode,
} from '../../app/ui-preferences.js'
import type { CustomProviderTemplate } from './CustomProviderCard.js'
import type { ProviderSettingChange } from './ProviderSettingsEditor.js'
import { settingValueAt } from './settings-values.js'

export function deriveCustomProviderTemplate(
  providers: readonly ModelProvider[],
  settings: DshSettingsSnapshot,
): CustomProviderTemplate | undefined {
  const candidate = providers.find((provider) => {
    if (
      provider.settingsNs === undefined ||
      provider.settingsNs.trim() === '' ||
      provider.settingsPath === undefined ||
      provider.settingsPath.length < 2
    )
      return false
    const namespace = settings.schema.namespaces.find((entry) => entry.ns === provider.settingsNs)
    const protocols = provider.fields.find((field) => field.key === 'api')?.enumValues
    return namespace !== undefined && protocols !== undefined && protocols.length > 0
  })
  if (candidate?.settingsNs === undefined || candidate.settingsPath === undefined) return undefined
  const namespace = settings.schema.namespaces.find((entry) => entry.ns === candidate.settingsNs)
  const protocols = uniqueStrings(candidate.fields.find((field) => field.key === 'api')?.enumValues)
  if (namespace === undefined || protocols.length === 0) return undefined
  const profilePath = [candidate.settingsNs, ...candidate.settingsPath].join('.')
  const profile = settingValueAt(settings.values, profilePath)
  const configuredApi =
    typeof profile === 'object' && profile !== null && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).api
      : undefined
  return {
    settingsNamespace: candidate.settingsNs,
    collectionPath: candidate.settingsPath.slice(0, -1),
    protocols,
    revision: namespace.revision,
    ...(typeof configuredApi === 'string' && protocols.includes(configuredApi) ? { api: configuredApi } : {}),
  }
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return []
  return [...new Set(values.filter((value) => value.trim() !== ''))]
}

/** Hide dormant directory entries; the upstream page lists configured rows only. */
export function isConfiguredProvider(provider: ModelProvider, settings: DshSettingsSnapshot): boolean {
  const namespace = provider.settingsNs?.trim()
  if (namespace === undefined || namespace === '') {
    // Older DSH versions did not expose a settings address. Keep their rows
    // visible so the compatibility fallback still exposes credential actions.
    return true
  }
  // Match the official ModelsSection store: a provider is listed only when
  // its namespace exists and its configured profile exists. `active` is a
  // runtime routing fact, not evidence that a dormant catalog entry has a
  // user profile.
  const namespaceValue = settingValueAt(settings.values, namespace)
  if (namespaceValue === undefined) return false
  const settingsPath = provider.settingsPath ?? []
  if (settingsPath.length === 0) return true
  if (typeof namespaceValue !== 'object' || namespaceValue === null || Array.isArray(namespaceValue))
    return false
  return (
    settingValueAt(namespaceValue as Readonly<Record<string, unknown>>, settingsPath.join('.')) !== undefined
  )
}

export function providerRowOrder(provider: ModelProvider): number {
  if (provider.id === 'deepseek-account') return 0
  if (provider.id === 'deepseek-official' || provider.settingsNs === 'llm-deepseek') return 1
  return 2
}

export function isAddableProvider(provider: ModelProvider, settings: DshSettingsSnapshot): boolean {
  if (provider.configurable === false || isConfiguredProvider(provider, settings)) return false
  const namespace = provider.settingsNs?.trim()
  const settingsPath = provider.settingsPath
  // A whole-section provider (for example the shipped DeepSeek namespace) is
  // also an upstream-supported setup target. Its editor writes individual
  // fields below the namespace; nested provider profiles can additionally be
  // materialized as an empty object on Apply.
  return (
    namespace !== undefined &&
    namespace !== '' &&
    settingsPath !== undefined &&
    settingsPath.every((part) => part.trim() !== '')
  )
}

export function namespaceInPath(path: string): string {
  return path.split('.', 1)[0] ?? ''
}

export function settingsNamespaceRevision(
  snapshot: DshSettingsSnapshot,
  namespace: string,
): number | undefined {
  return snapshot.schema.namespaces.find((entry) => entry.ns === namespace)?.revision
}

export function providerSettingOperations(
  provider: ModelProvider,
  changes: readonly ProviderSettingChange[],
): readonly SettingsPathOperation[] | undefined {
  const namespace = provider.settingsNs?.trim()
  if (namespace === undefined || namespace === '') return undefined
  const prefix = [namespace, ...(provider.settingsPath ?? [])]
  const operations: SettingsPathOperation[] = []
  for (const change of changes) {
    const path = change.path.split('.')
    if (
      path.length <= prefix.length ||
      !prefix.every((segment, index) => path[index] === segment) ||
      path.some((segment) => segment.trim() === '')
    )
      return undefined
    const relativePath = path.slice(prefix.length)
    operations.push(
      change.kind === 'set'
        ? { op: 'set', path: relativePath, value: change.value }
        : { op: 'unset', path: relativePath },
    )
  }
  return operations
}

export function isSettingsConflict(reason: unknown): boolean {
  return (
    typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === 'SETTINGS_CONFLICT'
  )
}

export function isKnownRejectedSettingsWrite(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'code' in reason &&
    (reason.code === 'INVALID_CONFIGURATION' ||
      reason.code === 'PERMISSION_DENIED' ||
      reason.code === 'CAPABILITY_UNAVAILABLE')
  )
}

export function isValidGeneralSettingChange(
  snapshot: DshSettingsSnapshot,
  path: string,
  value: unknown,
): boolean {
  const field = findDshSettingsField(snapshot, path)
  if (field === undefined || !snapshot.schema.writable) return false
  if (path === DSH_UI_SETTING_PATHS.codingTools) return field.type === 'boolean' && typeof value === 'boolean'
  if (path === DSH_UI_SETTING_PATHS.fontSize)
    return field.type === 'number' && isConversationFontSizePx(value)
  if (field.type !== 'enum' || typeof value !== 'string' || !field.enumValues?.includes(value)) return false
  if (path === DSH_UI_SETTING_PATHS.transcriptView) return isTranscriptViewMode(value)
  if (path === DSH_UI_SETTING_PATHS.performanceUsage) return isPerformanceUsageMode(value)
  return true
}
