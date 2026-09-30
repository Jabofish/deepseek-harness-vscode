import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'file:///extension/media' }) },
  env: { language: 'en' },
}))

import { deliverOrRevealView } from './deliver-or-reveal.js'
import { DshWebviewViewProvider } from './dsh-webview-view-provider.js'

describe('deliverOrRevealView', () => {
  it('delivers a title-bar action posted before the Webview was ever rendered', async () => {
    // The provider resolves `false` while no WebviewView exists, which is the
    // state of a collapsed view a title-bar button can still be clicked from.
    const delivered = [false, true]
    const post = (): Promise<boolean> => Promise.resolve(delivered.shift() ?? false)
    const executeCommand = (command: string): Promise<unknown> => {
      commands.push(command)
      return Promise.resolve(undefined)
    }
    const commands: string[] = []
    let settled = 0

    const result = await deliverOrRevealView(
      {
        post,
        executeCommand,
        settle: () => {
          settled += 1
          return Promise.resolve()
        },
      },
      'ui.sessions.toggle',
      {},
    )

    expect(result).toBe(true)
    expect(commands).toEqual(['workbench.view.extension.dsh-container'])
    // The retry must wait for the revealed view to start listening.
    expect(settled).toBe(1)
  })

  it('reveals the view exactly when a real provider has no WebviewView yet', async () => {
    // This is the actual pre-click state: VS Code never called
    // `resolveWebviewView`, so the provider drops the message. Without the
    // fallback the command was a silent no-op.
    const provider = new DshWebviewViewProvider({
      extensionUri: { fsPath: '/extension' } as never,
      onMessage: () => Promise.resolve(undefined),
    })
    const commands: string[] = []
    let attempts = 0

    const result = await deliverOrRevealView(
      {
        post: () => {
          attempts += 1
          return provider.postMessage({ any: 'message' })
        },
        executeCommand: (command) => {
          commands.push(command)
          return Promise.resolve(undefined)
        },
        settle: () => Promise.resolve(),
      },
      'ui.sessions.toggle',
      {},
    )

    // The stub never resolves a real view, so delivery still fails — but the
    // fallback ran and the caller learns the action did not land instead of
    // swallowing it.
    expect(result).toBe(false)
    expect(commands).toEqual(['workbench.view.extension.dsh-container'])
    expect(attempts).toBe(2)

    provider.dispose()
  })

  it('does not reveal the view when the Webview already accepted the message', async () => {
    const commands: string[] = []
    let settled = 0

    const result = await deliverOrRevealView(
      {
        post: () => Promise.resolve(true),
        executeCommand: (command) => {
          commands.push(command)
          return Promise.resolve(undefined)
        },
        settle: () => {
          settled += 1
          return Promise.resolve()
        },
      },
      'ui.sessions.toggle',
      {},
    )

    expect(result).toBe(true)
    expect(commands).toEqual([])
    expect(settled).toBe(0)
  })

  it('reports failure when the message is still undeliverable after revealing', async () => {
    const result = await deliverOrRevealView(
      {
        post: () => Promise.resolve(false),
        executeCommand: () => Promise.resolve(undefined),
        settle: () => Promise.resolve(),
      },
      'ui.sessions.toggle',
      {},
    )

    expect(result).toBe(false)
  })
})
