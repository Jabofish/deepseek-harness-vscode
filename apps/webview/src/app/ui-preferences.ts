import type { DshSettingsSnapshot } from './store.js'

export type ConversationFontSize = 'small' | 'medium' | 'large'
export type ThemePreference = 'light' | 'dark' | 'system'
export type TranscriptViewMode = 'compact' | 'standard' | 'detailed' | 'verbose'
export type PerformanceUsageMode = 'compact' | 'detailed'
export type BusyEnterBehavior = 'queue' | 'steer'

export const DEFAULT_CONVERSATION_FONT_SIZE: ConversationFontSize = 'medium'
export const CONVERSATION_FONT_SIZE_STORAGE_KEY = 'dsh-webview-conversation-font-size'
export const CONVERSATION_FONT_SIZE_OPTIONS: readonly ConversationFontSize[] = ['small', 'medium', 'large']
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'
export const THEME_PREFERENCE_STORAGE_KEY = 'dsh-webview-theme'
export const THEME_PREFERENCE_OPTIONS: readonly ThemePreference[] = ['light', 'dark', 'system']
export const DEFAULT_TRANSCRIPT_VIEW: TranscriptViewMode = 'standard'
export const TRANSCRIPT_VIEW_OPTIONS: readonly TranscriptViewMode[] = [
  'compact',
  'standard',
  'detailed',
  'verbose',
]
export const DEFAULT_PERFORMANCE_USAGE: PerformanceUsageMode = 'detailed'
export const PERFORMANCE_USAGE_OPTIONS: readonly PerformanceUsageMode[] = ['compact', 'detailed']
export const DEFAULT_CONVERSATION_FONT_SIZE_PX = 14
export const MIN_CONVERSATION_FONT_SIZE_PX = 12
export const MAX_CONVERSATION_FONT_SIZE_PX = 17

export const DSH_UI_SETTING_PATHS = {
  theme: 'ui-theme.preference',
  fontSize: 'ui-theme.fontSize',
  transcriptView: 'ui-chat.transcriptView',
  performanceUsage: 'ui-chat.performanceUsage',
  busyEnter: 'ui-conversation.busyEnter',
  codingTools: 'ui-settings.enabled',
} as const

export interface DshUiPreferences {
  /** Undefined means this Host does not advertise the field. */
  readonly theme: ThemePreference | undefined
  readonly fontSize: number | undefined
  readonly transcriptView: TranscriptViewMode | undefined
  readonly performanceUsage: PerformanceUsageMode | undefined
  readonly busyEnter: BusyEnterBehavior | undefined
  /** Undefined means unsupported or not yet described, not disabled. */
  readonly codingToolsEnabled: boolean | undefined
}

export function isTranscriptViewMode(value: unknown): value is TranscriptViewMode {
  return TRANSCRIPT_VIEW_OPTIONS.some((option) => option === value)
}

export function isPerformanceUsageMode(value: unknown): value is PerformanceUsageMode {
  return PERFORMANCE_USAGE_OPTIONS.some((option) => option === value)
}

export function isConversationFontSizePx(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_CONVERSATION_FONT_SIZE_PX &&
    value <= MAX_CONVERSATION_FONT_SIZE_PX
  )
}

export function findDshSettingsField(
  snapshot: DshSettingsSnapshot,
  path: string,
): DshSettingsSnapshot['schema']['fields'][number] | undefined {
  return snapshot.schema.fields.find((field) => field.path === path)
}

export function isDshSettingWritable(snapshot: DshSettingsSnapshot, path: string, type?: string): boolean {
  const field = findDshSettingsField(snapshot, path)
  return snapshot.schema.writable && field !== undefined && (type === undefined || field.type === type)
}

/** Apply a setting value only after its successful Host update. */
export function withDshSettingValue(
  snapshot: DshSettingsSnapshot,
  path: string,
  value: unknown,
): DshSettingsSnapshot | undefined {
  if (!isDshSettingWritable(snapshot, path)) return undefined
  if (Object.prototype.hasOwnProperty.call(snapshot.values, path)) {
    return { ...snapshot, values: { ...snapshot.values, [path]: value } }
  }
  const parts = path.split('.').filter((part) => part !== '')
  if (parts.length === 0) return undefined
  const write = (record: Readonly<Record<string, unknown>>, index: number): Record<string, unknown> => {
    const key = parts[index]
    if (key === undefined) return { ...record }
    if (index === parts.length - 1) return { ...record, [key]: value }
    const child = record[key]
    const childRecord =
      typeof child === 'object' && child !== null && !Array.isArray(child)
        ? (child as Readonly<Record<string, unknown>>)
        : {}
    return { ...record, [key]: write(childRecord, index + 1) }
  }
  return { ...snapshot, values: write(snapshot.values, 0) }
}

