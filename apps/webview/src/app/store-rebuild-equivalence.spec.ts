// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'
import type { TimelineNode } from '@dsh-vscode/timeline'

const SESSION_ID = 'session-rebuild-equivalence'

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
          id: SESSION_ID,
          workspaceId: 'workspace-rebuild',
          title: 'Rebuild equivalence fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
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

interface Transient {
  readonly transientSequence: number
  readonly attemptId: string
  readonly index: number
  readonly startedAfter: number
}

/**
 * A compact but broad transcript: user/turn/step rows, a transient reasoning and
 * answer stream settled by the durable completion, a nested tool call with a
 * sparse result, a TODO list, an advisory projection, a notice with command
 * input, a gap row and a frame this build cannot interpret.
 */
function buildFixture(): readonly HostMessage[] {
  let hostSequence = 0
  const emit = (name: string, payload: Readonly<Record<string, unknown>>): HostMessage => ({
    type: 'event',
    name,
    sequence: (hostSequence += 1),
    payload,
  })
  const transient: Transient = {
    transientSequence: 1,
    attemptId: 'attempt-equivalence-1',
    index: 0,
    startedAfter: 2,
  }

  return [
    emit('message.user', {
      sessionId: SESSION_ID,
      messageId: 'user-1',
      markdown: 'Refactor the storage layer and run the tests.',
      source: 'user',
      sequence: 1,
    }),
    emit('turn.started', { sessionId: SESSION_ID, turn: 1, sequence: 2 }),
    emit('step.started', { sessionId: SESSION_ID, turn: 1, step: 1, time: 1_790_000_000_001, sequence: 3 }),
    emit('reasoning.delta', {
      sessionId: SESSION_ID,
      messageId: 'assistant:1:1',
      delta: 'The storage layer needs a lookup first.',
      turn: 1,
      step: 1,
      transientSequence: transient.transientSequence,
      transientAttemptId: transient.attemptId,
      transientIndex: transient.index,
      transientStartedAfterSequence: transient.startedAfter,
    }),
    emit('message.delta', {
      sessionId: SESSION_ID,
      messageId: 'assistant:1:1',
      delta: 'All tests pass after the refactor.',
      turn: 1,
      step: 1,
      transientSequence: transient.transientSequence + 1,
      transientAttemptId: transient.attemptId,
      transientIndex: transient.index + 1,
      transientStartedAfterSequence: transient.startedAfter,
    }),
    emit('message.completed', {
      sessionId: SESSION_ID,
      messageId: 'assistant-durable-1',
      markdown: 'All tests pass after the refactor.',
      reasoning: 'The storage layer needs a lookup first.',
      modelLabel: 'dsv4-flash',
      usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, reasoningTokens: 12 },
      turn: 1,
      step: 1,
      time: 1_790_000_000_040,
      sequence: 4,
    }),
    emit('step.ended', { sessionId: SESSION_ID, turn: 1, step: 1, time: 1_790_000_000_041, sequence: 5 }),
    // The captured wire shape puts every tool in its own step.
    emit('step.started', { sessionId: SESSION_ID, turn: 1, step: 2, time: 1_790_000_000_042, sequence: 6 }),
    emit('tool.updated', {
      sessionId: SESSION_ID,
      tool: {
        id: 'call-parent',
        turn: 1,
        step: 2,
        name: 'shell',
        category: 'exec',
        title: 'Pwsh',
        status: 'running',
        startedAt: new Date(1_790_000_000_043).toISOString(),
        inputSummary: JSON.stringify({ command: 'pnpm test' }),
        metadata: {},
      },
      sequence: 7,
    }),
    emit('tool.updated', {
      sessionId: SESSION_ID,
      tool: {
        id: 'call-child',
        parentCallId: 'call-parent',
        turn: 1,
        step: 2,
        name: 'grep',
        category: 'search',
        title: 'Search',
        status: 'completed',
        completedAt: new Date(1_790_000_000_044).toISOString(),
        outputSummary: 'store.ts:87',
        metadata: {},
      },
      sequence: 8,
    }),
    emit('tool.updated', {
      sessionId: SESSION_ID,
      tool: {
        id: 'call-parent',
        turn: 1,
        step: 2,
        name: 'unknown-tool',
        category: 'tool',
        title: 'Tool',
        status: 'completed',
        completedAt: new Date(1_790_000_000_045).toISOString(),
        outputSummary: '12 passed (12)',
        metadata: {},
      },
      sequence: 9,
    }),
    emit('step.ended', { sessionId: SESSION_ID, turn: 1, step: 2, time: 1_790_000_000_046, sequence: 10 }),
    emit('turn.ended', { sessionId: SESSION_ID, turn: 1, reason: 'completed', sequence: 11 }),
    emit('turn.started', { sessionId: SESSION_ID, turn: 2, sequence: 12 }),
    emit('step.started', { sessionId: SESSION_ID, turn: 2, step: 1, time: 1_790_000_000_050, sequence: 13 }),
    // Host-only rows: no durable DSH cursor, only the Host publication counter.
    emit('notice', {
      sessionId: SESSION_ID,
      level: 'info',
      text: '压缩已完成。',
      commandName: 'compact',
      commandId: 'command-1',
      commandPhase: 'done',
      commandInput: '/compact',
    }),
    emit('todo.updated', {
      sessionId: SESSION_ID,
      todos: [
        { id: 'todo:0', content: '重构存储层', status: 'completed' },
        { id: 'todo:1', content: '跑测试', status: 'in-progress' },
      ],
      sequence: 14,
    }),
    emit('session.projection', {
      sessionId: SESSION_ID,
      key: 'next-turn',
      value: [{ turn: 3, seq: 16 }],
      sequence: 15,
    }),
    emit('future/unreadable-frame', {
      sessionId: SESSION_ID,
      cursor: 16,
      body: { opaque: true },
      sequence: 16,
    }),
    emit('message.completed', {
      sessionId: SESSION_ID,
      messageId: 'assistant-durable-2',
      markdown: 'Working tree is clean.',
      turn: 2,
      step: 1,
      time: 1_790_000_000_060,
      sequence: 17,
    }),
    emit('session.gap', { sessionId: SESSION_ID, fromSequence: 30, toSequence: 33 }),
    emit('step.ended', { sessionId: SESSION_ID, turn: 2, step: 1, time: 1_790_000_000_061, sequence: 18 }),
    emit('turn.ended', { sessionId: SESSION_ID, turn: 2, reason: 'completed', sequence: 19 }),
  ]
}

