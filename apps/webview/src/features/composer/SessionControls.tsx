import type { AgentConfiguration, AgentPresetDescriptor, ModelDescriptor } from '@dsh-vscode/domain'
import type { ReactElement } from 'react'
import { CompactPicker, type CompactPickerOption } from './CompactPicker.js'
import { Icon, type IconName } from '../../ui/Icon.js'
import { ModelPicker } from '../models/ModelPicker.js'

export interface SessionControlsProps {
  readonly configuration: AgentConfiguration
  readonly models: readonly ModelDescriptor[]
  readonly presets: readonly AgentPresetDescriptor[]
  readonly permissionPresets: readonly string[]
  readonly estimatedContextTokens: number
  readonly contextWindowTokens?: number
  readonly cacheHitRate: number
  readonly disabled: boolean
  readonly presetMutable: boolean
  readonly modelPickerOpenRequest?: number
  readonly onChange: (configuration: AgentConfiguration) => void
  readonly onCommand: (command: string) => void
}

export function SessionControls(props: SessionControlsProps): ReactElement {
  const selectedModel = props.models.find(
    (model) =>
      model.providerId === props.configuration.model.providerId &&
      model.id === props.configuration.model.modelId,
  )
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
  const contextWindowTokens = positiveTokenCount(props.contextWindowTokens ?? selectedModel?.contextWindow)
  const contextLabel = formatContextLabel(props.estimatedContextTokens, contextWindowTokens)
  return (
    <div className="dsh-session-controls" aria-label="Session controls">
      <div className="dsh-session-controls__selectors">
        <CompactPicker
          className="dsh-session-controls__mode"
          icon={modeIcon(props.configuration.preset, modeLabel)}
          displayLabel
          label={modeLabel}
          ariaLabel="Mode"
          title={
            props.presetMutable
              ? 'Select the DSH agent mode for this blank session'
              : 'Agent mode is locked after the first turn'
          }
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
          ariaLabel="Access"
          title="Change the current session permission preset"
          value={permissionPreset}
          options={availablePermissionPresets.map((preset) => ({
            value: preset,
            label: formatPermissionLabel(preset),
          }))}
          disabled={props.disabled}
          onChange={(preset) => {
            props.onCommand(`/permission ${preset}`)
          }}
        />
        <button
          className="dsh-session-controls__access dsh-session-controls__plan"
          type="button"
          aria-label={props.configuration.planMode ? 'Turn off plan mode' : 'Turn on plan mode'}
          aria-pressed={props.configuration.planMode}
          title={props.configuration.planMode ? 'Turn off plan mode' : 'Turn on plan mode'}
          disabled={props.disabled}
          onClick={() => props.onCommand(props.configuration.planMode ? '/plan off' : '/plan')}
        >
          <Icon name="plan" />
          <span className="dsh-sr-only">
            {props.configuration.planMode ? 'Turn off plan mode' : 'Turn on plan mode'}
          </span>
        </button>
      </div>
      <dl className="dsh-session-controls__metrics">
        <div
          aria-label={`Context ${contextLabel} tokens`}
          title={
            contextWindowTokens === undefined
              ? 'Approximate context usage. DSH has not reported a route capacity yet.'
              : 'Approximate next-request context usage reported by DSH, compared with the selected route capacity.'
          }
        >
          <dt className="dsh-sr-only">Context</dt>
          <Icon name="target" />
          <dd>{contextLabel}</dd>
        </div>
        <div
          aria-label={`Cache hit ${formatPercent(props.cacheHitRate)}`}
          title="Cache hit = cache reads ÷ (uncached input + cache reads). Cache writes are tracked separately."
        >
          <dt className="dsh-sr-only">Cache</dt>
          <Icon name="box" />
          <dd>{formatPercent(props.cacheHitRate)}</dd>
        </div>
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

function formatPercent(value: number): string {
  const percent = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100
  if (percent > 0 && percent < 1) return '<1%'
  return `${Math.round(percent)}%`
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
  if (projected.length > 0) return uniquePermissionOptions([current, ...projected])
  // The permission plugin uses a deployment-defined roster. rc.6 sessions
  // expose the active id, so use that id as the source of truth and add only
  // the conventional choices that are missing. Never add both full-access
  // spellings: they are aliases in different DSH compositions and would
  // render as two identical rows while sending different commands.
  const fullAccessId = current === 'danger-full-access' ? 'danger-full-access' : 'full-access'
  return uniquePermissionOptions([current, 'read-only', 'workspace-write', fullAccessId])
}

export function formatPermissionLabel(id: string): string {
  if (isFullAccessPreset(id)) return 'Full access'
  return formatPresetLabel(id)
}

function isFullAccessPreset(id: string): boolean {
  return id === 'full-access' || id === 'danger-full-access'
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
