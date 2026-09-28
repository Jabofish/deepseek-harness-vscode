import { useState, type ReactElement } from 'react'
import type { DshSettingsSchema } from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import {
  CONVERSATION_FONT_SIZE_OPTIONS,
  DEFAULT_CONVERSATION_FONT_SIZE_PX,
  DSH_UI_SETTING_PATHS,
  MAX_CONVERSATION_FONT_SIZE_PX,
  MIN_CONVERSATION_FONT_SIZE_PX,
  findDshSettingsField,
  isConversationFontSizePx,
  isPerformanceUsageMode,
  isTranscriptViewMode,
  type ConversationFontSize,
} from '../../app/ui-preferences.js'
import { SettingRow } from '../../components/common/SettingCard.js'
import { useI18n, type Translate } from '../../i18n.js'
import { formatSettingValue, settingValueAt } from './settings-values.js'

export type DshSettingsState =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly snapshot: DshSettingsSnapshot }

/** A full-access confirmation waiting for the user, keyed by row path. */
export interface RiskPending {
  readonly path: string
  readonly value: string
}

/** Official General-section rows in upstream feature-slot order. A row renders
 * only when the DSH host schema advertises its field — the client never
 * fabricates a control for a namespace the host did not expose. */
export const GENERAL_SETTING_ROWS: readonly {
  readonly path: string
  readonly labelKey: string
  readonly hintKey: string
  readonly defaultValue?: string
}[] = [
  {
    path: 'permission.defaultPreset',
    labelKey: 'settings.permission.label',
    hintKey: 'settings.permission.hint',
  },
  {
    path: 'ui-theme.preference',
    labelKey: 'settings.appearance.label',
    hintKey: 'settings.appearance.hint',
  },
  {
    path: 'ui-chat.transcriptView',
    labelKey: 'settings.transcriptView.label',
    hintKey: 'settings.transcriptView.hint',
    defaultValue: 'standard',
  },
  {
    path: 'ui-chat.performanceUsage',
    labelKey: 'settings.performanceUsage.label',
    hintKey: 'settings.performanceUsage.hint',
    defaultValue: 'detailed',
  },
  {
    path: 'ui-conversation.busyEnter',
    labelKey: 'settings.enter.label',
    hintKey: 'settings.enter.hint',
    defaultValue: 'queue',
  },
]

export function renderCodingToolsSetting(
  snapshot: DshSettingsSnapshot,
  value: boolean | undefined,
  savingPath: string | undefined,
  snapshotFresh: boolean,
  onChange: (value: boolean) => void,
  t: Translate,
): ReactElement | null {
  const field = findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.codingTools)
  if (field?.type !== 'boolean' || !snapshot.schema.writable) return null
  const label = t('settings.codingTools.label')
  const saving = savingPath === DSH_UI_SETTING_PATHS.codingTools
  const enabled = value === true
  return (
    <SettingRow
      title={label}
      description={t('settings.codingTools.hint')}
      status={
        <>
          {field.restartRequired ? (
            <span className="dsh-setting-row__status-note" title={t('settings.restartTitle')}>
              {t('settings.restart')}
            </span>
          ) : null}
          {saving ? (
            <span className="dsh-setting-row__status-saving" role="status">
              {t('settings.saving')}
            </span>
          ) : null}
        </>
      }
      control={
        <button
          className="dsh-settings__switch"
          type="button"
          role="switch"
          aria-label={label}
          aria-checked={enabled}
          disabled={!snapshot.schema.writable || savingPath !== undefined || !snapshotFresh}
          onClick={() => onChange(!enabled)}
        >
          <span aria-hidden="true" />
        </button>
      }
    />
  )
}

