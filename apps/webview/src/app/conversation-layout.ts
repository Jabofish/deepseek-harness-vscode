export type ConversationLayout = 'focused' | 'classic'
export const CONVERSATION_LAYOUT_STORAGE_KEY = 'dsh-webview-conversation-layout'
export const DEFAULT_CONVERSATION_LAYOUT: ConversationLayout = 'focused'
type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

export function isConversationLayout(value: unknown): value is ConversationLayout {
  return value === 'focused' || value === 'classic'
}

function browserStorage(): LayoutStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function readConversationLayout(storage = browserStorage()): ConversationLayout {
  try {
    const value = storage?.getItem(CONVERSATION_LAYOUT_STORAGE_KEY)
    return isConversationLayout(value) ? value : DEFAULT_CONVERSATION_LAYOUT
  } catch {
    return DEFAULT_CONVERSATION_LAYOUT
  }
}

export function rememberConversationLayout(value: ConversationLayout, storage = browserStorage()): void {
  try {
    storage?.setItem(CONVERSATION_LAYOUT_STORAGE_KEY, value)
  } catch {
    // Restricted browser storage must not prevent a live layout change.
  }
}
