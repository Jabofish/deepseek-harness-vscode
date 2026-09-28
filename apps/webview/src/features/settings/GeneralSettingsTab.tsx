import type { Dispatch, ReactElement, SetStateAction } from 'react'
import type { ExtensionSettingsSummary } from '@dsh-vscode/domain'
import {
  DSH_UI_SETTING_PATHS,
  findDshSettingsField,
  type dshUiPreferences as readDshUiPreferences,
} from '../../app/ui-preferences.js'
import { SettingCard, SettingRow } from '../../components/common/SettingCard.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { Icon } from '../../ui/Icon.js'
import { AccountLifecycle } from '../account/AccountLifecycle.js'
import { AccountProfile } from '../account/AccountProfile.js'
import { accountLifecycleLabels, accountProfileLabels } from './account-labels.js'
import {
  GeneralSettingRow,
  hasPreferencesContent,
  renderCodingToolsSetting,
  renderFontSizeControl,
  visibleGeneralRows,
  type DshSettingsState,
  type RiskPending,
} from './general-controls.js'
import {
  DSH_UPDATE_PROGRESS_TOTAL_STAGES,
  connectionModeLabel,
  dshUpdateFailureMessage,
  dshUpdateProgressLabel,
  dshUpdateProgressStage,
} from './update-labels.js'
import type { SettingsDrawerProps } from './settings-drawer-props.js'
import type { Translate, Locale } from '../../i18n.js'

const LOCALE_OPTIONS: readonly Locale[] = ['en', 'zh']

function isRiskValue(value: string): boolean {
  return value === 'danger-full-access'
}

interface GeneralSettingsTabProps {
  readonly props: SettingsDrawerProps
  readonly t: Translate
  readonly settingsState: { readonly value: ExtensionSettingsSummary | undefined } | undefined
  readonly refreshAccountDetails: () => void
  readonly acknowledgeAccountBonus: (orderId: string) => Promise<boolean>
  readonly openAccountUsage: () => void
  readonly openAccountTopUp: () => void
  readonly connectionChoice: 'auto' | 'custom' | 'unchanged'
  readonly setConnectionChoice: Dispatch<SetStateAction<'auto' | 'custom' | 'unchanged'>>
  readonly connectionEndpoint: string
  readonly setConnectionEndpoint: Dispatch<SetStateAction<string>>
  readonly connectionBusy: boolean
  readonly connectionError: string | undefined
  readonly setConnectionError: Dispatch<SetStateAction<string | undefined>>
  readonly connectionNotice: string | undefined
  readonly setConnectionNotice: Dispatch<SetStateAction<string | undefined>>
  readonly applyConnection: () => void
  readonly dshUpdateBusy: 'check' | 'install' | undefined
  readonly checkDshUpdates: () => void
  readonly installDshVersion: () => void
  readonly dshUpdateError: string | undefined
  readonly availableDshVersions: readonly string[]
  readonly effectiveSelectedDshVersion: string | undefined
  readonly selectedDshVersionAlreadyInstalled: boolean
  readonly setSelectedDshVersion: Dispatch<SetStateAction<string | undefined>>
  readonly dshState: DshSettingsState
  readonly dshUiPreferences: ReturnType<typeof readDshUiPreferences> | undefined
  readonly dshSettingsSnapshotFresh: boolean
  readonly retryDshSettings: () => void
  readonly savingPath: string | undefined
  readonly riskPending: RiskPending | undefined
  readonly setRiskPending: Dispatch<SetStateAction<RiskPending | undefined>>
  readonly riskAcknowledged: boolean
  readonly setRiskAcknowledged: Dispatch<SetStateAction<boolean>>
  readonly saveSetting: (path: string, value: unknown) => void
  readonly saveError: string | undefined
  readonly busyField: string | undefined
  readonly openSettingsDocument: () => void
  readonly documentError: string | undefined
  readonly openKeyboardShortcuts: () => void
  readonly keyboardShortcutsError: string | undefined
}