export function renderFontSizeControl(
  dshState: DshSettingsState,
  hostFontSize: number | undefined,
  localFontSize: ConversationFontSize,
  savingPath: string | undefined,
  snapshotFresh: boolean,
  error: string | undefined,
  onHostChange: (value: number) => void,
  onLocalChange: (value: ConversationFontSize) => void,
  t: Translate,
): ReactElement {
  const field =
    dshState.status === 'ready'
      ? findDshSettingsField(dshState.snapshot, DSH_UI_SETTING_PATHS.fontSize)
      : undefined
  if (dshState.status === 'ready' && field?.type === 'number') {
    return (
      <FontSizeSettingControl
        key={`${hostFontSize ?? DEFAULT_CONVERSATION_FONT_SIZE_PX}:${error ?? ''}:${savingPath === DSH_UI_SETTING_PATHS.fontSize ? 'saving' : 'idle'}`}
        value={hostFontSize ?? DEFAULT_CONVERSATION_FONT_SIZE_PX}
        disabled={!dshState.snapshot.schema.writable || savingPath !== undefined || !snapshotFresh}
        saving={savingPath === DSH_UI_SETTING_PATHS.fontSize}
        error={error}
        onCommit={onHostChange}
        translate={t}
      />
    )
  }
  return (
    <div className="dsh-settings__segment" role="group" aria-label={t('settings.conversationFontSize')}>
      {CONVERSATION_FONT_SIZE_OPTIONS.map((size) => (
        <button
          key={size}
          className={`dsh-settings__segment-item${
            size === localFontSize ? ' dsh-settings__segment-item--active' : ''
          }`}
          type="button"
          aria-pressed={size === localFontSize}
          onClick={() => {
            if (size !== localFontSize) onLocalChange(size)
          }}
        >
          {t(`settings.value.${size}`)}
        </button>
      ))}
    </div>
  )
}

interface FontSizeSettingControlProps {
  readonly value: number
  readonly disabled: boolean
  readonly saving: boolean
  readonly error: string | undefined
  readonly onCommit: (value: number) => void
  readonly translate: Translate
}

function FontSizeSettingControl(props: FontSizeSettingControlProps): ReactElement {
  const [draft, setDraft] = useState(String(props.value))

  const commit = (): void => {
    const value = Number(draft)
    if (isConversationFontSizePx(value)) {
      if (value !== props.value) props.onCommit(value)
      return
    }
    setDraft(String(props.value))
  }

  return (
    <div className="dsh-settings__number-control">
      <input
        className="dsh-settings__number-input"
        type="number"
        min={MIN_CONVERSATION_FONT_SIZE_PX}
        max={MAX_CONVERSATION_FONT_SIZE_PX}
        step={1}
        aria-label={props.translate('settings.conversationFontSize')}
        aria-busy={props.saving}
        disabled={props.disabled}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
      />
      <span>{props.translate('settings.pixels')}</span>
    </div>
  )
}

interface GeneralSettingRowProps {
  readonly row: {
    readonly path: string
    readonly label: string
    readonly hint: string
    readonly defaultValue?: string
  }
  readonly fields: readonly DshSettingsSchema['fields'][number][]
  readonly values: Readonly<Record<string, unknown>>
  readonly writable: boolean
  readonly selectedValue?: string | undefined
  readonly saving: boolean
  readonly disabled: boolean
  readonly riskPending: RiskPending | undefined
  readonly riskAcknowledged: boolean
  readonly onPick: (value: string) => void
  readonly onConfirmRisk: () => void
  readonly onRiskAcknowledgedChange: (acknowledged: boolean) => void
  readonly onCancelRisk: () => void
}

/** One official General row: renders only when the host schema advertises the
 * field, and only as a segmented enum picker (the upstream General section is
 * exclusively enum-valued rows). */
type GeneralSettingRowDefinition = (typeof GENERAL_SETTING_ROWS)[number]

/** Mirror of `GeneralSettingRow`'s own render guard: a row is visible when the
 * host schema advertises its field as a non-empty enum, minus the read-only
 * transcript rows the component suppresses. Keeping the predicate beside the
 * component lets the section state when it has nothing to show at all. */
function isGeneralRowVisible(snapshot: DshSettingsSnapshot, row: GeneralSettingRowDefinition): boolean {
  const field = snapshot.schema.fields.find((entry) => entry.path === row.path)
  if (field?.type !== 'enum' || (field.enumValues?.length ?? 0) === 0) return false
  return !(
    !snapshot.schema.writable &&
    (row.path === DSH_UI_SETTING_PATHS.transcriptView || row.path === DSH_UI_SETTING_PATHS.performanceUsage)
  )
}

