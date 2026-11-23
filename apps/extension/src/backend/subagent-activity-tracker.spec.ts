import { describe, expect, it } from 'vitest'
import type { BackendEvent, ToolCallView } from '@dsh-vscode/domain'
import { SubagentActivityTracker } from './subagent-activity-tracker.js'

function toolEvent(
  sessionId: string,
  id: string,
  name: string,
  status: ToolCallView['status'],
): BackendEvent {
  return {
    type: 'tool.updated',
    sessionId,
    tool: {
      id,
      name,
      category: 'tool',
      title: name,
      status,
      metadata: {},
    },
  }
}

describe('SubagentActivityTracker', () => {
  it('emits deduplicated phase transitions only for known subagent sessions', () => {
    const tracker = new SubagentActivityTracker({ isSubagent: (id) => id === 'child-1' })

    expect(
      tracker.observe({
        type: 'reasoning.delta',
        sessionId: 'root-1',
        messageId: 'm1',
        delta: 'thinking',
      }),
    ).toBeUndefined()

    expect(
      tracker.observe({
        type: 'reasoning.delta',
        sessionId: 'child-1',
        messageId: 'm2',
        delta: 'step 1',
      }),
    ).toEqual({ sessionId: 'child-1', phase: 'thinking' })

    // Repeated reasoning deltas do not re-emit identical activity frames.
    expect(
      tracker.observe({
        type: 'reasoning.delta',
        sessionId: 'child-1',
        messageId: 'm2',
        delta: 'step 2',
      }),
    ).toBeUndefined()

    expect(tracker.observe(toolEvent('child-1', 'c1', 'read_file', 'running'))).toEqual({
      sessionId: 'child-1',
      phase: 'tool',
      toolName: 'read_file',
      activeToolCount: 1,
    })

    expect(tracker.observe(toolEvent('child-1', 'c2', 'bash', 'running'))).toEqual({
      sessionId: 'child-1',
      phase: 'tool',
      toolName: 'bash',
      activeToolCount: 2,
    })

    expect(tracker.observe(toolEvent('child-1', 'c2', 'bash', 'completed'))).toEqual({
      sessionId: 'child-1',
      phase: 'tool',
      toolName: 'read_file',
      activeToolCount: 1,
    })

    expect(tracker.observe(toolEvent('child-1', 'c1', 'read_file', 'completed'))).toEqual({
      sessionId: 'child-1',
      phase: 'thinking',
    })

    expect(
      tracker.observe({
        type: 'message.delta',
        sessionId: 'child-1',
        messageId: 'm2',
        delta: 'Done.',
      }),
    ).toEqual({ sessionId: 'child-1', phase: 'responding' })

    expect(
      tracker.observe({
        type: 'turn.ended',
        sessionId: 'child-1',
        turn: 1,
        reason: 'completed',
      }),
    ).toEqual({ sessionId: 'child-1', phase: 'idle' })

    expect(tracker.snapshots()).toEqual([])
  })

  it('surfaces activity observed before catalog registration as soon as the child is marked', () => {
    const tracker = new SubagentActivityTracker()

    expect(tracker.observe(toolEvent('child-2', 'c1', 'edit', 'running'))).toBeUndefined()
    expect(
      tracker.observe({
        type: 'subagent.catalog.updated',
        sessionId: 'root-1',
        entry: { id: 'child-2', createdAt: 1, mode: 'continuable', label: 'Refactor' },
      }),
    ).toEqual({
      sessionId: 'child-2',
      phase: 'tool',
      toolName: 'edit',
      activeToolCount: 1,
    })
    expect(tracker.snapshots()).toEqual([
      { sessionId: 'child-2', phase: 'tool', toolName: 'edit', activeToolCount: 1 },
    ])
  })

  it('prioritizes pending approvals and questions over running tools and clears on resolution', () => {
    const tracker = new SubagentActivityTracker({ isSubagent: (id) => id === 'child-1' })

    tracker.observe(toolEvent('child-1', 'c1', 'bash', 'running'))
    expect(
      tracker.observe({
        type: 'permission.requested',
        request: {
          id: 'perm-1',
          sessionId: 'child-1',
          title: 'Run shell',
          description: 'Need approval',
          risk: 'medium',
          options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
        },
      }),
    ).toEqual({ sessionId: 'child-1', phase: 'awaiting-approval' })

    expect(
      tracker.observe({
        type: 'permission.resolved',
        sessionId: 'child-1',
        requestId: 'perm-1',
      }),
    ).toEqual({
      sessionId: 'child-1',
      phase: 'tool',
      toolName: 'bash',
      activeToolCount: 1,
    })

    expect(
      tracker.observe({
        type: 'question.requested',
        question: {
          id: 'q-1',
          sessionId: 'child-1',
          callId: 'call-q1',
          prompt: 'Continue?',
          allowFreeText: true,
        },
      }),
    ).toEqual({ sessionId: 'child-1', phase: 'awaiting-question' })

    expect(
      tracker.observe({
        type: 'question.resolved',
        sessionId: 'child-1',
        settledCallId: 'call-q1',
      }),
    ).toEqual({
      sessionId: 'child-1',
      phase: 'tool',
      toolName: 'bash',
      activeToolCount: 1,
    })
  })

  it('clears state on session removal, idle status, and connection loss', () => {
    const tracker = new SubagentActivityTracker()
    tracker.observe({
      type: 'session.added',
      sessionId: 'child-a',
      origin: 'subagent',
      parentSessionId: 'root',
    })
    tracker.observe(toolEvent('child-a', 'c1', 'grep', 'running'))

    expect(
      tracker.observe({
        type: 'session.status',
        sessionId: 'child-a',
        status: 'idle',
      }),
    ).toEqual({ sessionId: 'child-a', phase: 'idle' })

    tracker.observe(toolEvent('child-a', 'c2', 'read', 'running'))
    expect(tracker.observe({ type: 'session.removed', sessionId: 'child-a' })).toEqual({
      sessionId: 'child-a',
      phase: 'idle',
    })

    tracker.markSubagent('child-b')
    tracker.observe(toolEvent('child-b', 'c3', 'write', 'running'))
    expect(tracker.snapshots()).toHaveLength(1)
    tracker.observe({ type: 'connection.lost', reason: 'closed' })
    expect(tracker.snapshots()).toEqual([])
  })

  it('tracks preparing tool updates separately from executing tools', () => {
    const tracker = new SubagentActivityTracker({ isSubagent: (id) => id === 'child-1' })

    expect(
      tracker.observe({
        type: 'tool.updated',
        sessionId: 'child-1',
        tool: {
          id: 'c-prep',
          name: 'write',
          category: 'tool',
          title: 'write',
          status: 'queued',
          preparation: { attemptId: 'a1', updateIndex: 1 },
          metadata: {},
        },
      }),
    ).toEqual({
      sessionId: 'child-1',
      phase: 'preparing-tool',
      toolName: 'write',
    })

    expect(tracker.observe(toolEvent('child-1', 'c-prep', 'write', 'running'))).toEqual({
      sessionId: 'child-1',
      phase: 'tool',
      toolName: 'write',
      activeToolCount: 1,
    })
  })

  it('ignores historical activity and displays a generic heading for an unsafe tool name', () => {
    const tracker = new SubagentActivityTracker({ isSubagent: () => true })
    expect(
      tracker.observe({ ...toolEvent('child', 'old', 'read', 'running'), replayed: true }),
    ).toBeUndefined()
    expect(tracker.snapshots()).toEqual([])
    expect(tracker.observe(toolEvent('child', 'live', 'C:/workspace/private.txt', 'running'))).toEqual({
      sessionId: 'child',
      phase: 'tool',
      activeToolCount: 1,
    })
  })
})
