// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'
import { Timeline } from '../features/chat/Timeline.js'

class StreamClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
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
          id: 'session-stream',
          workspaceId: 'workspace-stream',
          title: 'Stream fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
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
        return { models: [] }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }
}

function event(sequence: number, name: string, payload: unknown): HostMessage {
  return { type: 'event', name, sequence, payload }
}

describe('Store to Timeline streamed rendering', () => {
  afterEach(() => cleanup())

  it('keeps reasoning, tool input/output, and assistant text visible without a task switch', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    const timeline = (): ReactElement => (
      <Timeline
        sessionId="session-stream"
        nodes={store.timeline.nodes}
        {...(store.timeline.nodeChangeStart === undefined
          ? {}
          : { nodeChangeStart: store.timeline.nodeChangeStart })}
        {...(store.timeline.nodeChangeBase === undefined
          ? {}
          : { nodeChangeBase: store.timeline.nodeChangeBase })}
        streaming={false}
        running
      />
    )
    const view = render(timeline())
    const renderCurrentState = (): void => view.rerender(timeline())
    const unsubscribe = store.subscribe(renderCurrentState)
    const push = async (message: HostMessage): Promise<void> => {
      client.emit(message)
      await new Promise((resolve) => window.setTimeout(resolve, 24))
    }

    await push(
      event(1, 'message.user', {
        sessionId: 'session-stream',
        messageId: 'user-1',
        markdown: 'search the docs',
        source: 'user',
      }),
    )
    await push(event(2, 'turn.started', { sessionId: 'session-stream', turn: 1 }))
    await push(event(3, 'step.started', { sessionId: 'session-stream', turn: 1, step: 1 }))
    await push(
      event(4, 'reasoning.delta', {
        sessionId: 'session-stream',
        messageId: 'assistant-1',
        turn: 1,
        step: 1,
        delta: 'I am checking the documentation first.',
      }),
    )
    expect(view.container.querySelector('[data-reasoning-id]')?.textContent).toContain('I am checking')
    expect(view.container.querySelector('.dsh-timeline__row--enter')).toBeNull()

    await push(
      event(5, 'tool.updated', {
        sessionId: 'session-stream',
        tool: {
          id: 'tool-1',
          name: 'shell',
          category: 'execution',
          title: 'Shell',
          status: 'running',
          turn: 1,
          step: 1,
          inputSummary: JSON.stringify({ command: 'echo stream-ok' }),
          metadata: {},
        },
      }),
    )
    expect(view.container.querySelector('.dsh-tool-card')).not.toBeNull()

    await push(
      event(6, 'tool.updated', {
        sessionId: 'session-stream',
        tool: {
          id: 'tool-1',
          name: 'shell',
          category: 'execution',
          title: 'Shell',
          status: 'completed',
          turn: 1,
          step: 1,
          inputSummary: JSON.stringify({ command: 'echo stream-ok' }),
          outputSummary: 'stream-ok',
          metadata: {},
        },
      }),
    )
    const toolSummary = view.container.querySelector<HTMLButtonElement>('.dsh-tool-card__summary')
    expect(toolSummary).not.toBeNull()
    fireEvent.click(toolSummary!)
    expect(view.container.querySelector('.dsh-tool-card__details')?.textContent).toContain('stream-ok')

    await push(
      event(7, 'message.delta', {
        sessionId: 'session-stream',
        messageId: 'assistant-1',
        turn: 1,
        step: 1,
        delta: 'The documentation is available.',
      }),
    )
    expect(view.container.textContent).toContain('The documentation is available.')

    await push(
      event(8, 'message.completed', {
        sessionId: 'session-stream',
        messageId: 'assistant-1',
        turn: 1,
        step: 1,
        markdown: 'The documentation is available.',
      }),
    )
    await push(event(9, 'step.ended', { sessionId: 'session-stream', turn: 1, step: 1 }))
    await push(event(10, 'turn.ended', { sessionId: 'session-stream', turn: 1, reason: 'completed' }))

    expect(store.timeline.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'assistant-message', id: 'assistant-1' }),
        expect.objectContaining({ kind: 'tool', id: 'tool-1' }),
      ]),
    )
    expect(view.container.querySelector('[data-reasoning-id]')).not.toBeNull()
    expect(view.container.textContent).toContain('The documentation is available.')
    expect(view.container.querySelector('.dsh-timeline__row--enter')).toBeNull()

    unsubscribe()
    store.dispose()
  })
})
