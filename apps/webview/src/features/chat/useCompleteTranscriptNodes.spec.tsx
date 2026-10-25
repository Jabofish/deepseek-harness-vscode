// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
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
