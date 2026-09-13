// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'
import { Timeline } from '../features/chat/Timeline.js'
import { TrajectoryView } from '../features/trajectory/TrajectoryView.js'

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

  it('keeps the streamed final answer after durable completion closes a multi-tool turn', async () => {
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
    const push = async (name: string, payload: Record<string, unknown>): Promise<void> => {
      const sequence = typeof payload.sequence === 'number' ? payload.sequence : undefined
      client.emit(event(sequence ?? 0, name, payload))
      await new Promise((resolve) => window.setTimeout(resolve, 24))
    }
    const tool = (
      id: string,
      status: 'running' | 'completed',
      outputSummary?: string,
    ): Record<string, unknown> => ({
      id,
      name: 'read',
      category: 'filesystem',
      title: 'Read',
      status,
      turn: 5,
      step: 1,
      inputSummary: JSON.stringify({ path: `${id}.txt` }),
      ...(outputSummary === undefined ? {} : { outputSummary }),
      metadata: {},
    })

    try {
      await push('message.user', {
        sequence: 119,
        sessionId: 'session-stream',
        messageId: 'user-5',
        markdown: '检查两个文件并给出结论',
        source: 'user',
      })
      await push('turn.started', { sequence: 115, sessionId: 'session-stream', turn: 5 })
      await push('step.started', { sequence: 116, sessionId: 'session-stream', turn: 5, step: 1 })
      await push('reasoning.delta', {
        sequence: 120,
        sessionId: 'session-stream',
        messageId: 'assistant:5:1',
        turn: 5,
        step: 1,
        delta: '先读取文件。',
        transientSequence: 1,
        transientAttemptId: 'attempt-tools',
        transientIndex: 0,
        transientStartedAfterSequence: 119,
      })
      await push('tool.updated', {
        sequence: 122,
        sessionId: 'session-stream',
        tool: tool('tool-1', 'completed', 'a'),
      })
      await push('tool.updated', {
        sequence: 127,
        sessionId: 'session-stream',
        tool: tool('tool-2', 'completed', 'b'),
      })
      await push('tool.updated', {
        sequence: 132,
        sessionId: 'session-stream',
        tool: tool('tool-3', 'completed', 'c'),
      })
      await push('tool.updated', {
        sequence: 137,
        sessionId: 'session-stream',
        tool: tool('tool-4', 'completed', 'd'),
      })
      await push('step.ended', { sequence: 139, sessionId: 'session-stream', turn: 5, step: 4 })
      await push('step.started', { sequence: 140, sessionId: 'session-stream', turn: 5, step: 5 })
      await push('message.delta', {
        sequence: 141,
        sessionId: 'session-stream',
        messageId: 'assistant:5:5',
        turn: 5,
        step: 5,
        delta: '替换成功 ✅',
        transientSequence: 2,
        transientAttemptId: 'attempt-final',
        transientIndex: 0,
        transientStartedAfterSequence: 139,
      })
      expect(view.container.textContent).toContain('替换成功 ✅')

      await push('message.completed', {
        sequence: 141,
        sessionId: 'session-stream',
        messageId: '97ce95fc-ad19-441d-ae90-c2e70b53a6da',
        turn: 5,
        step: 5,
        markdown: '替换成功 ✅\n\n结果对比：最终内容已写入。',
        reasoning: '已完成最后检查。',
        modelLabel: 'MiniMax-M3',
      })
      expect(view.container.textContent).toContain('替换成功 ✅')
      expect(view.container.textContent).toContain('最终内容已写入。')

      await push('step.ended', { sequence: 142, sessionId: 'session-stream', turn: 5, step: 5 })
      await push('turn.ended', { sequence: 143, sessionId: 'session-stream', turn: 5, reason: 'completed' })

      const completedNode = store.timeline.nodes.find(
        (node) => node.kind === 'assistant-message' && node.id === '97ce95fc-ad19-441d-ae90-c2e70b53a6da',
      )
      expect(completedNode?.kind).toBe('assistant-message')
      if (completedNode?.kind !== 'assistant-message') return
      expect(completedNode.markdown).toContain('最终内容已写入。')
      expect(completedNode.streaming).toBe(false)
      expect(view.container.textContent).toContain('替换成功 ✅')
      expect(view.container.textContent).toContain('最终内容已写入。')
    } finally {
      unsubscribe()
      store.dispose()
    }
  })

  it('keeps the exact completed table in chat and trajectory after a four-step ledger rebuild', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    const finalMarkdown =
      '替换成功 ✅\n\n**结果对比：**\n\n| 行 | 之前 | 现在 |\n|---|---|---|\n| 1 | `Hello, World!` | `Greetings from MiniMax-M3!` |\n| 2-4 | （不变） | （不变） |\n\n**顺便说一下刚才的小坑：** 工具默认是 fs-observation-policy，首次编辑后必须先 `read` 再 `edit`，否则会被拒绝——这次先 `read` 再 `edit` 就过了。'
    const timeline = (): ReactElement => (
      <>
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
          running={false}
        />
        <TrajectoryView
          sessionId="session-stream"
          nodes={store.timeline.nodes}
          {...(store.timeline.nodeChangeStart === undefined
            ? {}
            : { nodeChangeStart: store.timeline.nodeChangeStart })}
          {...(store.timeline.nodeChangeBase === undefined
            ? {}
            : { nodeChangeBase: store.timeline.nodeChangeBase })}
          streaming={false}
        />
      </>
    )
    const view = render(timeline())
    const renderCurrentState = (): void => view.rerender(timeline())
    const unsubscribe = store.subscribe(renderCurrentState)
    let hostSequence = 100
    const push = async (name: string, payload: Record<string, unknown>): Promise<void> => {
      client.emit(event(hostSequence++, name, payload))
      await new Promise((resolve) => window.setTimeout(resolve, 24))
    }
    const tool = (
      id: string,
      step: number,
      status: 'completed',
      output: string,
    ): Record<string, unknown> => ({
      id,
      name: step === 2 ? 'edit' : 'read',
      category: step === 2 ? 'edit' : 'filesystem',
      title: step === 2 ? 'Edit' : 'Read',
      status,
      turn: 5,
      step,
      inputSummary: JSON.stringify({ path: 'hello.txt' }),
      outputSummary: output,
      metadata: {},
    })

    try {
      await push('message.user', {
        sequence: 119,
        sessionId: 'session-stream',
        messageId: 'user-5',
        markdown: '把 hello.txt 的第一行替换掉，然后告诉我结果',
        source: 'user',
      })
      await push('turn.started', { sequence: 115, sessionId: 'session-stream', turn: 5 })
      await push('step.started', { sequence: 116, sessionId: 'session-stream', turn: 5, step: 1 })
      for (const [step, output] of [
        [1, 'Hello, World!'],
        [2, '文件已修改'],
        [3, '已重新读取文件'],
        [4, '已确认第一行'],
      ] as const) {
        await push('tool.updated', {
          sequence: 120 + step,
          sessionId: 'session-stream',
          tool: tool(`tool-${step}`, step, 'completed', output),
        })
        if (step < 4) {
          await push('step.ended', { sequence: 124 + step, sessionId: 'session-stream', turn: 5, step })
          await push('step.started', {
            sequence: 125 + step,
            sessionId: 'session-stream',
            turn: 5,
            step: step + 1,
          })
        }
      }
      await push('message.delta', {
        sequence: 141,
        sessionId: 'session-stream',
        messageId: 'assistant:5:5',
        turn: 5,
        step: 5,
        delta: '替换成功 ✅',
        transientSequence: 1,
        transientAttemptId: 'attempt-final',
        transientIndex: 0,
        transientStartedAfterSequence: 139,
      })
      expect(view.container.textContent).toContain('替换成功 ✅')

      await push('message.completed', {
        sequence: 141,
        sessionId: 'session-stream',
        messageId: '97ce95fc-ad19-441d-ae90-c2e70b53a6da',
        turn: 5,
        step: 5,
        markdown: finalMarkdown,
        reasoning: 'Good - this time the edit succeeded after reading.',
        modelLabel: 'MiniMax-M3',
      })
      await push('step.ended', { sequence: 142, sessionId: 'session-stream', turn: 5, step: 5 })
      await push('turn.ended', { sequence: 143, sessionId: 'session-stream', turn: 5, reason: 'completed' })
      await push('tool.updated', {
        sequence: 137,
        sessionId: 'session-stream',
        tool: tool('tool-4', 4, 'completed', '已确认第一行'),
      })

      const finalNode = store.timeline.nodes.find(
        (node) => node.kind === 'assistant-message' && node.id === '97ce95fc-ad19-441d-ae90-c2e70b53a6da',
      )
      expect(finalNode).toEqual(
        expect.objectContaining({ kind: 'assistant-message', markdown: finalMarkdown, streaming: false }),
      )
      const completedHistoryEntry = store.history.find(
        (entry) => entry.sequence === 141 && entry.event.type === 'message.completed',
      )
      expect(completedHistoryEntry?.event.type).toBe('message.completed')
      if (completedHistoryEntry?.event.type !== 'message.completed') return
      expect(completedHistoryEntry.event.messageId).toBe('97ce95fc-ad19-441d-ae90-c2e70b53a6da')
      expect(completedHistoryEntry.event.markdown).toBe(finalMarkdown)
      expect(view.container.textContent).toContain('替换成功 ✅')
      expect(view.container.textContent).toContain('Greetings from MiniMax-M3!')
      expect(view.container.textContent).toContain('结果对比')
      expect(
        Array.from(view.container.querySelectorAll('.dsh-trajectory__text')).some((element) =>
          element.textContent?.includes('替换成功'),
        ),
      ).toBe(true)

      await new Promise((resolve) => window.setTimeout(resolve, 60))
      expect(store.timeline.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'assistant-message',
          id: '97ce95fc-ad19-441d-ae90-c2e70b53a6da',
          markdown: finalMarkdown,
          streaming: false,
        }),
      )
      expect(view.container.textContent).toContain('这次先 `read` 再 `edit` 就过了。')
      expect(view.container.textContent).toContain('替换成功')
    } finally {
      unsubscribe()
      store.dispose()
    }
  })

  it('keeps the completed answer when real Host envelopes mix durable DSH rows with cursorless assistant frames', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    const finalMarkdown =
      '替换成功 ✅\n\n**结果对比：**\n\n| 行 | 之前 | 现在 |\n|---|---|---|\n| 1 | `Hello, World!` | `Greetings from MiniMax-M3!` |\n| 2-4 | （不变） | （不变） |\n\n已完成最后检查。'
    const renderView = (): ReactElement => (
      <>
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
          running={false}
        />
        <TrajectoryView
          sessionId="session-stream"
          nodes={store.timeline.nodes}
          {...(store.timeline.nodeChangeStart === undefined
            ? {}
            : { nodeChangeStart: store.timeline.nodeChangeStart })}
          {...(store.timeline.nodeChangeBase === undefined
            ? {}
            : { nodeChangeBase: store.timeline.nodeChangeBase })}
          streaming={false}
        />
      </>
    )
    const view = render(renderView())
    const rerender = (): void => view.rerender(renderView())
    const unsubscribe = store.subscribe(rerender)
    let hostSequence = 1
    const push = async (name: string, payload: Record<string, unknown>): Promise<void> => {
      // The outer sequence is the Extension Host publication sequence. Only
      // durable events carry the DSH sequence inside the sanitized payload;
      // assistant stream frames deliberately do not.
      client.emit(event(hostSequence++, name, payload))
      await new Promise((resolve) => window.setTimeout(resolve, 24))
    }
    const tool = (
      id: string,
      step: number,
      status: 'running' | 'completed',
      outputSummary?: string,
    ): Record<string, unknown> => ({
      id,
      name: step % 2 === 0 ? 'edit' : 'read',
      category: step % 2 === 0 ? 'edit' : 'filesystem',
      title: step % 2 === 0 ? 'Edit' : 'Read',
      status,
      turn: 5,
      step,
      inputSummary: JSON.stringify({ path: 'hello.txt' }),
      ...(outputSummary === undefined ? {} : { outputSummary }),
      metadata: {},
    })

    try {
      // This is the order emitted by the Session follow stream: durable
      // records retain DSH order, while assistant chunks are interleaved
      // without a durable sequence.
      await push('turn.started', { sequence: 115, sessionId: 'session-stream', turn: 5 })
      await push('step.started', { sequence: 117, sessionId: 'session-stream', turn: 5, step: 1 })
      await push('message.user', {
        sequence: 119,
        sessionId: 'session-stream',
        messageId: 'user-5',
        markdown: '把 hello.txt 的第一行替换掉，然后告诉我结果',
        source: 'user',
      })
      await push('message.completed', {
        sequence: 121,
        sessionId: 'session-stream',
        messageId: 'assistant-tool-step-1',
        turn: 5,
        step: 1,
      })
      await push('tool.updated', {
        sequence: 122,
        sessionId: 'session-stream',
        tool: tool('tool-1', 1, 'running'),
      })
      await push('tool.updated', {
        sequence: 123,
        sessionId: 'session-stream',
        tool: tool('tool-1', 1, 'completed', 'Hello, World!'),
      })
      await push('step.ended', { sequence: 124, sessionId: 'session-stream', turn: 5, step: 1 })

      for (const [step, sequence, output] of [
        [2, 127, '文件已修改'],
        [3, 132, '已重新读取文件'],
        [4, 137, '已确认第一行'],
      ] as const) {
        await push('step.started', { sequence: sequence - 2, sessionId: 'session-stream', turn: 5, step })
        await push('tool.updated', {
          sequence: sequence,
          sessionId: 'session-stream',
          tool: tool(`tool-${step}`, step, 'completed', output),
        })
        await push('step.ended', { sequence: sequence + 1, sessionId: 'session-stream', turn: 5, step })
      }

      await push('step.started', { sequence: 140, sessionId: 'session-stream', turn: 5, step: 5 })
      await push('reasoning.delta', {
        sessionId: 'session-stream',
        messageId: 'assistant:5:5',
        turn: 5,
        step: 5,
        delta: '已完成最后检查。',
        transientSequence: 1,
        transientAttemptId: 'attempt-final',
        transientIndex: 0,
        transientStartedAfterSequence: 139,
      })
      await push('message.delta', {
        sessionId: 'session-stream',
        messageId: 'assistant:5:5',
        turn: 5,
        step: 5,
        delta: '替换成功 ✅',
        transientSequence: 2,
        transientAttemptId: 'attempt-final',
        transientIndex: 1,
        transientStartedAfterSequence: 139,
      })
      expect(view.container.textContent).toContain('替换成功 ✅')

      // The durable assistant/message carries the full assembled answer. It
      // arrives after the cursorless stream prefix and before the closing
      // step/turn markers, as in DSH's committed assistant stream.
      await push('message.completed', {
        sequence: 141,
        sessionId: 'session-stream',
        messageId: 'assistant-final-real-envelope',
        turn: 5,
        step: 5,
        markdown: finalMarkdown,
        reasoning: '已完成最后检查。',
        modelLabel: 'MiniMax-M3',
      })
      await push('step.ended', { sequence: 142, sessionId: 'session-stream', turn: 5, step: 5 })
      await push('turn.ended', { sequence: 143, sessionId: 'session-stream', turn: 5, reason: 'completed' })

      expect(store.history.map((entry) => entry.sequence)).toEqual(
        expect.arrayContaining([115, 117, 119, 121, 122, 123, 124, 141, 142, 143]),
      )
      expect(store.history.some((entry) => entry.event.type === 'message.delta')).toBe(false)
      expect(store.timeline.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'assistant-message',
          id: 'assistant-final-real-envelope',
          markdown: finalMarkdown,
          streaming: false,
        }),
      )
      expect(view.container.textContent).toContain('Greetings from MiniMax-M3!')
      expect(view.container.textContent).toContain('已完成最后检查。')
      expect(
        Array.from(view.container.querySelectorAll('.dsh-trajectory__text')).some((element) =>
          element.textContent?.includes('替换成功'),
        ),
      ).toBe(true)
    } finally {
      unsubscribe()
      store.dispose()
    }
  })

  it('keeps a failed assistant attempt out of the visible transcript across retry', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    const push = async (message: HostMessage): Promise<void> => {
      client.emit(message)
      await new Promise((resolve) => window.setTimeout(resolve, 24))
    }

    await push(
      event(1, 'message.delta', {
        sessionId: 'session-stream',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'stale attempt output',
        transientSequence: 1,
        transientAttemptId: 'attempt-failed',
        transientIndex: 0,
      }),
    )
    await push(
      event(2, 'assistant.attempt', {
        sessionId: 'session-stream',
        turn: 1,
        step: 1,
        time: 20,
        sequence: 2,
      }),
    )
    await push(
      event(3, 'model.retry', {
        sequence: 3,
        retry: {
          sessionId: 'session-stream',
          id: 'retry-1',
          turn: 1,
          step: 1,
          attempt: 2,
          state: 'scheduled',
        },
      }),
    )
    await push(
      event(4, 'message.delta', {
        sessionId: 'session-stream',
        messageId: 'assistant:1:1',
        turn: 1,
        step: 1,
        delta: 'final attempt output',
        transientSequence: 2,
        transientAttemptId: 'attempt-final',
        transientIndex: 0,
      }),
    )
    await push(
      event(5, 'message.completed', {
        sessionId: 'session-stream',
        messageId: 'assistant-final',
        turn: 1,
        step: 1,
        markdown: 'final attempt output',
        sequence: 5,
      }),
    )

    expect(store.timeline.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'retry', id: 'retry:retry-1' }),
        expect.objectContaining({
          kind: 'assistant-message',
          id: 'assistant-final',
          markdown: 'final attempt output',
          streaming: false,
        }),
      ]),
    )
    expect(store.timeline.nodes).not.toContainEqual(
      expect.objectContaining({ markdown: 'stale attempt output' }),
    )
    expect(store.history.map((entry) => entry.sequence)).toEqual([2, 3, 5])
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

  it('keeps the answer when a control projection is published for a completion sequence', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession('session-stream')

    const finalMarkdown = '已完成两件事：创建 `hello.txt` 并读取确认内容为 `live-verify`。'
    const renderView = (): ReactElement => (
      <>
        <Timeline sessionId="session-stream" nodes={store.timeline.nodes} streaming={false} running={false} />
        <TrajectoryView sessionId="session-stream" nodes={store.timeline.nodes} streaming={false} />
      </>
    )
    const view = render(renderView())
    const unsubscribe = store.subscribe(() => view.rerender(renderView()))
    const push = async (name: string, payload: Record<string, unknown>): Promise<void> => {
      client.emit(event(900 + Number(payload.sequence ?? 0), name, payload))
      await new Promise((resolve) => window.setTimeout(resolve, 24))
    }

    try {
      await push('message.user', {
        sequence: 10,
        sessionId: 'session-stream',
        messageId: 'user-1',
        markdown: '创建 hello.txt 并确认内容',
        source: 'user',
      })
      await push('turn.started', { sequence: 11, sessionId: 'session-stream', turn: 1 })
      await push('step.started', { sequence: 12, sessionId: 'session-stream', turn: 1, step: 1 })
      // Real DSH publishes an advisory projection whose `seq` is the cursor it
      // describes. The durable row that actually owns that cursor arrives right
      // after it, so the projection must never occupy the durable slot.
      await push('session.projection', {
        sequence: 15,
        sessionId: 'session-stream',
        key: 'next-turn',
        value: [{ turn: 1, seq: 15 }],
      })
      await push('message.completed', {
        sequence: 15,
        sessionId: 'session-stream',
        messageId: 'assistant-final',
        turn: 1,
        step: 1,
        markdown: finalMarkdown,
      })
      await push('step.ended', { sequence: 16, sessionId: 'session-stream', turn: 1, step: 1 })
      await push('turn.ended', {
        sequence: 17,
        sessionId: 'session-stream',
        turn: 1,
        reason: 'completed',
      })

      expect(store.timeline.nodes).toContainEqual(
        expect.objectContaining({
          kind: 'assistant-message',
          id: 'assistant-final',
          markdown: finalMarkdown,
          streaming: false,
        }),
      )
      expect(store.timeline.nodes.some((node) => node.kind === 'event')).toBe(false)

      // A delayed durable redelivery below the cursor republishes the ledger;
      // the rebuilt transcript must keep the projection out of the cursor and
      // the completed answer in place.
      await push('step.started', { sequence: 13, sessionId: 'session-stream', turn: 1, step: 1 })
      await new Promise((resolve) => window.setTimeout(resolve, 80))

      const finalNode = store.timeline.nodes.find((node) => node.id === 'assistant-final')
      expect(finalNode).toEqual(
        expect.objectContaining({ kind: 'assistant-message', markdown: finalMarkdown, streaming: false }),
      )
      expect(store.timeline.nodes.some((node) => node.kind === 'event')).toBe(false)
      expect(store.timeline.nodes.at(-1)?.id).toBe('assistant-final')
      expect(view.container.textContent).toContain('live-verify')
      expect(
        Array.from(view.container.querySelectorAll('.dsh-trajectory__text')).some((element) =>
          element.textContent?.includes('live-verify'),
        ),
      ).toBe(true)
    } finally {
      unsubscribe()
      store.dispose()
    }
  })
})
