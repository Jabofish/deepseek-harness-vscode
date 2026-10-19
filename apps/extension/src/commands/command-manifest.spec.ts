import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EDITOR_CHAT_VIEW_TYPE } from '../constants.js'
import { COMMANDS } from './register-commands.js'

interface Manifest {
  readonly activationEvents?: readonly string[]
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string }[]
    readonly menus?: Record<
      string,
      readonly { readonly command: string; readonly when?: string; readonly group?: string }[]
    >
  }
}

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Manifest

const declaredCommands = new Set((manifest.contributes?.commands ?? []).map((entry) => entry.command))

describe('command manifest contributions', () => {
  it('keeps internal compatibility commands out of the user command palette', () => {
    const palette = manifest.contributes?.menus?.commandPalette ?? []
    expect(palette.map((item) => item.command).sort()).toEqual([...declaredCommands].sort())
    expect(palette.filter((item) => item.when !== 'false').map((item) => item.command)).toEqual(
      [
        'dsh.newSession',
        'dsh.openSettings',
        'dsh.openChatInEditor',
        'dsh.moveChatToSidebar',
        'dsh.undoEditorEdit',
        'dsh.showDiagnostics',
      ].sort((a, b) => [...declaredCommands].indexOf(a) - [...declaredCommands].indexOf(b)),
    )
    for (const command of [
      'dsh.shareEditorState',
      'dsh.stopSharingEditorState',
      'dsh.installEditorCompanion',
      'dsh.manageEditorCompanion',
    ])
      expect(palette.find((item) => item.command === command)?.when).toBe('false')
  })
  it('declares every registered command in the extension manifest', () => {
    const missing = COMMANDS.filter((command) => !declaredCommands.has(command))
    expect(missing).toEqual([])
  })

  it('activates for the editor chat surface and its commands', () => {
    const activationEvents = new Set(manifest.activationEvents ?? [])
    expect(activationEvents.has(`onWebviewPanel:${EDITOR_CHAT_VIEW_TYPE}`)).toBe(true)
    for (const command of ['dsh.openChatInEditor', 'dsh.moveChatToSidebar'])
      expect(activationEvents.has(`onCommand:${command}`), `missing activation for ${command}`).toBe(true)
  })

  it('offers the move action on the sidebar title and the return action on the editor tab', () => {
    const viewTitle = manifest.contributes?.menus?.['view/title'] ?? []
    expect(
      viewTitle.some(
        ({ command, when }) => command === 'dsh.openChatInEditor' && when?.startsWith('view == dsh.chatView'),
      ),
    ).toBe(true)
    const editorTitle = manifest.contributes?.menus?.['editor/title'] ?? []
    expect(editorTitle).toContainEqual(
      expect.objectContaining({
        command: 'dsh.moveChatToSidebar',
        when: `activeWebviewPanelId == ${EDITOR_CHAT_VIEW_TYPE}`,
      }),
    )
  })

  it('reserves native title-bar space for Sessions and Settings before secondary actions', () => {
    const chatTitle = (manifest.contributes?.menus?.['view/title'] ?? []).filter(({ when }) =>
      when?.includes('view == dsh.chatView'),
    )
    expect(
      chatTitle
        .filter(
          ({ group, when }) => group?.startsWith('navigation') && !when?.includes('dsh.chatTitlebarLayout'),
        )
        .map(({ command }) => command),
    ).toEqual(['dsh.newSession', 'dsh.openSettings'])
    expect(
      chatTitle.filter(({ group }) => !group?.startsWith('navigation')).map(({ command }) => command),
    ).toEqual(
      expect.arrayContaining([
        'dsh.connect',
        'dsh.reconnect',
        'dsh.openWebUi',
        'dsh.openChatInEditor',
        'dsh.openSessionList',
      ]),
    )
    for (const command of ['dsh.connect', 'dsh.reconnect', 'dsh.openWebUi', 'dsh.openChatInEditor']) {
      const entries = chatTitle.filter((entry) => entry.command === command)
      expect(entries).toHaveLength(2)
      expect(entries.find(({ group }) => group?.startsWith('navigation'))?.when).toContain(
        'dsh.chatTitlebarLayout == wide',
      )
      expect(entries.find(({ group }) => !group?.startsWith('navigation'))?.when).toContain(
        'dsh.chatTitlebarLayout != wide',
      )
    }
    const primary = chatTitle.filter(({ group }) => group?.startsWith('navigation'))
    const order = (command: string): number =>
      Number(primary.find((entry) => entry.command === command)?.group?.split('@')[1])
    // Keep the frequent controls at the right edge, next to More, even while
    // the native title is shrinking before its breakpoint update arrives.
    expect(order('dsh.newSession')).toBeGreaterThan(order('dsh.openSettings'))
    for (const command of ['dsh.connect', 'dsh.reconnect', 'dsh.openWebUi', 'dsh.openChatInEditor'])
      expect(order(command)).toBeLessThan(order('dsh.openSettings'))
  })
})
