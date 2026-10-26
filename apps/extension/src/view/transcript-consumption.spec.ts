import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, SessionHistoryEvent } from '@dsh-vscode/domain'
import type { TranscriptPatch, TranscriptWindow } from '@dsh-vscode/webview-protocol'
import { TranscriptWindowService } from './transcript-window.js'

const sessionId = 's'
const text = (index: number): Extract<BackendEvent, { type: 'message.delta' }> => ({
  type: 'message.delta',
  sessionId,
  messageId: 'answer',
  delta: `${index} `,
  transientAttemptId: 'a',
  transientSequence: index + 1,
  transientIndex: index,
  transientStartedAfterSequence: 0,
})
function fixture(events: readonly SessionHistoryEvent[] = []): {
  service: TranscriptWindowService
  initial: TranscriptWindow
  windows: TranscriptWindow[]
  patches: TranscriptPatch[]
  read: ReturnType<typeof vi.fn>
  invalidate: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  onCapacity: ReturnType<typeof vi.fn>
} {
  const windows: TranscriptWindow[] = [],
    patches: TranscriptPatch[] = []
  const read = vi.fn().mockResolvedValue({ events, hasMore: false })
  const invalidate = vi.fn(),
    refresh = vi.fn().mockResolvedValue(undefined),
    onCapacity = vi.fn()
  const service = new TranscriptWindowService({
    consumerDriven: true,
    read,
    invalidate,
    refresh,
    onCapacity,
    publicValue: (value) => value,
    post: (value) => {
      windows.push(value)
      return Promise.resolve(true)
    },
    postPatch: (value) => {
      patches.push(value)
      return Promise.resolve(true)
    },
  })
  const initial = service.installPage(sessionId, { events: [], hasMore: false }, service.begin(sessionId))
  return { service, initial, windows, patches, read, invalidate, refresh, onCapacity }
}

describe('consumer-driven transcript projection', () => {
  it('publishes hidden tool context ahead of an interaction barrier without resuming ordinary streaming', () => {
    const { service, windows } = fixture()
    try {
      service.setVisible(false)
      service.accept({
        type: 'tool.updated',
        sessionId,
        tool: {
          id: 'tool',
          name: 'bash',
          category: 'shell',
          title: 'Run',
          status: 'running',
          inputSummary: 'echo fixture',
          metadata: {},
        },
      })
      expect(windows).toHaveLength(0)
      service.accept({
        type: 'permission.requested',
        request: {
          id: 'p',
          sessionId,
          callId: 'tool',
          title: 'Allow',
          description: 'Allow fixture',
          risk: 'low',
          options: [],
        },
      })
      expect(windows[0]?.nodes[0]).toMatchObject({ kind: 'tool', tool: { inputSummary: 'echo fixture' } })
      service.accept(text(0))
      expect(windows).toHaveLength(1)
    } finally {
      service.dispose()
    }
  })

  it('pauses hidden reductions and resumes to the same complete content', () => {
    const { service, windows } = fixture()
    try {
      service.setVisible(false)
      for (let index = 0; index < 1000; index++) service.accept(text(index))
      expect(windows).toHaveLength(0)
      service.setVisible(true)
      expect(service.fullNode(sessionId, 'answer', 0, new AbortController().signal)).toMatchObject({
        markdown: Array.from({ length: 1000 }, (_, index) => `${index} `).join(''),
        liveLastIndex: 999,
      })
    } finally {
      service.dispose()
    }
  })

  it('repairs a hidden overflow with one session baseline and no unbounded resident work', async () => {
    const events: SessionHistoryEvent[] = Array.from({ length: 300 }, (_, index) => ({
      sequence: index + 1,
      time: '2026-10-25T00:00:00.000Z',
      event: {
        type: 'message.completed',
        sessionId,
        messageId: `m-${index}`,
        markdown: `answer ${index}`,
        sequence: index + 1,
      },
    }))
    const { service, invalidate, onCapacity } = fixture(events)
    try {
      service.setVisible(false)
      for (const { event } of events) service.accept(event)
      expect(onCapacity).toHaveBeenLastCalledWith(false)
      expect(invalidate).not.toHaveBeenCalled()
      service.setVisible(true)
      service.setVisible(true)
      const window = await service.resync(sessionId, new AbortController().signal)
      expect(window.lastSequence).toBe(300)
      expect(window.nodes.at(-1)).toMatchObject({ id: 'm-299', markdown: 'answer 299' })
      expect(onCapacity).toHaveBeenLastCalledWith(true)
    } finally {
      service.dispose()
    }
  })
})