function signature(node: TimelineNode): string {
  switch (node.kind) {
    case 'assistant-message':
      return `assistant:${node.id}:${node.markdown}:${node.streaming}:${node.reasoning?.markdown ?? ''}`
    case 'user-message':
      return `user:${node.id}:${node.markdown}`
    case 'tool':
      return `tool:${node.id}:${node.tool.status}:${node.tool.name}:${node.tool.parentCallId ?? ''}:${node.tool.outputSummary ?? ''}`
    case 'todo':
      return `todo:${node.id}:${node.todos.map((todo) => `${todo.id}=${todo.status}`).join(',')}`
    case 'notice':
      return `notice:${node.id}:${node.text}`
    case 'command-input':
      return `command:${node.id}:${node.text}`
    case 'event':
      return `event:${node.id}`
    case 'reasoning':
      return `reasoning:${node.id}:${node.markdown}:${node.streaming}`
    default:
      return `${node.kind}:${node.id}`
  }
}

async function replay(messages: readonly HostMessage[]): Promise<{
  readonly store: ReturnType<typeof createAppStore>
  readonly client: StreamClient
}> {
  const client = new StreamClient()
  const store = createAppStore(client as unknown as ProtocolClient)
  await store.openSession(SESSION_ID)
  for (const message of messages) {
    client.emit(message)
    await new Promise((resolve) => window.setTimeout(resolve, 4))
  }
  await new Promise((resolve) => window.setTimeout(resolve, 60))
  return { store, client }
}

describe('ledger rebuild equivalence', () => {
  it('produces the same transcript with and without a below-cursor rebuild', async () => {
    const fixture = buildFixture()
    const reference = await replay(fixture)
    const referenceSignature = reference.store.timeline.nodes.map(signature)

    // The same stream, plus a history-recovery redelivery of the first durable
    // row: absorbed below the cursor, then republished by a ledger rebuild.
    const { store, client } = await replay(fixture)
    client.emit({
      type: 'event',
      name: 'message.user',
      sequence: 10_000,
      payload: {
        sessionId: SESSION_ID,
        messageId: 'user-1',
        markdown: 'Refactor the storage layer and run the tests.',
        source: 'user',
        sequence: 1,
      },
    })
    await new Promise((resolve) => window.setTimeout(resolve, 80))

    // Guard against a vacuous pass: every node family in the fixture has to be
    // present in the reference transcript before the rebuild is compared.
    const referenceKinds = reference.store.timeline.nodes.map((node) => node.kind)
    for (const kind of [
      'user-message',
      'assistant-message',
      'tool',
      'todo',
      'notice',
      'command-input',
      'event',
    ] as const)
      expect(referenceKinds).toContain(kind)
    expect(referenceSignature.some((line) => line.startsWith('tool:call-child:completed:grep'))).toBe(true)
    expect(referenceSignature).toContain('event:event:16:future/unreadable-frame')
    expect(referenceSignature.some((line) => line.includes('gap:'))).toBe(true)
    expect(referenceSignature).toContain('notice:notice:16:压缩已完成。')

    // A rebuild reconstructs the transcript from the durable ledger. Lossless
    // means the same nodes in the same order, including the host-only rows DSH
    // never replays.
    expect(store.timeline.nodes.map(signature)).toEqual(referenceSignature)
    expect(store.timeline.lastSequence).toBe(reference.store.timeline.lastSequence)
    reference.store.dispose()
    store.dispose()
  })

  it('keeps the rebuild stable when the same below-cursor row arrives twice', async () => {
    const fixture = buildFixture()
    const reference = await replay(fixture)
    const referenceSignature = reference.store.timeline.nodes.map(signature)

    const { store, client } = await replay(fixture)
    const belowCursor = {
      type: 'event' as const,
      name: 'tool.updated',
      sequence: 10_001,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-child',
          parentCallId: 'call-parent',
          turn: 1,
          step: 2,
          name: 'grep',
          category: 'search',
          title: 'Search',
          status: 'completed',
          outputSummary: 'store.ts:87',
          metadata: {},
        },
        sequence: 8,
      },
    }
    client.emit(belowCursor)
    await new Promise((resolve) => window.setTimeout(resolve, 60))
    client.emit(belowCursor)
    await new Promise((resolve) => window.setTimeout(resolve, 60))

    expect(store.timeline.nodes.map(signature)).toEqual(referenceSignature)
    reference.store.dispose()
    store.dispose()
  })
})
