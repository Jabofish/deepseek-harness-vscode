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

  it('does not turn a malformed optional usage bucket into a complete usage object', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'message.completed', {
        sessionId: 'session-stream',
        messageId: 'assistant-invalid-usage',
        markdown: 'answer',
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 'broken' },
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    const node = store.timeline.nodes.find((entry) => entry.id === 'assistant-invalid-usage')
    expect(node).toEqual(expect.objectContaining({ kind: 'assistant-message' }))
    expect(node).not.toHaveProperty('usage')
    store.dispose()
  })

  it('does not silently drop malformed message attachments or images', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'message.user', {
        sessionId: 'session-stream',
        messageId: 'user-invalid-attachment',
        markdown: 'attachment payload',
        attachments: [{ name: 3 }],
      }),
    )
    client.emit(
      event(2, 'message.completed', {
        sessionId: 'session-stream',
        messageId: 'assistant-invalid-image',
        markdown: 'image payload',
        images: [{ attachmentId: 'missing-metadata' }],
      }),
    )
    client.emit(
      event(3, 'message.delta', {
        sessionId: 'session-stream',
        messageId: 'assistant-invalid-sequence',
        sequence: 'not-a-sequence',
        delta: 'should not enter the assistant stream',
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes.find((node) => node.id === 'user-invalid-attachment')).toBeUndefined()
    expect(store.timeline.nodes.find((node) => node.id === 'assistant-invalid-image')).toBeUndefined()
    expect(store.timeline.nodes.find((node) => node.id === 'assistant-invalid-sequence')).toBeUndefined()
    store.dispose()
  })

  it('does not accept empty event identities or an invalid subscription watermark', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'message.user', {
        sessionId: ' ',
        messageId: '',
        markdown: 'must not enter the timeline',
      }),
    )
    client.emit(
      event(2, 'session.projection', {
        sessionId: 'session-stream',
        key: ' ',
        value: 'must not enter the projection cache',
      }),
    )
    client.emit(
      event(3, 'session.subscribed', {
        sessionId: 'session-stream',
        lastSequence: -2,
      }),
    )
    client.emit(
      event(4, 'session.subscribed', {
        sessionId: 'session-stream',
        lastSequence: 0,
        projection: { asOfSequence: 'broken', values: {} },
      }),
    )
    client.emit(
      event(5, 'session.gap', {
        sessionId: '',
        fromSequence: 1,
        toSequence: 2,
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'event', name: 'session.projection' }),
        expect.objectContaining({ kind: 'event', name: 'session.subscribed' }),
      ]),
    )
    expect(store.timeline.nodes.some((node) => node.kind === 'user-message')).toBe(false)
    expect(store.projections['session-stream']).toBeUndefined()
    store.dispose()
  })

  it('does not project a tool update when a core field is malformed', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'tool.updated', {
        sessionId: 'session-stream',
        tool: {
          id: 'tool-invalid-coordinate',
          name: 'shell',
          status: 'running',
          turn: -1,
          metadata: {},
        },
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes.find((node) => node.id === 'tool-invalid-coordinate')).toBeUndefined()
    store.dispose()
  })

  it('does not project command input when a notice lifecycle field is malformed', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'notice', {
        sessionId: 'session-stream',
        level: 'info',
        text: 'permission started.',
        commandInput: '/permission read-only',
        commandPhase: 'finished',
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes.some((node) => node.kind === 'command-input')).toBe(false)
    store.dispose()
  })

  it('renders a valid session notice in the active timeline', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'notice', {
        sessionId: 'session-stream',
        level: 'warning',
        text: 'The session live stream was interrupted; reconnecting.',
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'notice',
        level: 'warning',
        text: 'The session live stream was interrupted; reconnecting.',
      }),
    )
    store.dispose()
  })

  it('preserves the interrupted marker on a completed assistant message', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'message.completed', {
        sessionId: 'session-stream',
        messageId: 'assistant-interrupted',
        markdown: 'partial answer',
        interrupted: true,
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({ id: 'assistant-interrupted', interrupted: true }),
    )
    store.dispose()
  })

  it('marks an abandoned v2 stream interrupted without consuming the durable cursor', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'message.delta', {
        sessionId: 'session-stream',
        messageId: 'assistant:2:1',
        turn: 2,
        step: 1,
        delta: 'partial',
        transientSequence: 1,
        transientAttemptId: 'attempt-abandoned',
        transientIndex: 0,
      }),
    )
    client.emit(
      event(2, 'message.completed', {
        sessionId: 'session-stream',
        messageId: 'assistant:2:1',
        turn: 2,
        step: 1,
        interrupted: true,
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({
        id: 'assistant:2:1',
        markdown: 'partial',
        streaming: false,
        interrupted: true,
      }),
    )
    expect(store.timeline.lastSequence).toBe(-1)
    store.dispose()
  })

  it('does not default malformed retry or compaction metrics', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'model.retry', {
        retry: {
          sessionId: 'session-stream',
          id: 'retry-invalid',
          turn: -1,
          step: 1,
          attempt: 1,
          state: 'started',
        },
      }),
    )
    client.emit(
      event(2, 'compaction.updated', {
        sessionId: 'session-stream',
        compaction: { id: 'compaction-invalid', phase: 'summary', replacedCount: -1 },
      }),
    )
    client.emit(
      event(3, 'model.retry', {
        retry: {
          sessionId: 'session-stream',
          id: 'retry-valid',
          turn: 1,
          step: 1,
          attempt: 1,
          state: 'scheduled',
          delayMs: 0,
          maxRetries: 3,
        },
      }),
    )
    client.emit(
      event(4, 'compaction.updated', {
        sessionId: 'session-stream',
        compaction: { id: 'compaction-valid', phase: 'summary', replacedCount: 0, estimatedTokens: 12 },
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes.find((node) => node.id === 'retry:retry-invalid')).toBeUndefined()
    expect(store.timeline.nodes.find((node) => node.id === 'compaction:compaction-invalid')).toBeUndefined()
    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({
        id: 'retry:retry-valid',
        attempt: 1,
        delayMs: 0,
        maxRetries: 3,
      }),
    )
    expect(store.timeline.nodes).toContainEqual(
      expect.objectContaining({
        id: 'compaction:compaction-valid',
        compaction: { id: 'compaction-valid', phase: 'summary', replacedCount: 0, estimatedTokens: 12 },
      }),
    )
    store.dispose()
  })

  it('projects a durable explicit-delivery event into the timeline', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    client.emit(
      event(1, 'deliverables.presented', {
        sessionId: 'session-stream',
        turn: 1,
        callId: 'call-present',
        files: [{ path: 'artifacts/report.txt', description: 'Generated report' }],
      }),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 24))

    expect(store.timeline.nodes).toContainEqual({
      kind: 'deliverables',
      id: 'deliverables:call-present',
      sequence: 1,
      turn: 1,
      callId: 'call-present',
      files: [{ path: 'artifacts/report.txt', description: 'Generated report' }],
    })
  })
})
