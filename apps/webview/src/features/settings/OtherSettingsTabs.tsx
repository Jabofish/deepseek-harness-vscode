import type { Dispatch, ReactElement, RefObject, SetStateAction } from 'react'
import type { Translate } from '../../i18n.js'
import { PluginInventory } from '../plugins/PluginInventory.js'
import { OptionalBundleManager } from '../plugins/OptionalBundleManager.js'
import { PluginConfiguration } from '../plugins/PluginConfiguration.js'
import { PresetManager } from './PresetManager.js'
import type { SettingsDrawerProps } from './settings-drawer-props.js'
import type { DshSettingsState } from './general-controls.js'

interface PresetsSettingsTabProps {
  readonly props: SettingsDrawerProps
  readonly t: Translate
  readonly dshState: DshSettingsState
  readonly dshSettingsSnapshotFresh: boolean
  readonly codingToolsEnabled: boolean
  readonly updateDisplayedSetting: (path: string, value: unknown) => Promise<void>
}

export function PresetsSettingsTab({
  props,
  t,
  dshState,
  dshSettingsSnapshotFresh,
  codingToolsEnabled,
  updateDisplayedSetting,
}: PresetsSettingsTabProps): ReactElement {
  return (
    <div
      className="dsh-settings__body"
      id="dsh-settings-panel-presets"
      role="tabpanel"
      aria-labelledby="dsh-settings-tab-presets"
      aria-label={t('settings.presetsAria')}
    >
      <PresetManager
        codingToolsEnabled={dshState.status === 'ready' && dshSettingsSnapshotFresh && codingToolsEnabled}
        defaultWritable={
          dshState.status === 'ready' && dshSettingsSnapshotFresh && dshState.snapshot.schema.writable
        }
        onLoadRoster={() => props.onLoadPresetRoster()}
        onReadDocument={(presetId) => props.onReadPresetDocument(presetId)}
        onCopy={(from, presetId, name) => props.onCopyPreset(from, presetId, name)}
        onRemove={(presetId) => props.onRemovePreset(presetId)}
        onOpenLocation={(presetId) => props.onOpenPresetDocument(presetId)}
        {...(props.onStartCreatorDraft === undefined
          ? {}
          : { onStartCreatorDraft: props.onStartCreatorDraft })}
        onMakeDefault={(presetId, settingsPath) =>
          updateDisplayedSetting(settingsPath ?? 'agent-presets.default', presetId)
        }
      />
    </div>
  )
}

interface PluginsSettingsTabProps {
  readonly props: SettingsDrawerProps
  readonly t: Translate
  readonly dshState: DshSettingsState
  readonly dshSettingsSnapshotFresh: boolean
  readonly openEpochRef: RefObject<number>
  readonly setDshState: Dispatch<SetStateAction<DshSettingsState>>
  readonly setDshSettingsSnapshotFresh: Dispatch<SetStateAction<boolean>>
}

export function PluginsSettingsTab({
  props,
  t,
  dshState,
  dshSettingsSnapshotFresh,
  openEpochRef,
  setDshState,
  setDshSettingsSnapshotFresh,
}: PluginsSettingsTabProps): ReactElement {
  return (
    <div
      className="dsh-settings__body"
      id="dsh-settings-panel-plugins"
      role="tabpanel"
      aria-labelledby="dsh-settings-tab-plugins"
      aria-label={t('settings.pluginsAria')}
    >
      <PluginConfiguration
        snapshot={dshState.status === 'ready' && dshSettingsSnapshotFresh ? dshState.snapshot : undefined}
        onReload={async () => {
          const epoch = openEpochRef.current
          try {
            const snapshot = await props.onLoadDshSettings()
            if (openEpochRef.current !== epoch) return snapshot
            if (snapshot !== undefined) {
              setDshState({ status: 'ready', snapshot })
              setDshSettingsSnapshotFresh(true)
            } else {
              setDshState({ status: 'unavailable' })
              setDshSettingsSnapshotFresh(false)
            }
            return snapshot
          } catch (reason: unknown) {
            if (openEpochRef.current === epoch) {
              setDshState({ status: 'unavailable' })
              setDshSettingsSnapshotFresh(false)
            }
            throw reason
          }
        }}
        onMutateSettings={props.onMutateDshSettings}
        onConfigureCredential={props.onConfigurePluginCredential}
        onRemoveCredential={props.onRemovePluginCredential}
      />
      <PluginInventory
        revision={props.pluginInventoryRevision}
        onLoadInventory={() => props.onLoadPluginInventory()}
      />
      {props.featureRequest === undefined ? null : (
        <OptionalBundleManager
          revision={props.pluginInventoryRevision ?? 0}
          {...(props.pluginInstallProgress === undefined
            ? {}
            : { installProgress: props.pluginInstallProgress })}
          {...(props.pluginInstallOperation === undefined
            ? {}
            : { installOperation: props.pluginInstallOperation })}
          {...(props.onStartPluginInstall === undefined
            ? {}
            : { onStartInstall: props.onStartPluginInstall })}
          {...(props.onCancelPluginInstall === undefined
            ? {}
            : { onCancelInstall: props.onCancelPluginInstall })}
          {...(props.onRecoverPluginInstall === undefined
            ? {}
            : { onRecoverInstall: props.onRecoverPluginInstall })}
          featureRequest={props.featureRequest}
        />
      )}
    </div>
  )
}
