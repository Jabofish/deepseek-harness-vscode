import type {
  AgentPresetDocument,
  AgentPresetLocation,
  AgentPresetRoster,
  CustomProviderCreateResult,
  CustomProviderDraft,
  DshRuntimeUpdateProgress,
  DshUpdateSnapshot,
  DiscoveredModel,
  ExtensionSettingsSummary,
  ModelDescriptor,
  ModelDiscoveryInput,
  ModelProvider,
  PluginInstallProgressView,
  PluginInventorySnapshot,
  SettingsPathOperation,
} from '@dsh-vscode/domain'
import type {
  FeatureRequest,
  AccountLifecycleErrorCodeDto,
  AccountProfileDetailsSnapshotDto,
  AccountLifecycleSnapshotDto,
  AccountSignOutImpactDto,
} from '@dsh-vscode/webview-protocol'
import type { DshSettingsSnapshot } from '../../app/store.js'
import type { PluginInstallInput, PluginInstallRecoveryState } from '../../app/plugin-install-recovery.js'
import type { ConversationFontSize, ThemePreference } from '../../app/ui-preferences.js'
import type { Locale } from '../../i18n.js'
export interface SettingsDrawerProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly connected: boolean
  readonly connectedDshVersion: string | undefined
  readonly onConfigureConnection: (mode: 'auto' | 'custom', endpoint?: string) => Promise<void>
  readonly dshUpdate?: DshUpdateSnapshot | undefined
  readonly dshUpdateProgress?: DshRuntimeUpdateProgress | undefined
  readonly onCheckDshUpdates?: (force?: boolean) => Promise<DshUpdateSnapshot | undefined>
  readonly onInstallDshVersion?: (version: string) => Promise<DshUpdateSnapshot | undefined>
  readonly theme: ThemePreference
  readonly onThemeChange: (value: ThemePreference) => void
  readonly locale: Locale
  /** Apply the shared extension/DSH language preference from a user action. */
  readonly onLocaleChange: (value: Locale) => void
  /** Adopt the authoritative DSH locale without issuing a second write. */
  readonly onLocaleFromDsh: (value: Locale) => void
  readonly conversationFontSize: ConversationFontSize
  readonly onConversationFontSizeChange: (value: ConversationFontSize) => void
  readonly providers: readonly ModelProvider[]
  readonly models: readonly ModelDescriptor[]
  readonly onLoadSettings: () => Promise<ExtensionSettingsSummary | undefined>
  readonly onLoadDshSettings: () => Promise<DshSettingsSnapshot | undefined>
  readonly onOpenDshSettingsDocument: () => Promise<void>
  readonly onOpenKeyboardShortcuts: () => Promise<void>
  readonly onUpdateDshSetting: (path: string, value: unknown, expectedRevision: number) => Promise<void>
  readonly onUnsetDshSetting: (path: string, expectedRevision: number) => Promise<void>
  readonly onMutateDshSettings: (
    namespace: string,
    operations: readonly SettingsPathOperation[],
    expectedRevision: number,
  ) => Promise<void>
  readonly onCreateCustomProvider: (draft: CustomProviderDraft) => Promise<CustomProviderCreateResult>
  readonly onDiscoverModels: (
    input: Omit<ModelDiscoveryInput, 'apiKey'>,
  ) => Promise<readonly DiscoveredModel[]>
  readonly onDiscoverCustomModels: (
    input: Omit<ModelDiscoveryInput, 'apiKey'>,
  ) => Promise<readonly DiscoveredModel[]>
  readonly onConfigureSecret: (providerId: string, field: string) => Promise<boolean>
  readonly onRemoveSecret: (providerId: string, field: string) => Promise<void>
  /** Host-mediated plugin credential actions; the secret never enters the Webview. */
  readonly onConfigurePluginCredential?: (ref: string) => Promise<boolean>
  readonly onRemovePluginCredential?: (ref: string) => Promise<void>
  readonly onRefreshCatalog: () => Promise<void>
  readonly onLoadPresetRoster: () => Promise<AgentPresetRoster | undefined>
  readonly onReadPresetDocument: (presetId: string) => Promise<AgentPresetDocument | undefined>
  readonly onCopyPreset: (from: string, presetId: string, name?: string) => Promise<string | undefined>
  readonly onRemovePreset: (presetId: string) => Promise<void>
  readonly onOpenPresetDocument: (presetId: string) => Promise<AgentPresetLocation | undefined>
  readonly onStartCreatorDraft?: () => Promise<void>
  readonly pluginInventoryRevision?: number
  readonly pluginInstallProgress?: PluginInstallProgressView | undefined
  readonly pluginInstallOperation?: PluginInstallRecoveryState | undefined
  readonly onStartPluginInstall?: (input: PluginInstallInput) => Promise<void>
  readonly onCancelPluginInstall?: () => Promise<void>
  readonly onRecoverPluginInstall?: () => Promise<void>
  readonly onLoadPluginInventory: () => Promise<PluginInventorySnapshot | undefined>
  readonly featureRequest?: <T>(request: FeatureRequest) => Promise<T>
  readonly accountLifecycleAvailable?: boolean
  readonly accountLifecycle?: AccountLifecycleSnapshotDto | null
  readonly accountLifecycleLoading?: boolean
  readonly accountLifecycleBusy?: boolean
  readonly accountLifecycleImpact?: AccountSignOutImpactDto
  readonly accountSessionExpired?: boolean
  readonly accountLifecycleError?: AccountLifecycleErrorCodeDto
  readonly accountLifecycleRequestFailed?: boolean
  readonly accountProfileDetails?: AccountProfileDetailsSnapshotDto | null
  readonly accountProfileLoading?: boolean
  readonly accountProfileRequestFailed?: boolean
  readonly onLoadAccountLifecycle?: () => Promise<void>
  readonly onLoadAccountDetails?: () => Promise<void>
  readonly onAcknowledgeAccountBonus?: (orderId: string) => Promise<boolean>
  readonly onOpenAccountPage?: (page: 'usage' | 'top-up') => void
  readonly onStartAccountSignIn?: () => Promise<void>
  readonly onCancelAccountSignIn?: (attemptId: string) => Promise<void>
  readonly onCheckAccountSignOutImpact?: () => Promise<void>
  readonly onSignOutAccount?: () => Promise<void>
}
