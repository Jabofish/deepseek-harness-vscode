import type { AgentConfiguration, AgentPresetDescriptor, ModelDescriptor } from '@dsh-vscode/domain'
import { useState, type ReactElement } from 'react'
import { CompactPicker, type CompactPickerOption } from './CompactPicker.js'
import { Icon, type IconName } from '../../ui/Icon.js'
import { ModelPicker } from '../models/ModelPicker.js'
import { useI18n } from '../../i18n.js'

export interface SessionControlsProps {
  readonly configuration: AgentConfiguration
  readonly models: readonly ModelDescriptor[]
  readonly presets: readonly AgentPresetDescriptor[]
  readonly permissionPresets: readonly string[]
  readonly estimatedContextTokens?: number
  readonly contextWindowTokens?: number
  readonly disabled: boolean
  readonly presetMutable: boolean
  readonly modelPickerOpenRequest?: number
  readonly onChange: (configuration: AgentConfiguration) => void
  readonly onCommand: (command: string) => void
}

export function SessionControls(props: SessionControlsProps): ReactElement {
  const { t } = useI18n()
  const riskContext = `${props.configuration.permissionPreset}:${props.disabled ? 'disabled' : 'enabled'}`
  const [riskState, setRiskState] = useState<{
    readonly context: string
    readonly pending?: string
    readonly acknowledged: boolean
  }>({ context: riskContext, acknowledged: false })
  if (riskState.context !== riskContext) {
    setRiskState({ context: riskContext, acknowledged: false })
  }
  const riskPending = riskState.context === riskContext ? riskState.pending : undefined
  const riskAcknowledged = riskState.context === riskContext && riskState.acknowledged
  const availablePresets = props.presets.filter((preset) => preset.broken === undefined)
  const selectedPreset = availablePresets.find((preset) => preset.id === props.configuration.preset)
  const modeOptions: CompactPickerOption[] = [
    ...(selectedPreset === undefined
      ? [
          {
            value: props.configuration.preset,
            label: formatPresetLabel(props.configuration.preset),
            disabled: true,
          },
        ]
      : []),
    ...availablePresets.map((preset) => ({
      value: preset.id,
      label: formatPresetLabel(preset.id, preset.name),
    })),
  ]
  const modeLabel =
    selectedPreset === undefined
      ? formatPresetLabel(props.configuration.preset)
      : formatPresetLabel(selectedPreset.id, selectedPreset.name)
  // Permission ids belong to the connected DSH composition. Preserve the
  // exact id returned by the host so the command registry receives the same
  // value that the permission plugin exposes (for example `full-access` or
  // `danger-full-access`).
  const permissionPreset = props.configuration.permissionPreset
  const availablePermissionPresets = permissionOptions(permissionPreset, props.permissionPresets)
  const contextWindowTokens = positiveTokenCount(props.contextWindowTokens)
  const contextLabel =
    props.estimatedContextTokens === undefined || contextWindowTokens === undefined
      ? undefined
      : formatContextLabel(props.estimatedContextTokens, contextWindowTokens)
  return (
    <div className="dsh-session-controls" aria-label={t('controls.aria')}>
      <div className="dsh-session-controls__selectors">
        <CompactPicker
          className="dsh-session-controls__mode"
          icon={modeIcon(props.configuration.preset, modeLabel)}
          displayLabel
          label={modeLabel}
          ariaLabel={t('controls.mode')}
          title={props.presetMutable ? t('controls.modeSelect') : t('controls.modeLocked')}
          value={props.configuration.preset}
          options={modeOptions}
          disabled={props.disabled || !props.presetMutable || availablePresets.length < 2}
          onChange={(preset) => props.onChange({ ...props.configuration, preset })}
        />
        <ModelPicker
          models={props.models}
          value={props.configuration.model}
          {...(props.modelPickerOpenRequest === undefined
            ? {}
            : { openRequest: props.modelPickerOpenRequest })}
          displayLabel
          disabled={props.disabled}
          onChange={(model) => props.onChange({ ...props.configuration, model })}
        />
        <CompactPicker
          className="dsh-session-controls__access-picker"
          icon="folder"
          label={formatPermissionLabel(permissionPreset)}
          ariaLabel={t('controls.access')}
          title={t('controls.accessChange')}
          value={permissionPreset}
          options={availablePermissionPresets.map((preset) => ({
            value: preset,
            label: formatPermissionLabel(preset),
          }))}
          disabled={props.disabled || availablePermissionPresets.length < 2}
          onChange={(preset) => {
            if (preset === 'danger-full-access') {
              setRiskState({ context: riskContext, pending: preset, acknowledged: false })
              return
            }
            props.onCommand(`/permission ${preset}`)
          }}
        />
        <button
          className="dsh-session-controls__access dsh-session-controls__plan"
          type="button"
          aria-label={props.configuration.planMode ? t('controls.planOff') : t('controls.planOn')}
          aria-pressed={props.configuration.planMode}
          title={props.configuration.planMode ? t('controls.planOff') : t('controls.planOn')}
          disabled={props.disabled}
          onClick={() => props.onCommand(props.configuration.planMode ? '/plan off' : '/plan')}
        >
          <Icon name="plan" />
          <span className="dsh-sr-only">
            {props.configuration.planMode ? t('controls.planOff') : t('controls.planOn')}
          </span>
        </button>
      </div>
      {riskPending === undefined ? null : (
        <div
          className="dsh-session-controls__risk"
          role="alertdialog"
          aria-label={t('controls.fullAccessQuestion')}
        >
          <p>{t('controls.fullAccessDetail')}</p>
          <label>
            <input
              type="checkbox"
              checked={riskAcknowledged}
              disabled={props.disabled}
              onChange={(event) => {
                const acknowledged = event.currentTarget.checked
                setRiskState((current) => ({
                  ...current,
                  acknowledged,
                }))
              }}
            />
            {t('controls.fullAccessAck')}
          </label>
          <div className="dsh-settings__risk-actions">
            <button
              className="dsh-button dsh-button--danger dsh-button--compact"
              type="button"
              disabled={props.disabled || !riskAcknowledged}
              onClick={() => {
                if (!riskAcknowledged) return
                const preset = riskPending
                setRiskState({ context: riskContext, acknowledged: false })
                props.onCommand(`/permission ${preset}`)
              }}
            >
              {t('controls.fullAccessEnable')}
            </button>
            <button
              className="dsh-button dsh-button--secondary dsh-button--compact"
              type="button"
              disabled={props.disabled}
              onClick={() => setRiskState({ context: riskContext, acknowledged: false })}
            >
              {t('controls.cancel')}
            </button>
          </div>
        </div>
      )}
      <dl className="dsh-session-controls__metrics">
        {contextLabel === undefined ? null : (
          <div
            aria-label={t('controls.contextAria', { value: contextLabel })}
            title={
              contextWindowTokens === undefined ? t('controls.contextUnknown') : t('controls.contextKnown')
            }
          >
            <dt className="dsh-sr-only">{t('controls.context')}</dt>
            <Icon name="target" />
            <dd>{contextLabel}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}

function formatPresetLabel(id: string, name?: string): string {
  const label = name?.trim() || id.trim()
  if (label === '') return 'Default mode'
  return label
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function modeIcon(id: string, label: string): IconName {
  const value = `${id} ${label}`.toLocaleLowerCase()
  if (/(^|\W)(plan|planning|计划)(\W|$)/u.test(value)) return 'file'
  if (/(^|\W)(code|coding|developer|development|编程|开发)(\W|$)/u.test(value)) return 'terminal'
  if (/(^|\W)(research|reasoning|deep|研究|推理)(\W|$)/u.test(value)) return 'users'
  if (/(^|\W)(minimal|light|fast|极简|轻量|快速)(\W|$)/u.test(value)) return 'sparkles'
  return 'session'
}

export function permissionOptions(current: string, projected: readonly string[]): readonly string[] {
  // The permissions projection is the entire switchable roster. When the
  // projection is absent, preserve only the current configuration value and
  // disable switching instead of inventing deployment-specific presets.
  return uniquePermissionOptions([current, ...projected])
}

export function formatPermissionLabel(id: string): string {
  if (isFullAccessPreset(id)) return 'Full access'
  return formatPresetLabel(id)
}

function isFullAccessPreset(id: string): boolean {
  return id === 'danger-full-access'
}

function uniqueOptions(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))]
}

function uniquePermissionOptions(values: readonly string[]): readonly string[] {
  const seenLabels = new Set<string>()
  return uniqueOptions(values).filter((value) => {
    const displayKey = isFullAccessPreset(value) ? 'full-access' : value
    if (seenLabels.has(displayKey)) return false
    seenLabels.add(displayKey)
    return true
  })
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function positiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function formatContextLabel(current: number, maximum: number | undefined): string {
  const safeCurrent = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0
  const currentLabel = `~${formatCount(safeCurrent)}`
  return maximum === undefined ? currentLabel : `${currentLabel} / ${formatCount(maximum)}`
}
