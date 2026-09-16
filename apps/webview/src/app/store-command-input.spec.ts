// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'session-command'

class StreamClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    return Promise.resolve(this.response(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
  }

  private response(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open':
        return {
          id: SESSION_ID,
          workspaceId: 'workspace-command',
          title: 'Command fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
          history: [],
          permissionPresets: ['workspace-write'],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        }
      case 'models.session.list':
        return { models: [], failures: [] }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }
}

function settle(milliseconds = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function commandInputOf(store: ReturnType<typeof createAppStore>): string | undefined {
  const node = store.timeline.nodes.find((entry) => entry.kind === 'command-input')
  return node?.kind === 'command-input' ? node.text : undefined
}

describe('AppStore command input rows', () => {
  it('keeps a slash-command line longer than 4096 characters', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The host records `command/run.args` verbatim (`parseCommand` slices the
    // rest of the submitted line) and bounds it nowhere, so the transcript row
    // is the only record of what ran. Clipping it here drops the tail with no
    // fold, notice, or copy surface that could reveal the loss.
    // The host records `args` with its leading separator space, so the row the
    // adapter projects is `/goal` plus that raw remainder.
    const args = ` ${'a long goal description '.repeat(240)}`.trimEnd()
    const commandInput = `/goal${args}`
    expect(commandInput.length).toBeGreaterThan(4_096)
    client.emit({
      type: 'event',
      name: 'notice',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        level: 'info',
        text: 'goal started.',
        commandName: 'goal',
        commandId: 'command-long',
        commandPhase: 'run',
        commandInput,
      },
    })
    await settle()

    expect(commandInputOf(store)).toBe(commandInput)
    store.dispose()
  })
})
