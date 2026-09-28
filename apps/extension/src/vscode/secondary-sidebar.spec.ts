import { describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { moveOrExplainSecondarySidebar } from './secondary-sidebar.js'

function harness(
  availableCommands: readonly string[],
  moveError?: Error,
): {
  commands: typeof vscode.commands
  window: typeof vscode.window
  executeCommand: ReturnType<typeof vi.fn>
  showInformationMessage: ReturnType<typeof vi.fn>
} {
  const executeCommand = vi.fn(() =>
    moveError === undefined ? Promise.resolve() : Promise.reject(moveError),
  )
  const showInformationMessage = vi.fn(() => Promise.resolve(undefined))
  const commands = {
    getCommands: vi.fn(() => Promise.resolve([...availableCommands])),
    executeCommand,
  } as unknown as typeof vscode.commands
  const window = { showInformationMessage } as unknown as typeof vscode.window
  return { commands, window, executeCommand, showInformationMessage }
}

describe('moving the Chat view to the secondary sidebar', () => {
  it('opens the workbench move picker without toggling the sidebar', async () => {
    const ui = harness(['workbench.action.moveView', 'workbench.action.toggleAuxiliaryBar'])

    await moveOrExplainSecondarySidebar(ui.commands, ui.window)

    expect(ui.executeCommand).toHaveBeenCalledExactlyOnceWith('workbench.action.moveView')
    expect(ui.showInformationMessage).not.toHaveBeenCalled()
  })

  it.each([{ availableCommands: [] }, { availableCommands: ['workbench.action.moveView'] }])(
    'explains the manual route when the picker is absent or fails',
    async ({ availableCommands }) => {
      const ui = harness(availableCommands, new Error('move failed'))

      await moveOrExplainSecondarySidebar(ui.commands, ui.window)

      expect(ui.showInformationMessage).toHaveBeenCalledWith(
        'Right-click the DeepSeek Harness Chat view title, choose Move View, then a new Secondary Side Bar entry.',
      )
    },
  )
})