export function visibleGeneralRows(snapshot: DshSettingsSnapshot): readonly GeneralSettingRowDefinition[] {
  return GENERAL_SETTING_ROWS.filter((row) => isGeneralRowVisible(snapshot, row))
}

/** Whether this card has any content beyond its title for this host schema. */
export function hasPreferencesContent(snapshot: DshSettingsSnapshot): boolean {
  return (
    GENERAL_SETTING_ROWS.some((row) => isGeneralRowVisible(snapshot, row)) ||
    findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.codingTools)?.type === 'boolean'
  )
}

export function GeneralSettingRow(props: GeneralSettingRowProps): ReactElement | null {
  const { t } = useI18n()
  const field = props.fields.find((entry) => entry.path === props.row.path)
  if (
    !props.writable &&
    (props.row.path === DSH_UI_SETTING_PATHS.transcriptView ||
      props.row.path === DSH_UI_SETTING_PATHS.performanceUsage)
  )
    return null
  const options = field?.enumValues?.filter((option) => {
    if (props.row.path === DSH_UI_SETTING_PATHS.transcriptView) return isTranscriptViewMode(option)
    if (props.row.path === DSH_UI_SETTING_PATHS.performanceUsage) return isPerformanceUsageMode(option)
    return true
  })
  if (field?.type !== 'enum' || options === undefined || options.length === 0) return null
  const savedValue = settingValueAt(props.values, props.row.path)
  const normalizedSavedValue =
    props.row.path === DSH_UI_SETTING_PATHS.transcriptView
      ? savedValue === 'normal'
        ? 'standard'
        : savedValue === 'expanded'
          ? 'detailed'
          : savedValue
      : savedValue
  const candidate = props.selectedValue ?? normalizedSavedValue ?? props.row.defaultValue
  const currentLabel =
    typeof candidate === 'string' && options.includes(candidate)
      ? candidate
      : props.row.defaultValue !== undefined && options.includes(props.row.defaultValue)
        ? props.row.defaultValue
        : options[0]
  return (
    <SettingRow
      as="li"
      title={props.row.label}
      description={props.row.hint}
      status={
        <>
          {field.restartRequired ? (
            <span className="dsh-setting-row__status-note" title={t('settings.restartTitle')}>
              {t('settings.restart')}
            </span>
          ) : null}
          {props.saving ? (
            <span className="dsh-setting-row__status-saving" role="status">
              {t('settings.saving')}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="dsh-settings__segment" role="group" aria-label={props.row.label}>
          {options.map((option) => (
            <button
              key={option}
              className={`dsh-settings__segment-item${
                option === currentLabel ? ' dsh-settings__segment-item--active' : ''
              }`}
              type="button"
              aria-pressed={option === currentLabel}
              disabled={props.disabled}
              // The pressed segment already names the stored value: keep it in
              // the tab order and readable as "selected", with a no-op click.
              onClick={() => {
                if (option !== currentLabel) props.onPick(option)
              }}
            >
              {formatSettingValue(option, t)}
            </button>
          ))}
        </div>
      }
      footer={
        props.riskPending === undefined ? undefined : (
          <div className="dsh-settings__risk" role="alertdialog" aria-label={t('settings.fullAccessAria')}>
            <span>{t('settings.fullAccessPrompt')}</span>
            <label>
              <input
                type="checkbox"
                checked={props.riskAcknowledged}
                disabled={props.disabled}
                onChange={(event) => props.onRiskAcknowledgedChange(event.currentTarget.checked)}
              />
              {t('settings.fullAccessAck')}
            </label>
            <div className="dsh-settings__risk-actions">
              <button
                className="dsh-button dsh-button--danger dsh-button--compact"
                type="button"
                disabled={props.disabled || !props.riskAcknowledged}
                onClick={props.onConfirmRisk}
              >
                {t('settings.fullAccessConfirm')}
              </button>
              <button
                className="dsh-button dsh-button--secondary dsh-button--compact"
                type="button"
                disabled={props.disabled}
                onClick={props.onCancelRisk}
              >
                {t('settings.cancel')}
              </button>
            </div>
          </div>
        )
      }
    />
  )
}
