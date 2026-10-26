import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'file:///extension/media' }) },
  env: { language: 'en' },
}))

import { deliverOrRevealView } from './deliver-or-reveal.js'
import { DshWebviewViewProvider } from './dsh-webview-view-provider.js'

describe('deliverOrRevealView', () => {
  it('does not claim delivery before the resolved Webview sends a valid ready handshake', async () => {
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn().mockResolvedValue(true)
    const provider = new DshWebviewViewProvider({
      extensionUri: { toString: () => 'extension-root' } as never,
      onMessage: () => Promise.resolve(),
    })
    provider.resolveWebviewView({
      webview: {
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: unknown) => uri,
        postMessage,
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receive = listener
          return { dispose: () => undefined }
        },
      },
      visible: true,
      onDidDispose: () => ({ dispose: () => undefined }),
      onDidChangeVisibility: () => ({ dispose: () => undefined }),
    } as never)
    expect(await provider.postMessage({ action: 'toggle' })).toBe(false)
    receive?.({ message: { type: 'app.ready' } })
    await Promise.resolve()
    expect(await provider.postMessage({ action: 'toggle' })).toBe(false)
    receive?.({ protocolVersion: 1, message: { type: 'app.ready', requestId: 'ready-1' } })
    await Promise.resolve()
    expect(await provider.postMessage({ action: 'toggle' })).toBe(true)
    expect(postMessage).toHaveBeenCalledOnce()
    provider.dispose()
  })

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
          return Promise.resolve(true)
        },
      },
      'ui.sessions.toggle',
      {},
    )

    expect(result).toBe(true)
    expect(commands).toEqual(['dsh.chatView.focus'])
    // The retry must wait for the revealed view to start listening.
    expect(settled).toBe(1)
  })

  it('reports failure when the message is still undeliverable after revealing', async () => {
    const result = await deliverOrRevealView(
      {
        post: () => Promise.resolve(false),
        executeCommand: () => Promise.resolve(undefined),
        settle: () => Promise.resolve(true),
      },
      'ui.sessions.toggle',
      {},
    )

    expect(result).toBe(false)
  })
})
