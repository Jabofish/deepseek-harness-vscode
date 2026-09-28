import type { Dispatch, ReactElement, RefObject, SetStateAction } from 'react'
import type {
  CustomProviderCreateResult,
  CustomProviderDraft,
  ModelDescriptor,
  ModelProvider,
} from '@dsh-vscode/domain'
import type { Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { CustomProviderCard, type CustomProviderTemplate } from './CustomProviderCard.js'
import { ProviderSettingsEditor, type ProviderSettingChange } from './ProviderSettingsEditor.js'
import type { SettingsDrawerProps } from './settings-drawer-props.js'
import type { DshSettingsState } from './general-controls.js'

interface ModelsSettingsTabProps {
  readonly props: SettingsDrawerProps
  readonly t: Translate
  readonly orderedProviderRows: readonly ModelProvider[]
  readonly modelsByProvider: ReadonlyMap<string, readonly ModelDescriptor[]>
  readonly busyField: string | undefined
  readonly setBusyField: Dispatch<SetStateAction<string | undefined>>
  readonly saveError: string | undefined
  readonly setSaveError: Dispatch<SetStateAction<string | undefined>>
  readonly dshState: DshSettingsState
  readonly dshSettingsSnapshotFresh: boolean
  readonly editingProviderId: string | undefined
  readonly setEditingProviderId: Dispatch<SetStateAction<string | undefined>>
  readonly setAddingProviderId: Dispatch<SetStateAction<string | undefined>>
  readonly setAddingCustomProvider: Dispatch<SetStateAction<boolean>>
  readonly setRemovingProviderId: Dispatch<SetStateAction<string | undefined>>
  readonly removeProviderTriggerRef: RefObject<HTMLElement | null>
  readonly removeDialogRef: RefObject<HTMLDivElement | null>
  readonly runSecretAction: (key: string, action: () => Promise<void>) => void
  readonly saveProviderChanges: (
    provider: ModelProvider,
    changes: readonly ProviderSettingChange[],
    expectedRevision: number,
    ensureProvider?: boolean,
  ) => Promise<void>
  readonly addableProviders: readonly ModelProvider[]
  readonly canAddCustomProvider: boolean
  readonly addingProvider: ModelProvider | undefined
  readonly addingCustomProvider: boolean
  readonly customProviderTemplate: CustomProviderTemplate | undefined
  readonly saveCustomProvider: (draft: CustomProviderDraft) => Promise<CustomProviderCreateResult>
  readonly configureCustomProviderSecret: (providerId: string, field: string) => Promise<boolean>
  readonly pendingProvider: ModelProvider | undefined
  readonly removeProvider: (provider: ModelProvider) => Promise<void>
}

export function ModelsSettingsTab(input: ModelsSettingsTabProps): ReactElement {
  const {
    props,
    t,
    orderedProviderRows,
    modelsByProvider,
    busyField,
    setBusyField,
    saveError,
    setSaveError,
    dshState,
    dshSettingsSnapshotFresh,
    editingProviderId,
    setEditingProviderId,
    setAddingProviderId,
    setAddingCustomProvider,
    setRemovingProviderId,
    removeProviderTriggerRef,
    removeDialogRef,
    runSecretAction,
    saveProviderChanges,
    addableProviders,
    canAddCustomProvider,
    addingProvider,
    addingCustomProvider,
    customProviderTemplate,
    saveCustomProvider,
    configureCustomProviderSecret,
    pendingProvider,
    removeProvider,
  } = input
  return (
    <div
      className="dsh-settings__body"
      id="dsh-settings-panel-models"
      role="tabpanel"
      aria-labelledby="dsh-settings-tab-models"
      aria-label={t('settings.modelsAria')}
    >
      <div className="dsh-settings__toolbar">
        <span className="dsh-settings__summary">
          {t(orderedProviderRows.length === 1 ? 'settings.providerCount' : 'settings.providerCountPlural', {
            count: orderedProviderRows.length,
          })}{' '}
          ·{' '}
          {t(props.models.length === 1 ? 'settings.modelCount' : 'settings.modelCountPlural', {
            count: props.models.length,
          })}
        </span>
        <button
          className="dsh-icon-button"
          type="button"
          aria-label={t('settings.refreshCatalog')}
          title={t('settings.refreshCatalog')}
          disabled={busyField !== undefined}
          onClick={() => {
            if (busyField !== undefined) return
            setSaveError(undefined)
            setBusyField('refresh')
            void props
              .onRefreshCatalog()
              .catch((reason: unknown) =>
                setSaveError(reason instanceof Error ? reason.message : t('settings.updateFailed')),
              )
              .finally(() => setBusyField(undefined))
          }}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {saveError === undefined ? null : (
        <p className="dsh-settings__error" role="alert">
          {saveError}
        </p>
      )}
      {dshState.status === 'loading' ? (
        <p className="dsh-settings__empty" role="status">
          {t('settings.loadingDsh')}
        </p>
      ) : orderedProviderRows.length === 0 ? (
        <p className="dsh-settings__empty">{t('settings.noProviders')}</p>
      ) : (
        <ul className="dsh-settings__providers">
          {orderedProviderRows.map((provider) => {
            const providerModels = modelsByProvider.get(provider.id) ?? []
            const providerName =
              provider.settingsNs === 'llm-deepseek-account' ? t('settings.deepseekAccount') : provider.name
            const secretFields = provider.fields.filter((field) => field.secret)
            const editable =
              dshState.status === 'ready' &&
              dshSettingsSnapshotFresh &&
              provider.settingsNs !== undefined &&
              provider.settingsNs.trim() !== ''
            const isEditing = editingProviderId === provider.id
            return (
              <li className="dsh-settings__provider" key={provider.id}>
                <div className="dsh-settings__provider-head">
                  <div className="dsh-settings__provider-identity">
                    <strong title={provider.id}>{providerName}</strong>
                    {provider.id === provider.name ? null : <code>{provider.id}</code>}
                    <span className="dsh-settings__provider-kind">{provider.kind}</span>
                    {provider.active === true ? (
                      <span className="dsh-settings__provider-active" title={t('settings.activeProvider')}>
                        {t('settings.active')}
                      </span>
                    ) : null}
                  </div>
                  <div className="dsh-settings__provider-actions">
                    {editable ? (
                      <button
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        type="button"
                        disabled={!dshSettingsSnapshotFresh || (busyField !== undefined && !isEditing)}
                        onClick={() => {
                          setSaveError(undefined)
                          setAddingCustomProvider(false)
                          setAddingProviderId(undefined)
                          setEditingProviderId(isEditing ? undefined : provider.id)
                        }}
                      >
                        {isEditing ? t('settings.closeEditor') : t('settings.editProvider')}
                      </button>
                    ) : null}
                    {(provider.settingsPath?.length ?? 0) > 0 ? (
                      <button
                        className="dsh-button dsh-button--secondary dsh-button--compact dsh-settings__provider-remove"
                        type="button"
                        disabled={busyField !== undefined || !dshSettingsSnapshotFresh}
                        onClick={(event) => {
                          removeProviderTriggerRef.current = event.currentTarget
                          setSaveError(undefined)
                          setRemovingProviderId(provider.id)
                        }}
                      >
                        {t('settings.removeProvider')}
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="dsh-settings__provider-summary">
                  <span>
                    {t(
                      providerModels.length === 1 ? 'settings.modelsSummary' : 'settings.modelsSummaryPlural',
                      { count: providerModels.length },
                    )}
                  </span>
                  {secretFields.map((field) => {
                    const key = `${provider.id}:${field.key}`
                    return (
                      <span className="dsh-settings__provider-credential" key={field.key}>
                        <span
                          className={`dsh-settings__field-state${field.value === undefined ? '' : ' dsh-settings__field-state--ok'}`}
                        >
                          <span
                            className="dsh-settings__secret-dot"
                            data-configured={field.value === undefined ? 'false' : 'true'}
                            aria-hidden="true"
                          />
                          {field.value === undefined ? t('settings.missing') : t('settings.configured')}
                        </span>
                        <button
                          className="dsh-button dsh-button--secondary dsh-button--compact"
                          type="button"
                          disabled={busyField !== undefined || field.writable === false}
                          onClick={() =>
                            runSecretAction(key, async () => {
                              await props.onConfigureSecret(provider.id, field.key)
                            })
                          }
                        >
                          {field.value === undefined ? t('settings.configure') : t('settings.replace')}
                        </button>
                        {field.value === undefined ? null : (
                          <button
                            className="dsh-icon-button"
                            type="button"
                            aria-label={t('settings.removeSecret', {
                              provider: provider.name,
                              field: field.label,
                            })}
                            title={t('settings.removeSecretTitle')}
                            disabled={busyField !== undefined || field.writable === false}
                            onClick={() =>
                              runSecretAction(key, async () => {
                                await props.onRemoveSecret(provider.id, field.key)
                              })
                            }
                          >
                            <Icon name="close" />
                          </button>
                        )}
                      </span>
                    )
                  })}
                </div>
                {isEditing && dshState.status === 'ready' && provider.settingsNs !== undefined ? (
                  <ProviderSettingsEditor
                    provider={provider}
                    catalogModels={providerModels}
                    settings={dshState.snapshot}
                    writable={dshState.snapshot.schema.writable}
                    saving={busyField === `provider:${provider.id}`}
                    onSave={(changes, expectedRevision) =>
                      saveProviderChanges(provider, changes, expectedRevision)
                    }
                    onDiscover={props.onDiscoverModels}
                    onClose={(changed) => {
                      setEditingProviderId(undefined)
                      if (!changed) setSaveError(undefined)
                    }}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {addableProviders.length === 0 && !canAddCustomProvider ? null : (
        <>
          <div className="dsh-settings__provider-add-actions">
            <button
              className="dsh-settings__provider-add"
              type="button"
              disabled={
                busyField !== undefined ||
                dshState.status !== 'ready' ||
                !dshSettingsSnapshotFresh ||
                !dshState.snapshot.schema.writable ||
                addableProviders.length === 0
              }
              onClick={() => {
                const firstProvider = addableProviders[0]
                if (firstProvider === undefined) return
                setSaveError(undefined)
                setEditingProviderId(undefined)
                setAddingCustomProvider(false)
                setAddingProviderId((current) => (current === undefined ? firstProvider.id : undefined))
              }}
            >
              <Icon name="add" />
              {t('settings.addProvider')}
            </button>
            <button
              className="dsh-settings__provider-add"
              type="button"
              disabled={
                busyField !== undefined ||
                dshState.status !== 'ready' ||
                !dshSettingsSnapshotFresh ||
                !dshState.snapshot.schema.writable ||
                !canAddCustomProvider
              }
              onClick={() => {
                setSaveError(undefined)
                setEditingProviderId(undefined)
                setAddingProviderId(undefined)
                setAddingCustomProvider((current) => !current)
              }}
            >
              <Icon name="add" />
              {t('settings.addCustomProvider')}
            </button>
          </div>
          {addingProvider === undefined || dshState.status !== 'ready' ? null : (
            <section
              className="dsh-settings__provider-add-card"
              role="region"
              aria-label={t('settings.addProvider')}
            >
              <div className="dsh-settings__provider-add-select">
                <span>{t('settings.addProviderSelect')}</span>
                <SelectMenu
                  className="dsh-settings__provider-add-picker"
                  icon="box"
                  density="regular"
                  label={addingProvider.name}
                  ariaLabel={t('settings.addProviderSelect')}
                  title={t('settings.addProviderSelect')}
                  value={addingProvider.id}
                  disabled={busyField !== undefined}
                  options={addableProviders.map((provider) => ({
                    value: provider.id,
                    label: provider.name,
                  }))}
                  placement="below"
                  align="start"
                  onChange={(value) => {
                    const next = addableProviders.find((provider) => provider.id === value)
                    if (next === undefined) return
                    setSaveError(undefined)
                    setAddingProviderId(next.id)
                  }}
                />
              </div>
              <ProviderSettingsEditor
                key={addingProvider.id}
                provider={addingProvider}
                settings={dshState.snapshot}
                writable={dshState.snapshot.schema.writable}
                saving={busyField === `provider:${addingProvider.id}`}
                forceSave={(addingProvider.settingsPath?.length ?? 0) > 0}
                onSave={(changes, expectedRevision) =>
                  saveProviderChanges(addingProvider, changes, expectedRevision, true)
                }
                onDiscover={props.onDiscoverModels}
                onClose={(changed) => {
                  setAddingProviderId(undefined)
                  if (!changed) setSaveError(undefined)
                }}
              />
            </section>
          )}
          {addingCustomProvider && customProviderTemplate !== undefined ? (
            <CustomProviderCard
              template={customProviderTemplate}
              providers={props.providers}
              writable={dshState.status === 'ready' && dshState.snapshot.schema.writable}
              saving={busyField !== undefined}
              onClose={(changed) => {
                setAddingCustomProvider(false)
                if (!changed) setSaveError(undefined)
              }}
              onCreate={saveCustomProvider}
              onConfigureSecret={configureCustomProviderSecret}
              onDiscover={props.onDiscoverCustomModels}
            />
          ) : null}
        </>
      )}
      {pendingProvider === undefined ? null : (
        <div
          ref={removeDialogRef}
          className="dsh-settings__provider-remove-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-label={t('settings.removeProvider')}
        >
          <h3>{t('settings.removeProviderHeading')}</h3>
          <p>{t('settings.removeProviderPrompt', { provider: pendingProvider.name })}</p>
          <div className="dsh-settings__risk-actions">
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact"
              type="button"
              disabled={busyField !== undefined}
              autoFocus
              onClick={() => setRemovingProviderId(undefined)}
            >
              {t('settings.cancel')}
            </button>
            <button
              className="dsh-button dsh-button--danger dsh-button--compact"
              type="button"
              disabled={busyField !== undefined}
              onClick={() => void removeProvider(pendingProvider)}
            >
              {busyField === `remove-provider:${pendingProvider.id}`
                ? t('settings.removingProvider')
                : t('settings.removeProviderConfirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
