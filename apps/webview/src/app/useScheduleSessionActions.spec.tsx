// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Translate } from '../i18n.js'
import type { AppStore } from './store.js'
import { useScheduleSessionActions } from './useScheduleSessionActions.js'

const t: Translate = (key) => key

function storeWith(
  activeSessionId: string | undefined,
  createdId: string | undefined,
): {
  readonly store: AppStore
  readonly sendPrompt: ReturnType<typeof vi.fn>
  readonly watch: ReturnType<typeof vi.fn>
} {
  const sendPrompt = vi.fn().mockResolvedValue(undefined)
  const watch = vi.fn(() => ({ completion: Promise.resolve(), dispose: vi.fn() }))
  const store = {
    createSession: vi.fn().mockResolvedValue(createdId),
    getState: () => ({ activeSessionId, backend: { kind: 'connected' } }),
    watchSessionTurnEnd: watch,
    sendPrompt,
  } as unknown as AppStore
  return { store, sendPrompt, watch }
}

describe('schedule session start', () => {
  it('sends to the session it created even if navigation superseded its open', async () => {
    const { store, sendPrompt, watch } = storeWith('previous-session', 'created-session')
    const { result } = renderHook(() =>
      useScheduleSessionActions({ store, workspaceId: 'w1', setError: vi.fn(), t }),
    )

    await expect(result.current.onStartSession('create the schedule')).resolves.toBe('created-session')
    expect(sendPrompt).toHaveBeenCalledWith('created-session', 'create the schedule', [], 'queue')
    expect(watch).toHaveBeenCalledWith('created-session')
  })

  it('rejects instead of falling back to the ambient conversation when creation returns no id', async () => {
    const { store, sendPrompt } = storeWith('previous-session', undefined)
    const { result } = renderHook(() =>
      useScheduleSessionActions({ store, workspaceId: 'w1', setError: vi.fn(), t }),
    )

    await expect(result.current.onStartSession('create the schedule')).rejects.toThrow(
      'schedules.createSessionFailed',
    )
    expect(sendPrompt).not.toHaveBeenCalled()
  })
})
