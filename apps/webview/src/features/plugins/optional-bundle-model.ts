import {
  pluginLocalizedText,
  type ManagedPluginEntry,
  type PluginBundleChangeResult,
  type PluginManagerBundle,
  type PluginManagerSnapshot,
  type PluginRegistry,
  type PluginRegistryCatalog,
  type PluginSpecInspection,
} from '@dsh-vscode/domain'
import type { Translate } from '../../i18n.js'
import type { SelectMenuOption } from '../../components/common/SelectMenu.js'

let requestOrdinal = 0

export function newRequestId(): string {
  requestOrdinal += 1
  return `plugin-manager-${Date.now().toString(36)}-${requestOrdinal.toString(36)}`
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function resultOf(value: unknown): PluginBundleChangeResult | undefined {
  const payload = object(value)
  const result = object(payload?.result)
  if (
    payload?.kind !== 'plugin.bundle.changed' ||
    typeof result?.name !== 'string' ||
    typeof result.changed !== 'boolean' ||
    !['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(String(result.application))
  )
    return undefined
  return result as unknown as PluginBundleChangeResult
}

export function catalogOf(value: unknown): PluginManagerSnapshot | undefined {
  const payload = object(value)
  if (
    payload?.kind !== 'plugin.bundles' ||
    typeof payload.available !== 'boolean' ||
    !Array.isArray(payload.bundles) ||
    !Array.isArray(payload.plugins)
  )
    return undefined
  return payload as unknown as PluginManagerSnapshot
}

export function registriesOf(value: unknown): PluginRegistryCatalog | null {
  const payload = object(value)
  if (payload?.kind !== 'plugin.registries' || payload.available !== true) return null
  const registries = object(payload.registries)
  if (
    registries === undefined ||
    !(registries.registry === null || typeof registries.registry === 'string') ||
    !Array.isArray(registries.fallbackRegistries) ||
    !registries.fallbackRegistries.every((entry) => typeof entry === 'string') ||
    !(registries.resolved === null || typeof registries.resolved === 'string')
  )
    return null
  return registries as unknown as PluginRegistryCatalog
}

export function inspectionOf(value: unknown): PluginSpecInspection | undefined {
  const payload = object(value)
  const inspection = object(payload?.inspection)
  if (payload?.kind !== 'plugin.inspection' || inspection === undefined) return undefined
  if (inspection.status === 'refused' && typeof inspection.problem === 'string')
    return inspection as unknown as PluginSpecInspection
  if (
    inspection.status === 'accepted' &&
    typeof inspection.kind === 'string' &&
    (inspection.bundle === null || typeof inspection.bundle === 'boolean') &&
    (inspection.registry === null || typeof inspection.registry === 'string')
  )
    return inspection as unknown as PluginSpecInspection
  return undefined
}

export function localized(
  value: PluginManagerBundle['title'],
  locale: string,
): ReturnType<typeof pluginLocalizedText> {
  return pluginLocalizedText(value, locale)
}

export function localizedSearchValues(value: PluginManagerBundle['title']): readonly string[] {
  if (value === undefined) return []
  return typeof value === 'string' ? [value] : Object.values(value)
}

export function matchesSearch(
  query: string,
  locale: string,
  values: readonly (string | undefined)[],
): boolean {
  return (
    query === '' ||
    values.some((value) => value !== undefined && value.toLocaleLowerCase(locale).includes(query))
  )
}

export function pluginSearchValues(plugin: ManagedPluginEntry): readonly string[] {
  return [
    plugin.entryId,
    plugin.moduleName,
    ...localizedSearchValues(plugin.meta?.title),
    ...localizedSearchValues(plugin.meta?.description),
  ]
}

/** Registry picker sentinels: the host's configured default, and a user-supplied URL. */
export const CONFIGURED_REGISTRY = '__configured__'
export const CUSTOM_REGISTRY = '__custom__'

export interface RegistryView {
  readonly catalog: PluginRegistryCatalog | null
  readonly selected: string
  readonly custom: string
}

export function registryOptions(catalog: PluginRegistryCatalog | null): readonly PluginRegistry[] {
  if (catalog === null) return [null]
  const values: PluginRegistry[] = [catalog.registry, ...catalog.fallbackRegistries, null]
  const seenUrls = new Set<string>()
  let hasPnpmRegistry = false
  return values.filter((value) => {
    if (value === null) {
      if (hasPnpmRegistry) return false
      hasPnpmRegistry = true
      return true
    }
    const key = normalizedRegistryKey(value)
    if (seenUrls.has(key)) return false
    seenUrls.add(key)
    return true
  })
}

/** Match the pinned DSH registry comparison: canonical URL and a trailing path slash. */
export function normalizedRegistryKey(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url.href
  } catch {
    return value
  }
}

export function registryValue(registry: PluginRegistry): string {
  return registry === null ? CONFIGURED_REGISTRY : registry
}

export function registryFromValue(value: string): PluginRegistry | undefined {
  return value === CONFIGURED_REGISTRY ? null : value === CUSTOM_REGISTRY ? undefined : value
}

/** The registry menu and its trigger must agree on one label per value. */
export function registryChoices(
  registries: readonly PluginRegistry[],
  view: RegistryView,
  t: Translate,
  locale: string,
): readonly SelectMenuOption[] {
  return [
    ...registries.map((registry) => ({
      value: registryValue(registry),
      label:
        registry === null
          ? t('plugins.manager.registry.configured', {
              name:
                view.catalog?.resolved === null || view.catalog === null
                  ? t('plugins.manager.registry.current')
                  : registrySourceLabel(view.catalog.resolved, locale),
            })
          : registrySourceLabel(registry, locale),
    })),
    { value: CUSTOM_REGISTRY, label: t('plugins.manager.registry.custom') },
  ]
}

/** Give well-known sources their own names and keep private registry paths out of the picker. */
export function registrySourceLabel(value: string, locale: string): string {
  let host: string
  try {
    host = new URL(value).host
  } catch {
    return locale === 'zh' ? '其他注册源' : 'Other registry'
  }
  const normalizedHost = host.toLowerCase()
  const name =
    normalizedHost === 'registry.npmjs.org'
      ? locale === 'zh'
        ? 'npm 官方源'
        : 'Official npm registry'
      : normalizedHost === 'registry.npmmirror.com'
        ? locale === 'zh'
          ? '中国大陆镜像源'
          : 'Mainland China mirror'
        : undefined
  if (name === undefined) return host
  return locale === 'zh' ? `${name}（${host}）` : `${name} (${host})`
}

export function isGithubSpec(spec: string): boolean {
  if (/^(?:github|gist):/iu.test(spec)) return true
  let host: string | undefined
  const scp = /^git@([^:]+):/iu.exec(spec)
  if (scp !== null) host = scp[1]
  else if (/^git(?:\+[a-z]+)?:\/\//iu.test(spec)) {
    try {
      host = new URL(spec.replace(/^git\+/iu, '')).hostname
    } catch {
      return false
    }
  } else if (/^https?:\/\//iu.test(spec)) {
    try {
      host = new URL(spec).hostname
    } catch {
      return false
    }
  }
  const normalizedHost = host?.toLowerCase()
  return normalizedHost === 'github.com' || normalizedHost?.endsWith('.github.com') === true
}

export function canRecoverGithubInstall(result: PluginBundleChangeResult): boolean {
  return (
    result.application === 'failed' &&
    result.failedAt === 'spec-host' &&
    (result.failureKind === 'network' || result.failureKind === 'timeout') &&
    isGithubSpec(result.name)
  )
}

export function isValidRegistry(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

export function failureKey(result: PluginBundleChangeResult): string {
  if (result.errorCode === 'incompatible-version') return 'plugins.manager.failure.incompatible'
  if (result.errorCode === 'management-required' || result.errorCode === 'unaddressable')
    return 'plugins.manager.failure.protected'
  if (
    result.errorCode === 'not-removable' ||
    result.errorCode === 'bundle-in-use' ||
    result.errorCode === 'stop-profile'
  )
    return 'plugins.manager.failure.inUse'
  if (result.errorCode === 'stale-approval') return 'plugins.manager.failure.staleApproval'
  if (result.failureKind === 'network' || result.failedAt === 'registry' || result.failedAt === 'spec-host')
    return 'plugins.manager.failure.network'
  if (result.failureKind === 'permission') return 'plugins.manager.failure.permission'
  if (result.failureKind === 'build-blocked') return 'plugins.manager.failure.buildBlocked'
  if (result.failureKind === 'disk-full') return 'plugins.manager.failure.diskFull'
  if (result.failureKind === 'timeout') return 'plugins.manager.failure.timeout'
  return 'plugins.manager.failure.generic'
}

export function pluginTitle(plugin: ManagedPluginEntry, locale: string): string {
  return localized(plugin.meta?.title, locale) ?? plugin.moduleName
}

export function resultText(t: Translate, result: PluginBundleChangeResult): string {
  if (result.application === 'failed') return t(failureKey(result))
  if (result.application === 'restart-required') return t('plugins.bundles.result.restart')
  if (result.application === 'overridden') return t('plugins.bundles.result.overridden')
  if (result.application === 'cancelled') return t('plugins.bundles.result.cancelled')
  if (!result.changed) return t('plugins.bundles.result.unchanged')
  if (result.stage === 'install') return t('plugins.manager.install.done')
  if (result.stage === 'remove') return t('plugins.manager.remove.done')
  return result.enabled === false ? t('plugins.bundles.result.disabled') : t('plugins.bundles.result.enabled')
}
