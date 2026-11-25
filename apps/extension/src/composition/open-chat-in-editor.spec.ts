import { describe, expect, it } from 'vitest'
import { openChatInEditorAction } from './open-chat-in-editor.js'

describe('openChatInEditorAction', () => {
  it('moves the conversation a visible sidebar shows', () => {
    expect(openChatInEditorAction({ sidebarVisible: true, sidebarSessionId: 's1', hasEditorTab: true })).toBe(
      'move-sidebar-session',
    )
  })

  it('reveals an existing editor tab when the sidebar shows no conversation or is hidden', () => {
    expect(
      openChatInEditorAction({ sidebarVisible: true, sidebarSessionId: undefined, hasEditorTab: true }),
    ).toBe('reveal-editor-tab')
    expect(
      openChatInEditorAction({ sidebarVisible: false, sidebarSessionId: 's1', hasEditorTab: true }),
    ).toBe('reveal-editor-tab')
  })

  it('asks the sidebar only when there is no editor tab to reveal', () => {
    expect(
      openChatInEditorAction({ sidebarVisible: true, sidebarSessionId: undefined, hasEditorTab: false }),
    ).toBe('ask-sidebar')
  })
})
