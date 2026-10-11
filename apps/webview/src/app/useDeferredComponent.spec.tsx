// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import type { ComponentType, ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useDeferredComponent } from './useDeferredComponent.js'

function Panel(): ReactElement {
  return <div>Settings</div>
}

describe('deferred view lifecycle', () => {
  it('loads on first intent and keeps the same component across closing and reopening', async () => {
    const load = vi.fn(() => Promise.resolve(Panel))
    const { result, rerender } = renderHook(({ active }) => useDeferredComponent(active, load), {
      initialProps: { active: false },
    })
    expect(load).not.toHaveBeenCalled()

    rerender({ active: true })
    await waitFor(() => expect(result.current.Component).toBe(Panel))
    rerender({ active: false })
    expect(result.current.Component).toBe(Panel)
    rerender({ active: true })
    expect(result.current.Component).toBe(Panel)
    expect(load).toHaveBeenCalledOnce()
  })

  it('does not apply a late load after the view was closed', async () => {
    let complete!: (component: ComponentType) => void
    const pending = new Promise<ComponentType>((resolve) => {
      complete = resolve
    })
    const load = vi.fn(() => pending)
    const { result, rerender } = renderHook(({ active }) => useDeferredComponent(active, load), {
      initialProps: { active: true },
    })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    rerender({ active: false })
    await act(async () => {
      complete(Panel)
      await pending
    })
    expect(result.current.Component).toBeUndefined()

    rerender({ active: true })
    await waitFor(() => expect(result.current.Component).toBe(Panel))
  })

  it.each(['throw', 'reject'] as const)('allows explicit retry after a loader %s', async (failure) => {
    const load = vi
      .fn<() => Promise<ComponentType>>()
      .mockImplementationOnce(() => {
        if (failure === 'throw') throw new Error('Unavailable chunk')
        return Promise.reject(new Error('Unavailable chunk'))
      })
      .mockResolvedValue(Panel)
    const { result } = renderHook(() => useDeferredComponent(true, load))
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.Component).toBeUndefined()
    expect(load).toHaveBeenCalledOnce()

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.Component).toBe(Panel))
    expect(result.current.failed).toBe(false)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
