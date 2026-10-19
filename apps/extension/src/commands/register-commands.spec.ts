import { describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { registerCommands } from './register-commands.js'

describe('registerCommands', () => {
  it('registers native editor context commands and forwards invocation', async () => {
    const registrations: Array<{
      readonly id: string
      readonly handler: (...args: unknown[]) => unknown
    }> = []
    const commands = {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable => {
        registrations.push({ id, handler })
        return { dispose: () => undefined }
      },
    } as unknown as typeof vscode.commands
    const subscriptions: vscode.Disposable[] = []
    const selectionHandler = vi.fn((..._args: readonly unknown[]) => undefined)
    const sessionListHandler = vi.fn(() => undefined)

    registerCommands({
      commands,
      subscriptions: {
        push(...items: vscode.Disposable[]): unknown {
          subscriptions.push(...items)
          return undefined
        },
      },
      handlers: { 'dsh.addSelectionContext': selectionHandler, 'dsh.openSessionList': sessionListHandler },
    })

    expect(registrations.map(({ id }) => id)).toEqual([
      'dsh.authorizeExternalConnection',
      'dsh.clearExternalCredentials',
      'dsh.connect',
      'dsh.reconnect',
      'dsh.newSession',
      'dsh.openSessionList',
      'dsh.openSettings',
      'dsh.openWebUi',
      'dsh.installRuntime',
      'dsh.selectExecutable',
      'dsh.copyInstallCommand',
      'dsh.openDocumentation',
      'dsh.openInSecondarySidebar',
      'dsh.openChatInEditor',
      'dsh.moveChatToSidebar',
      'dsh.showDiagnostics',
      'dsh.addSelectionContext',
      'dsh.addFileContext',
      'dsh.addSymbolContext',
      'dsh.addDiagnosticContext',
      'dsh.shareEditorState',
      'dsh.stopSharingEditorState',
      'dsh.manageEditorCompanion',
      'dsh.installEditorCompanion',
      'dsh.undoEditorEdit',
    ])
    expect(subscriptions).toHaveLength(registrations.length)

    const registeredSelection = registrations.find(({ id }) => id === 'dsh.addSelectionContext')
    expect(registeredSelection).toBeDefined()
    await registeredSelection?.handler('from-editor-menu')
    expect(selectionHandler).toHaveBeenCalledWith('from-editor-menu')
    await registrations.find(({ id }) => id === 'dsh.openSessionList')?.handler()
    expect(sessionListHandler).toHaveBeenCalledOnce()
  })
})
