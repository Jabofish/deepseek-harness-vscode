/** What "Open Chat in Editor" does in the current window. */
export type OpenChatInEditorAction = 'move-sidebar-session' | 'reveal-editor-tab' | 'ask-sidebar'

/**
 * A visible sidebar that shows a conversation moves that conversation into an
 * editor tab. Otherwise an existing editor chat tab is revealed, and only when
 * there is none does the sidebar get the request (it explains what to select).
 */
export function openChatInEditorAction(window: {
  readonly sidebarVisible: boolean
  readonly sidebarSessionId: string | undefined
  readonly hasEditorTab: boolean
}): OpenChatInEditorAction {
  if (window.sidebarVisible && window.sidebarSessionId !== undefined) return 'move-sidebar-session'
  return window.hasEditorTab ? 'reveal-editor-tab' : 'ask-sidebar'
}
