// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { TranscriptWindow } from '@dsh-vscode/webview-protocol'
import { createInitialState } from '../../app/store/initial-state.js'
import { installTranscript } from '../../app/store/transcript-state.js'
import { useCompleteTranscriptNodes } from './useCompleteTranscriptNodes.js'

afterEach(cleanup)

it('clears a prior read failure while idle before another omitted body is requested', async () => {
  const nodes: readonly TimelineNode[] = [
    { kind: 'assistant-message', id: 'live', markdown: 'preview', streaming: true },
  ]
  const load = vi
    .fn<() => Promise<TimelineNode>>()
    .mockRejectedValueOnce(new Error('read failed'))
    .mockImplementation(() => new Promise(() => undefined))
  const { result, rerender } = renderHook(
    ({ omittedIds }: { omittedIds: string[] }) =>
      useCompleteTranscriptNodes('session', nodes, omittedIds, load),
    { initialProps: { omittedIds: ['live'] } },
  )
  await waitFor(() => expect(result.current.failed).toBe(true))
  await act(async () => {
    rerender({ omittedIds: [] })
    await Promise.resolve()
  })
  expect(result.current).toMatchObject({ pending: false, failed: false })
  await act(async () => {
    rerender({ omittedIds: ['live'] })
    await Promise.resolve()
  })
  expect(load).toHaveBeenCalledTimes(2)
  expect(result.current).toMatchObject({ pending: true, failed: false })
})

it('retains loaded full bodies without flashing pending across full reload, while refetching omitted nodes whose body fingerprint changed behind an identical preview', async () => {
  const sessionId = 'session-1'
  const baseWindow: TranscriptWindow = {
    sessionId,
    revision: 1,
    nodes: [
      { kind: 'assistant-message', id: 'stable-omitted', markdown: 'truncated-preview', streaming: false },
      { kind: 'assistant-message', id: 'mutated-omitted', markdown: 'truncated-preview', streaming: false },
    ],
    eventFacts: [],
    lastSequence: 2,
    hasMore: false,
    historical: false,
    omittedNodeIds: ['stable-omitted', 'mutated-omitted'],
    contentVersions: { 'stable-omitted': 'a'.repeat(64), 'mutated-omitted': 'b'.repeat(64) },
  }
  const state1 = installTranscript({ ...createInitialState({}), activeSessionId: sessionId }, baseWindow)

  let mutatedVersion = 1
  const load = vi.fn<(id: string) => Promise<TimelineNode>>((id) =>
    Promise.resolve({
      kind: 'assistant-message',
      id,
      markdown: id === 'stable-omitted' ? 'full-stable-body' : `full-mutated-body-v${mutatedVersion}`,
      streaming: false,
    }),
  )

  const { result, rerender } = renderHook(
    ({ window }: { window: TranscriptWindow }) =>
      useCompleteTranscriptNodes(
        sessionId,
        window.nodes,
        window.omittedNodeIds,
        load,
        undefined,
        window.contentVersions,
      ),
    { initialProps: { window: state1.transcript! } },
  )

  await waitFor(() => expect(result.current.pending).toBe(false))
  expect(load).toHaveBeenCalledTimes(2)
  expect(result.current.nodes).toEqual([
    { kind: 'assistant-message', id: 'stable-omitted', markdown: 'full-stable-body', streaming: false },
    { kind: 'assistant-message', id: 'mutated-omitted', markdown: 'full-mutated-body-v1', streaming: false },
  ])

  // Full reload where both omitted nodes still have identical truncated previews,
  // stable-omitted kept its fingerprint, and mutated-omitted acquired a new one:
  mutatedVersion = 2
  const reloadedWindow: TranscriptWindow = {
    ...baseWindow,
    revision: 2,
    nodes: [
      { kind: 'assistant-message', id: 'stable-omitted', markdown: 'truncated-preview', streaming: false },
      { kind: 'assistant-message', id: 'mutated-omitted', markdown: 'truncated-preview', streaming: false },
    ],
    contentVersions: { 'stable-omitted': 'a'.repeat(64), 'mutated-omitted': 'c'.repeat(64) },
  }
  const state2 = installTranscript(state1, reloadedWindow)

  rerender({ window: state2.transcript! })
  // stable-omitted must NOT enter pendingIds; mutated-omitted is pending while retaining its v1 body
  expect(result.current.pendingIds.has('stable-omitted')).toBe(false)
  expect(result.current.pendingIds.has('mutated-omitted')).toBe(true)

  await waitFor(() => expect(result.current.pending).toBe(false))
  // Only mutated-omitted was refetched (1 additional call, not 2)
  expect(load).toHaveBeenCalledTimes(3)
  expect(load).toHaveBeenLastCalledWith('mutated-omitted', expect.any(AbortSignal))
  expect(result.current.nodes).toEqual([
    { kind: 'assistant-message', id: 'stable-omitted', markdown: 'full-stable-body', streaming: false },
    { kind: 'assistant-message', id: 'mutated-omitted', markdown: 'full-mutated-body-v2', streaming: false },
  ])
})
