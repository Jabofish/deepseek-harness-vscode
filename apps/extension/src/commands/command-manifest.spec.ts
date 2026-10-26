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
})
