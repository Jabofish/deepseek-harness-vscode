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
      expect(service['ingress'].size).toBe(1)
      expect(windows).toHaveLength(1)
    } finally {
      service.dispose()
    }
  })
  it('keeps failed recovery repairable and limits preview-driven rebase oscillation', async () => {
    vi.useFakeTimers()
    const { service, read, onCapacity, invalidate } = fixture()
    try {
      for (let round = 0; round < 3; round++) {
        service.setVisible(false)
        service.accept({ ...text(0), delta: 'x'.repeat(512 * 1024 + 1) })
        service.setVisible(true)
        if (round === 0) {
          read.mockRejectedValueOnce(new Error('temporary history failure'))
          await expect(service.resync(sessionId, new AbortController().signal)).rejects.toThrow(
            'temporary history failure',
          )
          expect(service['needsRebase']).toBe(true)
          const beforeRetry = invalidate.mock.calls.length
          service.accept(text(1))
          expect(invalidate.mock.calls.length).toBe(beforeRetry + 1)
        }
        await service.resync(sessionId, new AbortController().signal)
      }
      expect(onCapacity).toHaveBeenLastCalledWith(false)
      await vi.advanceTimersByTimeAsync(10_000)
      service.setVisible(true)
      expect(onCapacity).toHaveBeenLastCalledWith(true)
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })
  it('performs two reductions for a thousand chunks behind an unacknowledged window', async () => {
    const { service, windows, patches } = fixture()
    try {
      const reduce = vi.spyOn(service as unknown as { reduce(): void }, 'reduce')
      service.accept(text(0))
      await vi.waitFor(() => expect(windows).toHaveLength(1))
      for (let index = 1; index <= 1000; index++) service.accept(text(index))
      expect(reduce).toHaveBeenCalledTimes(1)
      expect(service['ingress'].size).toBe(1)
      expect(patches).toHaveLength(0)
      service.acknowledge(sessionId, windows[0]!.revision)
      await vi.waitFor(() => expect(windows.length + patches.length).toBe(2))
      expect(reduce).toHaveBeenCalledTimes(3)
      expect(
        service.fullNode(sessionId, 'answer', windows.at(-1)!.revision, new AbortController().signal),
      ).toMatchObject({
        markdown: Array.from({ length: 1001 }, (_, index) => `${index} `).join(''),
        liveLastIndex: 1000,
      })
    } finally {
      service.dispose()
    }
  })

  it('pauses hidden reductions and resumes to the same complete content', () => {
    const { service, windows } = fixture()
    try {
      service.setVisible(false)
      const reduce = vi.spyOn(service as unknown as { reduce(): void }, 'reduce')
      for (let index = 0; index < 1000; index++) service.accept(text(index))
      expect(reduce).not.toHaveBeenCalled()
      expect(windows).toHaveLength(0)
      service.setVisible(true)
      expect(reduce).toHaveBeenCalledTimes(2)
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
    const { service, read, refresh, invalidate, onCapacity } = fixture(events)
    try {
      service.setVisible(false)
      const reduce = vi.spyOn(service as unknown as { reduce(): void }, 'reduce')
      for (const { event } of events) service.accept(event)
      expect(reduce).not.toHaveBeenCalled()
      expect(service['ingress'].size).toBe(0)
      expect(onCapacity).toHaveBeenLastCalledWith(false)
      expect(invalidate).not.toHaveBeenCalled()
      service.setVisible(true)
      service.setVisible(true)
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(sessionId)
      const window = await service.resync(sessionId, new AbortController().signal)
      expect(read).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenCalledExactlyOnceWith(sessionId)
      expect(window.lastSequence).toBe(300)
      expect(window.nodes.at(-1)).toMatchObject({ id: 'm-299', markdown: 'answer 299' })
      expect(onCapacity).toHaveBeenLastCalledWith(true)
    } finally {
      service.dispose()
    }
  })

  it('repairs ordinary packet loss using the resident window without a session/history reread', async () => {
    const { service, read, refresh } = fixture()
    try {
      service.accept(text(0))
      service.accept(text(1))
      const window = await service.resync(sessionId, new AbortController().signal)
      expect(window.nodes[0]).toMatchObject({ markdown: '0 1 ' })
      expect(read).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      service.dispose()
    }
  })
})
