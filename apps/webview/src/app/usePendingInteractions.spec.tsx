// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest } from '@dsh-vscode/domain'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { AppStore } from './store.js'
import { createInitialState } from './store/initial-state.js'
import { translate } from '../i18n.js'
import { usePendingInteractions } from './usePendingInteractions.js'

afterEach(cleanup)
const command = 'START ' + 'x'.repeat(12_000) + ' FINAL_ARGUMENT'
const full: TimelineNode = {
  kind: 'tool',
  id: 'call',
  tool: {
    id: 'call',
    name: 'bash',
    category: 'terminal',
    title: 'bash',
    status: 'running',
    metadata: {},
    inputSummary: JSON.stringify({ command }),
    presentation: { phase: 'call', card: 'terminal', title: command },
  },
}
const preview: TimelineNode = {
  ...full,
  tool: { ...full.tool, presentation: { phase: 'call', card: 'terminal', title: 'START' } },
}
const permission: PermissionRequest = {
  id: 'permission',
  sessionId: 's1',
  title: 'bash',
  description: 'Approve this request?',
  callId: 'call',
  risk: 'unknown',
  options: [],
}
function parameters(
  load: AppStore['loadTranscriptNode'],
  nodes: readonly TimelineNode[],
): Parameters<typeof usePendingInteractions>[0] {
  const initial = createInitialState({})
  return {
    store: { loadTranscriptNode: load } as unknown as AppStore,
    state: {
      ...initial,
      permissions: [permission],
      timeline: { ...initial.timeline, nodes },
      transcript: {
        sessionId: 's1',
        revision: 1,
        nodes,
        lastSequence: 1,
        hasMore: false,
        historical: false,
        omittedNodeIds: ['call'],
        eventFacts: [],
      },
    },
    activeSessionId: 's1',
    setRespondingInteractionId: vi.fn(),
    setError: vi.fn(),
    t: translate,
  }
}

describe('complete approval content', () => {
  it('uses settled call identity instead of reviving a stale foreground request', () => {
    const props = parameters(vi.fn(), [])
    const question = {
      id: 'first',
      rpcId: 'rpc',
      callId: 'call-q',
      sessionId: 's1',
      prompt: 'Continue?',
      allowFreeText: true,
      timed: true,
      state: 'open' as const,
    }
    const { result } = renderHook(() =>
      usePendingInteractions({
        ...props,
        state: {
          ...props.state,
          questions: [question],
          projections: {
            s1: { userQuestions: { active: [], settled: [{ callId: 'call-q', answers: [] }] } },
          },
        },
      }),
    )
    expect(result.current.pendingQuestions).toEqual([])
  })
  it('does not reuse an off-window command after the backend connection changes', async () => {
    let resolve!: (node: TimelineNode) => void
    const second = new Promise<TimelineNode>((settle) => {
      resolve = settle
    })
    const load = vi
      .fn<AppStore['loadTranscriptNode']>()
      .mockResolvedValueOnce(full)
      .mockReturnValueOnce(second)
    const props = parameters(load, [])
    const { result, rerender } = renderHook((current) => usePendingInteractions(current), {
      initialProps: props,
    })
    await waitFor(() =>
      expect(result.current.pendingPermissions[0]).toMatchObject({ command, contentPending: false }),
    )
    rerender({ ...props, state: { ...props.state, connectionEpoch: (props.state.connectionEpoch ?? 0) + 1 } })
    expect(result.current.pendingPermissions[0]?.contentPending).toBe(true)
    expect(result.current.pendingPermissions[0]?.command).toBeUndefined()
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolve({
        ...full,
        tool: {
          ...full.tool,
          presentation: { phase: 'call', card: 'terminal', title: 'NEW_BACKEND_COMMAND' },
        },
      })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(result.current.pendingPermissions[0]).toMatchObject({
        command: 'NEW_BACKEND_COMMAND',
        contentPending: false,
      }),
    )
  })

  it.each(['clipped', 'outside-window'] as const)(
    'automatically completes a %s command before enabling approval',
    async (location) => {
      let resolve!: (node: TimelineNode) => void
      const load = vi.fn<AppStore['loadTranscriptNode']>(
        () =>
          new Promise((settle) => {
            resolve = settle
          }),
      )
      const props = parameters(load, location === 'clipped' ? [preview] : [])
      const { result } = renderHook(() => usePendingInteractions(props))
      expect(result.current.pendingPermissions[0]?.contentPending).toBe(true)
      await waitFor(() => expect(load).toHaveBeenCalledWith('call', expect.any(AbortSignal)))
      await act(async () => {
        resolve(full)
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(result.current.pendingPermissions[0]).toMatchObject({
          command,
          contentPending: false,
          contentFailed: false,
        }),
      )
    },
  )

  it('retries a failed complete-request read without requiring another user action', async () => {
    const load = vi
      .fn<AppStore['loadTranscriptNode']>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(full)
    const props = parameters(load, [preview])
    const { result } = renderHook(() => usePendingInteractions(props))
    await waitFor(() => expect(result.current.pendingPermissions[0]?.contentFailed).toBe(true))
    await waitFor(
      () => expect(result.current.pendingPermissions[0]).toMatchObject({ command, contentPending: false }),
      { timeout: 2_000 },
    )
    expect(load).toHaveBeenCalledTimes(2)
  })
})
