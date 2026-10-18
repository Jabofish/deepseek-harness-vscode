// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComposerSubmit } from './useComposerSubmit.js'

afterEach(() => vi.useRealTimers())

describe('Composer submission settlement', () => {
  it.each(['submit', 'steer'] as const)(
    'releases synchronous %s after settlement without a cooldown',
    async (action) => {
      vi.useFakeTimers()
      const onSubmit = vi.fn()
      const onSteerQueue = vi.fn()
      const { result, unmount } = renderHook(() =>
        useComposerSubmit({
          disabled: false,
          inputBlocked: false,
          draft: 'Follow up',
          attachments: [],
          onSubmit,
          onSteerQueue,
        }),
      )
      const invoke = (): void => {
        if (action === 'submit') result.current.submit('queue')
        else result.current.steerQueuedInputs()
      }
      const callback = action === 'submit' ? onSubmit : onSteerQueue
      act(() => {
        invoke()
        invoke()
      })
      expect(callback).toHaveBeenCalledTimes(1)
      await act(async () => {
        await Promise.resolve()
      })
      act(invoke)
      expect(callback).toHaveBeenCalledTimes(2)
      await act(async () => {
        await Promise.resolve()
      })
      unmount()
    },
  )
})
