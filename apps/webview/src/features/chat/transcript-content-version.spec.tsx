// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TranscriptWindowService } from '../../../../extension/src/view/transcript-window.js'
import { sanitizePublicValue } from '../../../../extension/src/view/public-value.js'
import type { TranscriptWindow } from '@dsh-vscode/webview-protocol'
import { useCompleteTranscriptNodes } from './useCompleteTranscriptNodes.js'
afterEach(cleanup)
it('keeps full live content current when native clipping produces identical repeating tails', async () => {
  const posted: TranscriptWindow[] = []
  const service = new TranscriptWindowService({
    read: () => Promise.resolve({ events: [], hasMore: false }),
    publicValue: (v) => sanitizePublicValue(v),
    post: (w) => {
      posted.push(w)
      return Promise.resolve(true)
    },
  })
  try {
    service.installPage('s', { events: [], hasMore: false }, service.begin('s'))
    service.accept({ type: 'message.delta', sessionId: 's', messageId: 'live', delta: 'x'.repeat(5000000) })
    await waitFor(() => expect(posted.length).toBeGreaterThan(0))
    const before = posted.at(-1)!
    expect(before.omittedNodeIds).toContain('live')
    expect(before.contentVersions?.live).toMatch(/^[a-f0-9]{64}$/)
    const load = vi.fn((id: string) =>
      Promise.resolve(service.fullNode('s', id, posted.at(-1)!.revision, new AbortController().signal)),
    )
    const hook = renderHook(
      ({ window }) =>
        useCompleteTranscriptNodes(
          's',
          window.nodes,
          window.omittedNodeIds,
          load,
          undefined,
          window.contentVersions,
        ),
      { initialProps: { window: before } },
    )
    await waitFor(() => expect(hook.result.current.pending).toBe(false))
    const firstBody = hook.result.current.nodes.find((n) => n.id === 'live')
    expect(firstBody).toHaveProperty('markdown', 'x'.repeat(5000000))
    service.acknowledge('s', before.revision)
    await act(async () => {
      service.accept({ type: 'message.delta', sessionId: 's', messageId: 'live', delta: 'x'.repeat(1024) })
      await Promise.resolve()
    })
    await waitFor(() => expect(posted.at(-1)!.revision).toBeGreaterThan(before.revision))
    const after = posted.at(-1)!
    expect(after.nodes).toEqual(before.nodes)
    expect(after.contentVersions?.live).not.toBe(before.contentVersions?.live)
    expect(service.fullNode('s', 'live', after.revision, new AbortController().signal)).toHaveProperty(
      'markdown',
      'x'.repeat(5001024),
    )
    await act(async () => {
      hook.rerender({ window: after })
      await Promise.resolve()
    })
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(hook.result.current.nodes.find((n) => n.id === 'live')).toHaveProperty(
      'markdown',
      'x'.repeat(5001024),
    )
  } finally {
    service.dispose()
  }
})
