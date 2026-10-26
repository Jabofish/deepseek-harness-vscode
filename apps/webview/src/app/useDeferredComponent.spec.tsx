// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ComponentType, ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDeferredComponent } from './useDeferredComponent.js'

function Panel(): ReactElement {
  return <div>Settings</div>
}

afterEach(cleanup)

describe('deferred view lifecycle', () => {
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

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.Component).toBeDefined())
    const LoadedPanel = result.current.Component
    if (LoadedPanel === undefined) throw new Error('Retry did not load the panel')
    render(<LoadedPanel />)
    expect(screen.getByText('Settings')).toBeDefined()
    expect(result.current.failed).toBe(false)
  })
})
