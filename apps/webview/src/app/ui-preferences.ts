export type ConversationFontSize = 'small' | 'medium' | 'large'
export type ThemePreference = 'light' | 'dark' | 'system'

export const DEFAULT_CONVERSATION_FONT_SIZE: ConversationFontSize = 'medium'
export const CONVERSATION_FONT_SIZE_STORAGE_KEY = 'dsh-webview-conversation-font-size'
export const CONVERSATION_FONT_SIZE_OPTIONS: readonly ConversationFontSize[] = ['small', 'medium', 'large']
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'
export const THEME_PREFERENCE_STORAGE_KEY = 'dsh-webview-theme'
export const THEME_PREFERENCE_OPTIONS: readonly ThemePreference[] = ['light', 'dark', 'system']

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