/** Read UI settings only when the connected Host's schema advertises each field. */
export function dshUiPreferences(snapshot: DshSettingsSnapshot): DshUiPreferences {
  const themeField = findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.theme)
  const fontSizeField = findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.fontSize)
  const transcriptField = findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.transcriptView)
  const usageField = findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.performanceUsage)
  const busyEnterField = findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.busyEnter)
  const codingToolsField = findDshSettingsField(snapshot, DSH_UI_SETTING_PATHS.codingTools)

  const themeValue = readDshSettingValue(snapshot.values, DSH_UI_SETTING_PATHS.theme)
  const fontSizeValue = readDshSettingValue(snapshot.values, DSH_UI_SETTING_PATHS.fontSize)
  const transcriptValue = readDshSettingValue(snapshot.values, DSH_UI_SETTING_PATHS.transcriptView)
  const usageValue = readDshSettingValue(snapshot.values, DSH_UI_SETTING_PATHS.performanceUsage)
  const busyEnterValue = readDshSettingValue(snapshot.values, DSH_UI_SETTING_PATHS.busyEnter)
  const codingToolsValue = readDshSettingValue(snapshot.values, DSH_UI_SETTING_PATHS.codingTools)

  const theme =
    themeField?.type === 'enum'
      ? isThemePreference(themeValue)
        ? themeValue
        : DEFAULT_THEME_PREFERENCE
      : undefined
  const fontSize =
    fontSizeField?.type === 'number'
      ? isConversationFontSizePx(fontSizeValue)
        ? fontSizeValue
        : DEFAULT_CONVERSATION_FONT_SIZE_PX
      : undefined
  const transcriptView =
    transcriptField?.type === 'enum'
      ? isTranscriptViewMode(transcriptValue)
        ? transcriptValue
        : transcriptValue === 'normal'
          ? 'standard'
          : transcriptValue === 'expanded'
            ? 'detailed'
            : DEFAULT_TRANSCRIPT_VIEW
      : undefined
  const performanceUsage =
    usageField?.type === 'enum'
      ? isPerformanceUsageMode(usageValue)
        ? usageValue
        : DEFAULT_PERFORMANCE_USAGE
      : undefined
  const busyEnter =
    busyEnterField?.type === 'enum'
      ? busyEnterValue === 'queue' || busyEnterValue === 'steer'
        ? busyEnterValue
        : 'queue'
      : undefined
  const codingToolsEnabled =
    codingToolsField?.type === 'boolean'
      ? typeof codingToolsValue === 'boolean'
        ? codingToolsValue
        : undefined
      : undefined

  return { theme, fontSize, transcriptView, performanceUsage, busyEnter, codingToolsEnabled }
}

export function readDshSettingValue(values: Readonly<Record<string, unknown>>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(values, path)) return values[path]
  let current: unknown = values
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function legacyConversationFontSizePx(value: ConversationFontSize): number {
  switch (value) {
    case 'small':
      return MIN_CONVERSATION_FONT_SIZE_PX
    case 'large':
      return MAX_CONVERSATION_FONT_SIZE_PX
    default:
      return DEFAULT_CONVERSATION_FONT_SIZE_PX
  }
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): PreferenceStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function isConversationFontSize(value: string | null | undefined): value is ConversationFontSize {
  return value === 'small' || value === 'medium' || value === 'large'
}

export function readConversationFontSize(
  storage: PreferenceStorage | undefined = browserStorage(),
): ConversationFontSize {
  try {
    const stored = storage?.getItem(CONVERSATION_FONT_SIZE_STORAGE_KEY)
    return isConversationFontSize(stored) ? stored : DEFAULT_CONVERSATION_FONT_SIZE
  } catch {
    return DEFAULT_CONVERSATION_FONT_SIZE
  }
}

export function rememberConversationFontSize(
  value: ConversationFontSize,
  storage: PreferenceStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(CONVERSATION_FONT_SIZE_STORAGE_KEY, value)
  } catch {
    // A restricted Webview storage area should not prevent changing the UI.
  }
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function readThemePreference(
  storage: PreferenceStorage | undefined = browserStorage(),
): ThemePreference {
  try {
    const stored = storage?.getItem(THEME_PREFERENCE_STORAGE_KEY)
    return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE
  } catch {
    return DEFAULT_THEME_PREFERENCE
  }
}

export function rememberThemePreference(
  value: ThemePreference,
  storage: PreferenceStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(THEME_PREFERENCE_STORAGE_KEY, value)
  } catch {
    // A restricted Webview storage area should not prevent changing the UI.
  }
}
