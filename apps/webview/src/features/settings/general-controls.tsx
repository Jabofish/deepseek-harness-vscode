import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import type { DshSettingsSchema } from '@dsh-vscode/domain'
import type { DshSettingsSnapshot } from '../../app/store.js'
import {
  CONVERSATION_FONT_SIZE_OPTIONS,
  DEFAULT_CONVERSATION_FONT_SIZE_PX,
  DSH_UI_SETTING_PATHS,
  MAX_CONVERSATION_FONT_SIZE_PX,
  MIN_CONVERSATION_FONT_SIZE_PX,
  PERMISSION_DEFAULT_SETTING_PATH,
  findDshSettingsField,
  isConversationFontSizePx,
  isLegacyTranscriptViewValue,
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

/** Host facts a General row needs beyond the settings schema. */
export interface GeneralRowContext {
  readonly permissionDefaultOptions?: readonly string[] | undefined
}

/** Choices a General row offers for this schema, or undefined when it has none. */
export function generalRowOptions(
  field: DshSettingsSchema['fields'][number] | undefined,
  path: string,
  context?: GeneralRowContext,
): readonly string[] | undefined {
  if (field === undefined) return undefined
  if (path === PERMISSION_DEFAULT_SETTING_PATH && field.type === 'string') {
    const options = context?.permissionDefaultOptions
    return options === undefined || options.length === 0 ? undefined : options
  }
  if (field.type !== 'enum') return undefined
  const options = field.enumValues?.filter((option) => {
    if (path === DSH_UI_SETTING_PATHS.transcriptView) return isTranscriptViewMode(option)
    if (path === DSH_UI_SETTING_PATHS.performanceUsage) return isPerformanceUsageMode(option)
    return true
  })
  return options === undefined || options.length === 0 ? undefined : options
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
    path: PERMISSION_DEFAULT_SETTING_PATH,
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
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(String(props.value))
  const previousValueRef = useRef(props.value)
  const wasSavingRef = useRef(props.saving)
  const valueUpdatedDuringSaveRef = useRef(false)
  const lastErrorRef = useRef(props.error)

  useLayoutEffect(() => {
    const previousValue = previousValueRef.current
    const valueChanged = previousValue !== props.value
    const saveStarted = !wasSavingRef.current && props.saving
    const saveFinished = wasSavingRef.current && !props.saving
    if (saveStarted) {
      valueUpdatedDuringSaveRef.current = valueChanged
    } else if (props.saving && valueChanged) {
      valueUpdatedDuringSaveRef.current = true
    } else if (saveFinished && valueChanged) {
      valueUpdatedDuringSaveRef.current = true
    }
    const failedSave = props.error !== undefined && (props.error !== lastErrorRef.current || saveFinished)
    const finishedWithoutValueUpdate = saveFinished && !valueUpdatedDuringSaveRef.current
    if (failedSave || finishedWithoutValueUpdate) {
      setDraft(String(props.value))
    } else if (valueChanged) {
      setDraft((current) =>
        document.activeElement !== inputRef.current || current === String(previousValue)
          ? String(props.value)
          : current,
      )
    }
    previousValueRef.current = props.value
    wasSavingRef.current = props.saving
    lastErrorRef.current = props.error
    if (!props.saving) valueUpdatedDuringSaveRef.current = false
  }, [props.error, props.saving, props.value])

  const commit = (): void => {
    const value = Number(draft)
    if (isConversationFontSizePx(value)) {
      if (value !== props.value) props.onCommit(value)
      else setDraft(String(props.value))
      return
    }
    setDraft(String(props.value))
  }

  return (
    <div className="dsh-settings__number-control">
      <input
        ref={inputRef}
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
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') setDraft(String(props.value))
        }}
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
  readonly context?: GeneralRowContext | undefined
}

/** One official General row: renders only when the host schema advertises the
 * field, and only as a segmented enum picker (the upstream General section is
 * exclusively enum-valued rows). */
type GeneralSettingRowDefinition = (typeof GENERAL_SETTING_ROWS)[number]

/** Mirror of `GeneralSettingRow`'s own render guard: a row is visible when the
 * host schema advertises its field as a non-empty enum, minus the read-only
 * transcript rows the component suppresses. Keeping the predicate beside the
 * component lets the section state when it has nothing to show at all. */
function isGeneralRowVisible(
  snapshot: DshSettingsSnapshot,
  row: GeneralSettingRowDefinition,
  context?: GeneralRowContext,
): boolean {
  const field = snapshot.schema.fields.find((entry) => entry.path === row.path)
  if (generalRowOptions(field, row.path, context) === undefined) return false
  return !(
    !snapshot.schema.writable &&
    (row.path === DSH_UI_SETTING_PATHS.transcriptView || row.path === DSH_UI_SETTING_PATHS.performanceUsage)
  )
}

export function visibleGeneralRows(
  snapshot: DshSettingsSnapshot,
  context?: GeneralRowContext,
): readonly GeneralSettingRowDefinition[] {
  return GENERAL_SETTING_ROWS.filter((row) => isGeneralRowVisible(snapshot, row, context))
}

/** Whether this card has any content beyond its title for this host schema. */
export function hasPreferencesContent(snapshot: DshSettingsSnapshot, context?: GeneralRowContext): boolean {
  return (
    GENERAL_SETTING_ROWS.some((row) => isGeneralRowVisible(snapshot, row, context)) ||
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
  const options = generalRowOptions(field, props.row.path, props.context)
  if (field === undefined || options === undefined) return null
  const savedValue = settingValueAt(props.values, props.row.path)
  const normalizedSavedValue =
    props.row.path === DSH_UI_SETTING_PATHS.transcriptView
      ? isLegacyTranscriptViewValue(savedValue)
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