export function GeneralSettingsTab(input: GeneralSettingsTabProps): ReactElement {
  const {
    props,
    t,
    settingsState,
    refreshAccountDetails,
    acknowledgeAccountBonus,
    openAccountUsage,
    openAccountTopUp,
    connectionChoice,
    setConnectionChoice,
    connectionEndpoint,
    setConnectionEndpoint,
    connectionBusy,
    connectionError,
    setConnectionError,
    connectionNotice,
    setConnectionNotice,
    applyConnection,
    dshUpdateBusy,
    checkDshUpdates,
    installDshVersion,
    dshUpdateError,
    availableDshVersions,
    effectiveSelectedDshVersion,
    selectedDshVersionAlreadyInstalled,
    setSelectedDshVersion,
    dshState,
    dshUiPreferences,
    dshSettingsSnapshotFresh,
    retryDshSettings,
    savingPath,
    riskPending,
    setRiskPending,
    riskAcknowledged,
    setRiskAcknowledged,
    saveSetting,
    saveError,
    busyField,
    openSettingsDocument,
    documentError,
    openKeyboardShortcuts,
    keyboardShortcutsError,
  } = input
  const { onCheckDshUpdates, onInstallDshVersion, dshUpdate, dshUpdateProgress } = props
  return (
    <div
      className="dsh-settings__body"
      id="dsh-settings-panel-general"
      role="tabpanel"
      aria-labelledby="dsh-settings-tab-general"
      aria-label={t('settings.generalAria')}
    >
      {props.accountLifecycleAvailable === true ? (
        <>
          <AccountLifecycle
            snapshot={props.accountLifecycleLoading === true ? null : (props.accountLifecycle ?? null)}
            {...(props.accountLifecycleImpact === undefined ? {} : { impact: props.accountLifecycleImpact })}
            sessionExpired={props.accountSessionExpired === true}
            {...(props.accountLifecycleError === undefined ? {} : { hostError: props.accountLifecycleError })}
            requestFailed={props.accountLifecycleRequestFailed === true}
            busy={props.accountLifecycleBusy === true || props.accountLifecycleLoading === true}
            labels={accountLifecycleLabels(t)}
            onSignIn={() => void props.onStartAccountSignIn?.()}
            onCancelSignIn={(attemptId) => void props.onCancelAccountSignIn?.(attemptId)}
            onCheckSignOutImpact={() => void props.onCheckAccountSignOutImpact?.()}
            onSignOut={() => void props.onSignOutAccount?.()}
            onRetry={() => void props.onLoadAccountLifecycle?.()}
          />
          <AccountProfile
            snapshot={props.accountProfileDetails ?? null}
            signedIn={props.accountLifecycle?.status === 'credential-stored'}
            busy={props.accountProfileLoading === true}
            requestFailed={props.accountProfileRequestFailed === true}
            labels={accountProfileLabels(t)}
            locale={props.locale}
            onRefresh={refreshAccountDetails}
            onAcknowledgeBonus={acknowledgeAccountBonus}
            onOpenUsage={openAccountUsage}
            onOpenTopUp={openAccountTopUp}
          />
        </>
      ) : null}
      {settingsState === undefined ? (
        <p className="dsh-settings__empty" role="status">
          {t('settings.loading')}
        </p>
      ) : settingsState.value === undefined ? (
        <p className="dsh-settings__empty" role="status">
          {t('settings.unavailable')}
        </p>
      ) : (
        (() => {
          const settings = settingsState.value
          return (
            <>
              <dl className="dsh-settings__facts">
                <dt>{t('settings.extensionVersion')}</dt>
                <dd>{settings.extensionVersion}</dd>
                <dt>{t('settings.connectionMode')}</dt>
                <dd>{connectionModeLabel(settings.connection.mode, t)}</dd>
                <dt>{t('settings.runtime')}</dt>
                <dd>
                  {t(
                    settings.runtime.customExecutableConfigured
                      ? 'settings.runtimeCustom'
                      : 'settings.runtimeDiscovered',
                  )}
                </dd>
                <dt>{t('settings.dshVersion')}</dt>
                <dd>
                  {props.connectedDshVersion ??
                    t(props.connected ? 'settings.versionUnavailable' : 'settings.notConnected')}
                </dd>
                <dt>{t('settings.permissionPreset')}</dt>
                <dd>{settings.security.defaultPermissionPreset}</dd>
                <dt>{t('settings.defaultAgent')}</dt>
                <dd>
                  {settings.defaultAgent.model.providerId}/{settings.defaultAgent.model.modelId}
                </dd>
              </dl>
              <SettingCard
                ariaLabel={t('settings.connectionTitle')}
                title={t('settings.connectionTitle')}
                description={t('settings.connectionHint')}
              >
                <div
                  className="dsh-settings__connection-options"
                  role="radiogroup"
                  aria-label={t('settings.connectionMode')}
                >
                  <label
                    className={`dsh-settings__connection-option${
                      connectionChoice === 'auto' ? ' dsh-settings__connection-option--active' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="dsh-connection-mode"
                      value="auto"
                      checked={connectionChoice === 'auto'}
                      onChange={() => {
                        setConnectionChoice('auto')
                        setConnectionError(undefined)
                        setConnectionNotice(undefined)
                      }}
                    />
                    <span>
                      <strong>{t('settings.automatic')}</strong>
                      <small>{t('settings.connectionAutoHint')}</small>
                    </span>
                  </label>
                  <label
                    className={`dsh-settings__connection-option${
                      connectionChoice === 'custom' ? ' dsh-settings__connection-option--active' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="dsh-connection-mode"
                      value="custom"
                      checked={connectionChoice === 'custom'}
                      onChange={() => {
                        setConnectionChoice('custom')
                        setConnectionError(undefined)
                        setConnectionNotice(undefined)
                      }}
                    />
                    <span>
                      <strong>{t('settings.connectionCustom')}</strong>
                      <small>{t('settings.connectionCustomHint')}</small>
                    </span>
                  </label>
                </div>
                {connectionChoice === 'custom' ? (
                  <label className="dsh-settings__connection-endpoint">
                    <span>{t('settings.connectionEndpoint')}</span>
                    <input
                      type="text"
                      inputMode="url"
                      value={connectionEndpoint}
                      placeholder={
                        settings.connection.customEndpointConfigured
                          ? t('settings.connectionEndpointConfigured')
                          : t('settings.connectionEndpointPlaceholder')
                      }
                      onChange={(event) => {
                        setConnectionEndpoint(event.target.value)
                        setConnectionError(undefined)
                        setConnectionNotice(undefined)
                      }}
                    />
                  </label>
                ) : null}
                {connectionChoice === 'unchanged' ? (
                  <p className="dsh-settings__connection-notice">{t('settings.connectionUnchangedHint')}</p>
                ) : null}
                <div className="dsh-settings__connection-actions">
                  <button
                    className="dsh-button dsh-button--primary dsh-button--compact"
                    type="button"
                    disabled={connectionBusy || connectionChoice === 'unchanged'}
                    onClick={applyConnection}
                  >
                    {connectionBusy ? t('settings.connectionApplying') : t('settings.connectionApply')}
                  </button>
                </div>
                {connectionError === undefined ? null : (
                  <p className="dsh-settings__error" role="alert">
                    {connectionError}
                  </p>
                )}
                {connectionNotice === undefined ? null : (
                  <p className="dsh-settings__connection-notice" role="status">
                    {connectionNotice}
                  </p>
                )}
              </SettingCard>
            </>
          )
        })()
      )}
      {onCheckDshUpdates !== undefined && onInstallDshVersion !== undefined ? (
        <section className="dsh-settings__runtime-update" aria-label={t('settings.dshUpdateTitle')}>
          <div className="dsh-settings__runtime-update-head">
            <div>
              <h3>{t('settings.dshUpdateTitle')}</h3>
              <p>{t('settings.dshUpdateHint')}</p>
            </div>
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact dsh-settings__runtime-update-check"
              type="button"
              disabled={dshUpdateBusy !== undefined}
              onClick={checkDshUpdates}
            >
              {dshUpdateBusy === 'check' ? t('settings.dshUpdateChecking') : t('settings.dshUpdateCheck')}
            </button>
          </div>
          {dshUpdate === undefined ? (
            <p className="dsh-settings__empty" role="status">
              {t('settings.dshUpdateLoading')}
            </p>
          ) : dshUpdate.status === 'unavailable' ? (
            <p className="dsh-settings__error" role="alert">
              {dshUpdateFailureMessage(dshUpdate.failure, t)}
            </p>
          ) : (
            <>
              {dshUpdateBusy !== undefined ? (
                <div className="dsh-settings__runtime-update-progress" role="status" aria-live="polite">
                  <div className="dsh-settings__runtime-update-progress-head">
                    <span>{dshUpdateProgressLabel(dshUpdateBusy, dshUpdateProgress, t)}</span>
                    <span>
                      {t('settings.dshUpdateProgressStage', {
                        current: dshUpdateProgressStage(dshUpdateBusy, dshUpdateProgress),
                        total: DSH_UPDATE_PROGRESS_TOTAL_STAGES,
                      })}
                    </span>
                  </div>
                  <div
                    className="dsh-settings__runtime-update-progress-track"
                    role="progressbar"
                    aria-label={t('settings.dshUpdateProgressLabel')}
                    aria-valuemin={0}
                    aria-valuemax={DSH_UPDATE_PROGRESS_TOTAL_STAGES}
                    aria-valuenow={dshUpdateProgressStage(dshUpdateBusy, dshUpdateProgress)}
                    aria-valuetext={dshUpdateProgressLabel(dshUpdateBusy, dshUpdateProgress, t)}
                  >
                    {Array.from({ length: DSH_UPDATE_PROGRESS_TOTAL_STAGES }, (_, index) => {
                      const stage = index + 1
                      const current = dshUpdateProgressStage(dshUpdateBusy, dshUpdateProgress)
                      return (
                        <span
                          className={`dsh-settings__runtime-update-progress-step${
                            stage < current ? ' dsh-settings__runtime-update-progress-step--complete' : ''
                          }${stage === current ? ' dsh-settings__runtime-update-progress-step--active' : ''}`}
                          key={stage}
                        />
                      )
                    })}
                  </div>
                </div>
              ) : null}
              <dl className="dsh-settings__runtime-update-facts">
                <dt>{t('settings.dshUpdateCurrent')}</dt>
                <dd>{dshUpdate.currentVersion ?? t('settings.dshUpdateNotInstalled')}</dd>
                <dt>{t('settings.dshUpdateGlobal')}</dt>
                <dd>{dshUpdate.globalVersion ?? t('settings.dshUpdateNotInstalled')}</dd>
                <dt>{t('settings.dshUpdateLatest')}</dt>
                <dd>{dshUpdate.latestVersion ?? t('settings.dshUpdateUnavailable')}</dd>
              </dl>
              {dshUpdate.updateAvailable ? (
                <p className="dsh-settings__runtime-update-notice" role="status">
                  {t('settings.dshUpdateAvailable', {
                    version: dshUpdate.latestVersion ?? '—',
                  })}
                </p>
              ) : null}
              {selectedDshVersionAlreadyInstalled && effectiveSelectedDshVersion !== undefined ? (
                <p className="dsh-settings__runtime-update-notice" role="status">
                  {t('settings.dshUpdateAlreadyInstalled', {
                    version: effectiveSelectedDshVersion,
                  })}
                </p>
              ) : null}
              <div className="dsh-settings__runtime-update-controls">
                <span>{t('settings.dshUpdateVersion')}</span>
                <SelectMenu
                  className="dsh-settings__runtime-update-version"
                  icon="refresh"
                  density="regular"
                  displayLabel
                  label={effectiveSelectedDshVersion ?? t('settings.dshUpdateUnavailable')}
                  ariaLabel={t('settings.dshUpdateVersion')}
                  title={t('settings.dshUpdateVersion')}
                  value={effectiveSelectedDshVersion ?? ''}
                  disabled={dshUpdateBusy !== undefined}
                  options={availableDshVersions.map((version) => ({
                    value: version,
                    label: version,
                  }))}
                  placement="below"
                  onChange={setSelectedDshVersion}
                />
                <button
                  className="dsh-button dsh-button--primary dsh-button--compact"
                  type="button"
                  disabled={
                    dshUpdateBusy !== undefined ||
                    effectiveSelectedDshVersion === undefined ||
                    selectedDshVersionAlreadyInstalled ||
                    availableDshVersions.length === 0
                  }
                  onClick={installDshVersion}
                >
                  {selectedDshVersionAlreadyInstalled
                    ? t('settings.dshUpdateInstalled')
                    : dshUpdateBusy === 'install'
                      ? t('settings.dshUpdateInstalling')
                      : t('settings.dshUpdateInstall')}
                </button>
              </div>
              {dshUpdate.restartRequired ? (
                <p className="dsh-settings__note">{t('settings.dshUpdateRestart')}</p>
              ) : null}
              {dshUpdateError === undefined ? null : (
                <p className="dsh-settings__error" role="alert">
                  {dshUpdateError}
                </p>
              )}
            </>
          )}
        </section>
      ) : null}
      <SettingCard ariaLabel={t('settings.extensionPreferences')} title={t('settings.extensionPreferences')}>
        <SettingRow
          title={t('settings.language.label')}
          description={t('settings.language.hint')}
          control={
            <div className="dsh-settings__segment" role="group" aria-label={t('settings.language.label')}>
              {LOCALE_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={`dsh-settings__segment-item${
                    option === props.locale ? ' dsh-settings__segment-item--active' : ''
                  }`}
                  type="button"
                  aria-pressed={option === props.locale}
                  onClick={() => {
                    if (option !== props.locale) props.onLocaleChange(option)
                  }}
                >
                  {option === 'zh' ? t('locale.chinese') : t('locale.english')}
                </button>
              ))}
            </div>
          }
        />
      </SettingCard>
      <SettingCard ariaLabel={t('settings.preferences')} title={t('settings.preferences')}>
        {dshState.status === 'loading' ? (
          <p className="dsh-settings__empty" role="status">
            {t('settings.loadingDsh')}
          </p>
        ) : dshState.status === 'unavailable' ? (
          <>
            <p className="dsh-settings__empty">{t('settings.dshUnavailable')}</p>
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact"
              type="button"
              onClick={retryDshSettings}
            >
              {t('runtime.retry')}
            </button>
          </>
        ) : !hasPreferencesContent(dshState.snapshot) ? (
          // A schema that advertises none of these rows must not read as
          // a broken card: state what the host offers instead of an
          // empty titled box.
          <p className="dsh-settings__empty">{t('settings.preferencesEmpty')}</p>
        ) : (
          <>
            {!dshState.snapshot.schema.writable ? (
              <p className="dsh-settings__empty" role="status">
                {t('settings.readOnly')}
              </p>
            ) : null}
            {!dshSettingsSnapshotFresh ? (
              <div className="dsh-settings__empty" role="status">
                <p>{t('settings.revisionRefreshRequired')}</p>
                <button
                  className="dsh-button dsh-button--secondary dsh-button--compact"
                  type="button"
                  onClick={retryDshSettings}
                >
                  {t('runtime.retry')}
                </button>
              </div>
            ) : null}
            <ul className="dsh-settings__rows">
              {visibleGeneralRows(dshState.snapshot).map((row) => (
                <GeneralSettingRow
                  key={row.path}
                  row={{
                    path: row.path,
                    label: t(row.labelKey),
                    hint: t(row.hintKey),
                    ...(row.defaultValue === undefined ? {} : { defaultValue: row.defaultValue }),
                  }}
                  fields={dshState.snapshot.schema.fields}
                  values={dshState.snapshot.values}
                  writable={dshState.snapshot.schema.writable}
                  selectedValue={row.path === 'ui-theme.preference' ? props.theme : undefined}
                  saving={savingPath === row.path}
                  disabled={
                    !dshState.snapshot.schema.writable ||
                    savingPath !== undefined ||
                    !dshSettingsSnapshotFresh
                  }
                  riskPending={riskPending?.path === row.path ? riskPending : undefined}
                  riskAcknowledged={riskAcknowledged}
                  onPick={(value) => {
                    if (isRiskValue(value)) {
                      setRiskAcknowledged(false)
                      setRiskPending({ path: row.path, value })
                      return
                    }
                    saveSetting(row.path, value)
                  }}
                  onConfirmRisk={() => {
                    if (riskPending === undefined || !riskAcknowledged) return
                    saveSetting(riskPending.path, riskPending.value)
                  }}
                  onRiskAcknowledgedChange={setRiskAcknowledged}
                  onCancelRisk={() => {
                    setRiskAcknowledged(false)
                    setRiskPending(undefined)
                  }}
                />
              ))}
            </ul>
            {renderCodingToolsSetting(
              dshState.snapshot,
              dshUiPreferences?.codingToolsEnabled,
              savingPath,
              dshSettingsSnapshotFresh,
              (value) => saveSetting(DSH_UI_SETTING_PATHS.codingTools, value),
              t,
            )}
            {saveError === undefined ? null : (
              <p className="dsh-settings__error" role="alert">
                {saveError}
              </p>
            )}
          </>
        )}
      </SettingCard>
      <SettingCard
        ariaLabel={t('settings.conversationAppearance')}
        title={t('settings.conversationAppearance')}
      >
        {dshState.status === 'ready' &&
        findDshSettingsField(dshState.snapshot, DSH_UI_SETTING_PATHS.fontSize)?.type === 'number' &&
        !dshState.snapshot.schema.writable ? null : (
          <SettingRow
            title={t('settings.conversationFontSize')}
            description={t('settings.conversationFontSizeHint')}
            control={renderFontSizeControl(
              dshState,
              dshUiPreferences?.fontSize,
              props.conversationFontSize,
              savingPath,
              dshSettingsSnapshotFresh,
              saveError,
              (value) => saveSetting(DSH_UI_SETTING_PATHS.fontSize, value),
              props.onConversationFontSizeChange,
              t,
            )}
          />
        )}
      </SettingCard>
      <p className="dsh-settings__note">{t('settings.hostNote')}</p>
      {dshState.status === 'ready' && dshState.snapshot.schema.hasDocument ? (
        <div className="dsh-settings__document-action">
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            disabled={busyField !== undefined}
            onClick={openSettingsDocument}
          >
            <Icon name="file" />
            {t('settings.openDocument')}
          </button>
          {documentError === undefined ? null : (
            <span className="dsh-settings__error" role="alert">
              {documentError}
            </span>
          )}
        </div>
      ) : null}
      <SettingCard ariaLabel={t('settings.keyboardShortcuts')} title={t('settings.keyboardShortcuts')}>
        <p className="dsh-settings__description">{t('settings.keyboardShortcutsHint')}</p>
        <div className="dsh-settings__document-action">
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            disabled={busyField !== undefined}
            onClick={openKeyboardShortcuts}
          >
            {t('settings.keyboardShortcutsOpen')}
          </button>
          {keyboardShortcutsError === undefined ? null : (
            <span className="dsh-settings__error" role="alert">
              {keyboardShortcutsError}
            </span>
          )}
        </div>
      </SettingCard>
    </div>
  )
}
