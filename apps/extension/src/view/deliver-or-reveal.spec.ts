import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'file:///extension/media' }) },
  env: { language: 'en' },
}))

import { deliverOrRevealView } from './deliver-or-reveal.js'
import { DshWebviewViewProvider } from './dsh-webview-view-provider.js'

describe('deliverOrRevealView', () => {
  it('releases readiness waiters on timeout and provider disposal', async () => {
    vi.useFakeTimers()
    const provider = new DshWebviewViewProvider({
      extensionUri: { toString: () => 'extension-root' } as never,
      onMessage: () => Promise.resolve(),
    })
    try {
      const expired = provider.waitUntilReady(20)
      await vi.advanceTimersByTimeAsync(20)
      await expect(expired).resolves.toBe(false)
      const disposed = provider.waitUntilReady()
      provider.dispose()
      await expect(disposed).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      provider.dispose()
      vi.useRealTimers()
    }
  })

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
      onDidDispose: () => ({ dispose: () => undefined }),
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
        settle: () => Promise.resolve(true),
      },
      'ui.sessions.toggle',
      {},
    )

    // The stub never resolves a real view, so delivery still fails — but the
    // fallback ran and the caller learns the action did not land instead of
    // swallowing it.
    expect(result).toBe(false)
    expect(commands).toEqual(['dsh.chatView.focus'])
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
          return Promise.resolve(true)
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
        settle: () => Promise.resolve(true),
      },
      'ui.sessions.toggle',
      {},
    )

    expect(result).toBe(false)
  })

  it('does not retry delivery after the client fails to become ready', async () => {
    const post = vi.fn().mockResolvedValue(false)
    await expect(
      deliverOrRevealView(
        {
          post,
          executeCommand: () => Promise.resolve(),
          settle: () => Promise.resolve(false),
        },
        'ui.sessions.toggle',
        {},
      ),
    ).resolves.toBe(false)
    expect(post).toHaveBeenCalledOnce()
  })
})
