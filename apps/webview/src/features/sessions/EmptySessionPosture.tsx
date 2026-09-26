import { useState, type ReactElement } from 'react'
import type { AgentPresetDescriptor, WorkspaceSummary } from '@dsh-vscode/domain'
import { EmptyState } from '@dsh-vscode/ui'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { presetDisplayName } from '../settings/preset-display.js'

export function EmptySessionPosture(props: {
  readonly workspaces: readonly WorkspaceSummary[]
  readonly presets: readonly AgentPresetDescriptor[]
  readonly presetSelectionEnabled?: boolean
  readonly empty: boolean
  readonly onCreate: (workspaceId: string, presetId?: string) => void
}): ReactElement {
  const { locale, t } = useI18n()
  const hostDefaultPresetId = props.presets.find((preset) => preset.isDefault)?.id
  const missingHostDefaultPreset =
    props.presetSelectionEnabled === false && props.presets.length > 0 && hostDefaultPresetId === undefined
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(props.workspaces[0]?.id ?? '')
  const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>(undefined)
  const selected =
    props.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? props.workspaces[0]
  const availablePresets = props.presets.filter((preset) => preset.broken === undefined)
  const stagedPreset =
    availablePresets.find((preset) => preset.id === selectedPresetId) ??
    availablePresets.find((preset) => preset.isDefault) ??
    availablePresets[0]
  const stagedPresetId = stagedPreset?.id ?? ''
  const oneShotPresetId =
    props.presetSelectionEnabled !== false &&
    availablePresets.some((preset) => preset.id === selectedPresetId)
      ? selectedPresetId
      : undefined

  if (props.workspaces.length === 0)
    return <EmptyState title={t('app.workspaceLoading')} description={t('app.workspaceLoadingDescription')} />

  return (
    <section className="dsh-empty-session" aria-live="polite">
      <div className="dsh-empty-session__icon" aria-hidden="true">
        <Icon name="session" />
      </div>
      <span className="dsh-app__eyebrow">{t('app.noActiveSession')}</span>
      <h2>{props.empty ? t('app.createSession') : t('app.chooseSession')}</h2>
      <p>{t('app.workspacePickerHint')}</p>
      <div className="dsh-empty-session__picker">
        <span>{t('app.workspacePicker')}</span>
        <SelectMenu
          icon="folder"
          density="regular"
          displayLabel
          menuMode="flow"
          label={selected?.name ?? t('app.workspacePicker')}
          ariaLabel={t('app.workspacePicker')}
          title={t('app.workspacePicker')}
          value={selected?.id ?? ''}
          options={props.workspaces.map((workspace) => ({
            value: workspace.id,
            label: workspace.name,
          }))}
          onChange={setSelectedWorkspaceId}
        />
      </div>
      {availablePresets.length === 0 || props.presetSelectionEnabled === false ? null : (
        <div className="dsh-empty-session__preset">
          <span>{t('app.presetPicker')}</span>
          <SelectMenu
            icon="sparkles"
            density="regular"
            displayLabel
            menuMode="flow"
            label={stagedPreset === undefined ? t('app.presetPicker') : presetDisplayName(stagedPreset, t)}
            ariaLabel={t('app.presetPicker')}
            title={t('app.presetPicker')}
            value={stagedPresetId}
            options={availablePresets.map((preset) => ({
              value: preset.id,
              label: presetDisplayName(preset, t),
            }))}
            onChange={setSelectedPresetId}
          />
          <span className="dsh-sr-only">{t('app.presetStaged')}</span>
        </div>
      )}
      {missingHostDefaultPreset ? (
        <p role="status">
          {t('presets.modeSelectionHidden')}.{' '}
          {locale === 'zh'
            ? 'DSH 未报告默认预设；创建会话可能沿用过期选择。请先在 DSH 中配置默认预设。'
            : 'DSH did not report a default preset, so creating a session could reuse an outdated selection. Configure a default preset in DSH first.'}
        </p>
      ) : null}
      <button
        className="dsh-button dsh-button--primary"
        type="button"
        disabled={selected === undefined || missingHostDefaultPreset}
        onClick={() => {
          if (selected !== undefined && !missingHostDefaultPreset) {
            const presetId = props.presetSelectionEnabled === false ? undefined : oneShotPresetId
            props.onCreate(selected.id, presetId)
          }
        }}
      >
        {t('app.newSessionInWorkspace')}
      </button>
    </section>
  )
}
