import type { ComponentProps, ReactElement } from 'react'
import { SettingsDrawer } from './SettingsDrawer.js'
import type { AppStore } from '../../app/store.js'
import { setDraft } from '../../app/draft-store.js'
import type { ThemePreference, ConversationFontSize } from '../../app/ui-preferences.js'
import type { useI18n } from '../../i18n.js'

type DrawerProps = ComponentProps<typeof SettingsDrawer>

interface AppSettingsDrawerProps {
  readonly state: ReturnType<AppStore['getState']>
  readonly store: AppStore
  readonly themePreference: ThemePreference
  readonly setThemePreference: DrawerProps['onThemeChange']
  readonly locale: DrawerProps['locale']
  readonly applyLocale: DrawerProps['onLocaleChange']
  readonly adoptExplicitLocaleFromDsh: DrawerProps['onLocaleFromDsh']
  readonly conversationFontSize: ConversationFontSize
  readonly setConversationFontSize: DrawerProps['onConversationFontSizeChange']
  readonly readDshSettingsForUi: DrawerProps['onLoadDshSettings']
  readonly updateDshSettingFromDrawer: DrawerProps['onUpdateDshSetting']
  readonly unsetDshSettingFromDrawer: DrawerProps['onUnsetDshSetting']
  readonly mutateDshSettingsFromDrawer: DrawerProps['onMutateDshSettings']
  readonly setError: (message: string | undefined) => void
  readonly t: ReturnType<typeof useI18n>['t']
  readonly loadAccountDetailsFromSettings: NonNullable<DrawerProps['onLoadAccountDetails']>
  readonly acknowledgeAccountBonusFromSettings: NonNullable<DrawerProps['onAcknowledgeAccountBonus']>
  readonly openAccountPageFromSettings: NonNullable<DrawerProps['onOpenAccountPage']>
}

export function AppSettingsDrawer({
  state,
  store,
  themePreference,
  setThemePreference,
  locale,
  applyLocale,
  adoptExplicitLocaleFromDsh,
  conversationFontSize,
  setConversationFontSize,
  readDshSettingsForUi,
  updateDshSettingFromDrawer,
  unsetDshSettingFromDrawer,
  mutateDshSettingsFromDrawer,
  setError,
  t,
  loadAccountDetailsFromSettings,
  acknowledgeAccountBonusFromSettings,
  openAccountPageFromSettings,
}: AppSettingsDrawerProps): ReactElement {
  return (
    <SettingsDrawer
      open={state.drawer === 'settings'}
      onOpenChange={(open) => store.setDrawer(open ? 'settings' : undefined)}
      connected={state.backend.kind === 'connected'}
      connectedDshVersion={state.connectedDshVersion}
      onConfigureConnection={(mode, endpoint) => store.configureConnection(mode, endpoint)}
      dshUpdate={state.dshUpdate}
      dshUpdateProgress={state.dshUpdateProgress}
      onCheckDshUpdates={(force) => store.checkDshUpdates(force)}
      onInstallDshVersion={(version) => store.installDshVersion(version)}
      theme={themePreference}
      onThemeChange={setThemePreference}
      locale={locale}
      onLocaleChange={applyLocale}
      onLocaleFromDsh={adoptExplicitLocaleFromDsh}
      conversationFontSize={conversationFontSize}
      onConversationFontSizeChange={setConversationFontSize}
      providers={state.providers}
      models={state.models}
      onLoadSettings={() => store.readSettings()}
      onLoadDshSettings={readDshSettingsForUi}
      onOpenDshSettingsDocument={() => store.openDshSettingsDocument()}
      onOpenKeyboardShortcuts={() => store.openKeyboardShortcuts()}
      onUpdateDshSetting={updateDshSettingFromDrawer}
      onUnsetDshSetting={unsetDshSettingFromDrawer}
      onMutateDshSettings={mutateDshSettingsFromDrawer}
      onCreateCustomProvider={(draft) => store.createCustomProvider(draft)}
      onDiscoverModels={(input) => store.discoverModels(input)}
      onDiscoverCustomModels={(input) => store.discoverCustomProviderModels(input)}
      onConfigureSecret={(providerId, field) => store.configureProviderSecret(providerId, field)}
      onRemoveSecret={(providerId, field) => store.removeProviderSecret(providerId, field)}
      onConfigurePluginCredential={(ref) => store.configurePluginCredential(ref)}
      onRemovePluginCredential={(ref) => store.removePluginCredential(ref)}
      onRefreshCatalog={() => store.refreshModelCatalog()}
      onLoadPresetRoster={() => store.loadPresetRoster()}
      onReadPresetDocument={(presetId) => store.readPresetDocument(presetId)}
      onCopyPreset={(from, presetId, name) => store.copyPreset(from, presetId, name)}
      onRemovePreset={(presetId) => store.removePreset(presetId)}
      onOpenPresetDocument={(presetId) => store.openPresetDocument(presetId)}
      onStartCreatorDraft={async () => {
        const previousSessionId = store.getState().activeSessionId
        store.setDrawer(undefined)
        try {
          // DSH only lets a preset be chosen while the session is still blank, and
          // `agentPreset` is a host projection: staging it locally would show a mode
          // the host never confirmed, so create the session with the preset instead.
          await store.createSession(undefined, 'cordis')
        } catch (reason: unknown) {
          // The create was refused, so its session never became the active one.
          // Clearing the composer here would throw away a draft the user still
          // needs, so the reset only runs on the success path below.
          setError(reason instanceof Error ? reason.message : t('app.error.createSession'))
          return
        }
        const currentSessionId = store.getState().activeSessionId
        if (currentSessionId !== undefined && currentSessionId !== previousSessionId) setDraft('')
      }}
      pluginInventoryRevision={store.pluginInventoryRevision}
      pluginInstallProgress={store.pluginInstallProgress}
      pluginInstallOperation={state.pluginInstallOperation}
      onStartPluginInstall={(input) => store.startPluginInstall(input)}
      onCancelPluginInstall={() => store.cancelPluginInstall()}
      onRecoverPluginInstall={() => store.recoverPluginInstall()}
      onLoadPluginInventory={() => store.loadPluginInventory()}
      featureRequest={store.featureRequest}
      accountLifecycleAvailable={state.accountLifecycleAvailable}
      accountLifecycle={state.accountLifecycle}
      accountLifecycleLoading={state.accountLifecycleLoading}
      accountLifecycleBusy={state.accountLifecycleBusy}
      {...(state.accountLifecycleImpact === undefined
        ? {}
        : { accountLifecycleImpact: state.accountLifecycleImpact })}
      accountSessionExpired={state.accountSessionExpired}
      {...(state.accountLifecycleError === undefined
        ? {}
        : { accountLifecycleError: state.accountLifecycleError })}
      accountLifecycleRequestFailed={state.accountLifecycleRequestFailed}
      accountProfileDetails={state.accountProfileDetails}
      accountProfileLoading={state.accountProfileLoading}
      accountProfileRequestFailed={state.accountProfileRequestFailed}
      onLoadAccountLifecycle={() => store.loadAccountLifecycle()}
      onStartAccountSignIn={() => store.startAccountSignIn()}
      onCancelAccountSignIn={(attemptId) => store.cancelAccountSignIn(attemptId)}
      onCheckAccountSignOutImpact={() => store.checkAccountSignOutImpact()}
      onSignOutAccount={() => store.signOutAccount()}
      onLoadAccountDetails={loadAccountDetailsFromSettings}
      onAcknowledgeAccountBonus={acknowledgeAccountBonusFromSettings}
      onOpenAccountPage={openAccountPageFromSettings}
    />
  )
}
