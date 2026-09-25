import type { PluginFiberPhase } from './advanced.js'
import type { PluginMetadata, PluginLocalizedText } from './plugin-metadata.js'

/** Stable Plugin Manager codes; upstream diagnostics may contain paths or process output. */
export type PluginBundleFailureCode =
  | 'management-required'
  | 'unaddressable'
  | 'unknown-plugin'
  | 'invalid-spec'
  | 'ambiguous-install'
  | 'not-bundle'
  | 'not-removable'
  | 'stop-profile'
  | 'bundle-in-use'
  | 'stale-approval'
  | 'incompatible-version'
  | 'operation-error'

export type PluginBundleApplication = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'

export type PluginInstallFailureKind =
  | 'pnpm-missing'
  | 'timeout'
  | 'not-found'
  | 'no-matching-version'
  | 'network'
  | 'disk-full'
  | 'permission'
  | 'build-blocked'
  | 'integrity'
  | 'unknown'

export type PluginRegistry = string | null

export interface PluginRegistryCatalog {
  readonly registry: PluginRegistry
  readonly fallbackRegistries: readonly string[]
  readonly resolved: string | null
}

export interface PluginBundleRow {
  readonly rowId: string
  readonly moduleName: string
  readonly meta?: PluginMetadata
  readonly entryId?: string
}

export interface ManagedPluginEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly meta?: PluginMetadata
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
  readonly readOnlyReason?: 'management-required' | 'unaddressable'
}

/** A profile or installation bundle discovered from the live RC2 Plugin Manager. */
export interface PluginManagerBundle {
  readonly name: string
  readonly version?: string
  readonly title?: PluginLocalizedText
  readonly description?: PluginLocalizedText
  readonly enabled: boolean
  readonly installed: boolean
  readonly optional: boolean
  readonly removable: boolean
  readonly readOnlyReason?: 'management-required' | 'unaddressable'
  readonly errorCode?: PluginBundleFailureCode
  readonly rows: readonly PluginBundleRow[]
  readonly overrides: readonly string[]
}

export interface PluginManagerSnapshot {
  readonly available: boolean
  readonly bundles: readonly PluginManagerBundle[]
  readonly plugins: readonly ManagedPluginEntry[]
}

export type PluginInspectProblem =
  | 'invalid-spec'
  | 'already-installed'
  | 'not-found'
  | 'not-a-package'
  | 'not-a-bundle'
  | 'network'
  | 'unknown'

export type PluginInstallSpecKind = 'registry' | 'path' | 'git' | 'tarball'

export type PluginSpecInspection =
  | {
      readonly status: 'accepted'
      readonly kind: PluginInstallSpecKind
      readonly name?: string
      readonly version?: string
      readonly description?: string
      readonly bundle: boolean | null
      readonly registry: PluginRegistry
      readonly host?: string
    }
  | {
      readonly status: 'refused'
      readonly problem: PluginInspectProblem
      readonly registries?: readonly PluginRegistry[]
    }

export interface PluginBundleChangeResult {
  /** Upstream target: bundle name, plugin entry id, or original install spec. */
  readonly name: string
  readonly changed: boolean
  readonly application: PluginBundleApplication
  readonly enabled?: boolean
  readonly stage?: 'install' | 'enable' | 'remove'
  readonly errorCode?: PluginBundleFailureCode
  readonly failureKind?: PluginInstallFailureKind
  readonly failedAt?: 'registry' | 'spec-host'
  readonly bundle?: string
  readonly pendingBuilds?: readonly string[]
}

export interface PluginInstallCancellation {
  readonly status: 'cancelled' | 'too-late' | 'not-running'
}

/** Safe Host projection of the live RC2 install-state event. Registry URLs and log data are omitted. */
export interface PluginInstallProgressView {
  readonly requestId: string
  readonly phase: 'installing' | 'cancelling' | 'applying'
  readonly attemptIndex?: number
  readonly attemptTotal?: number
}

export interface PluginInstallOptions {
  readonly requestId: string
  readonly registry?: PluginRegistry
  readonly approvedBuilds?: readonly string[]
}

/** Complete RC2 Plugin Manager boundary. Older DSH adapters do not expose it. */
export interface PluginBundleRepository {
  listBundles(signal?: AbortSignal): Promise<readonly PluginManagerBundle[]>
  listPlugins(signal?: AbortSignal): Promise<readonly ManagedPluginEntry[]>
  registries(signal?: AbortSignal): Promise<PluginRegistryCatalog>
  inspect(spec: string, registry?: PluginRegistry, signal?: AbortSignal): Promise<PluginSpecInspection>
  installBundle(
    spec: string,
    options: PluginInstallOptions,
    signal?: AbortSignal,
  ): Promise<PluginBundleChangeResult>
  waitForInstall(requestId: string, signal?: AbortSignal): Promise<PluginBundleChangeResult | null>
  cancelInstall(requestId: string, signal?: AbortSignal): Promise<PluginInstallCancellation>
  removeBundle(name: string, signal?: AbortSignal): Promise<PluginBundleChangeResult>
  setPluginEnabled(entryId: string, enabled: boolean, signal?: AbortSignal): Promise<PluginBundleChangeResult>
  setBundleEnabled(name: string, enabled: boolean, signal?: AbortSignal): Promise<PluginBundleChangeResult>
}
