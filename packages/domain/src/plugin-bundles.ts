import type { PluginLocalizedText } from './plugin-metadata.js'

/** A stable DSH Plugin Manager error category, without its external diagnostic text. */
export type PluginBundleFailureCode =
  | 'management-required'
  | 'unaddressable'
  | 'unknown-plugin'
  | 'not-bundle'
  | 'not-removable'
  | 'stop-profile'
  | 'bundle-in-use'
  | 'incompatible-version'
  | 'operation-error'

export type PluginBundleApplication = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'

/** A profile-wide optional bundle that the connected DSH installation offers. */
export interface OptionalPluginBundle {
  readonly name: string
  readonly version?: string
  readonly title?: PluginLocalizedText
  readonly description?: PluginLocalizedText
  /** Whether the bundle is selected in the current profile; this is not live Fiber state. */
  readonly enabled: boolean
  /** Whether the profile itself owns a package dependency (DSH may supply optional bundles). */
  readonly installed: boolean
  /** The Host could not fully inspect or safely activate this bundle. */
  readonly hasIssue: boolean
  readonly readOnlyReason?: 'management-required' | 'unaddressable'
}

/** Sanitized result of the official `pluginManager.setBundleEnabled` Remote. */
export interface PluginBundleChangeResult {
  readonly name: string
  readonly changed: boolean
  readonly application: PluginBundleApplication
  readonly enabled: boolean
  readonly errorCode?: PluginBundleFailureCode
}

export interface PluginBundleRepository {
  /** Returns the current catalog filtered by the upstream `optional` flag. */
  listOptionalBundles(signal?: AbortSignal): Promise<readonly OptionalPluginBundle[]>
  setBundleEnabled(name: string, enabled: boolean, signal?: AbortSignal): Promise<PluginBundleChangeResult>
}

export interface OptionalPluginBundleSnapshot {
  readonly available: boolean
  readonly bundles: readonly OptionalPluginBundle[]
}
