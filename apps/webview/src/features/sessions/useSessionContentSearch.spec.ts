// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionContentSearch } from './useSessionContentSearch.js'

afterEach(() => vi.useRealTimers())

describe('Session content search dispatch', () => {
  it('starts immediately and ignores old results, failures and closed searches', async () => {
    vi.useFakeTimers()
    const reads = new Map<
      string,
      { resolve: (value: { items: [] }) => void; reject: (reason: Error) => void }
    >()
    const onSearch = vi.fn(
      (query: string) =>
        new Promise<{ items: [] }>((resolve, reject) => {
          reads.set(query, { resolve, reject })
        }),
    )
    const { result, rerender } = renderHook(
      ({ query, open }) =>
        useSessionContentSearch({
          query,
          open,
          archiveFilter: 'active',
          onSearch,
        }),
      { initialProps: { query: 'old', open: true } },
    )
    expect(onSearch).toHaveBeenCalledWith('old')
    rerender({ query: 'new', open: true })
    expect(onSearch).toHaveBeenCalledWith('new')
    await act(async () => {
      reads.get('new')!.resolve({ items: [] })
      await Promise.resolve()
    })
    expect(result.current.contentSearch.query).toBe('new')
    await act(async () => {
      reads.get('old')!.reject(new Error('stale failure'))
      await Promise.resolve()
    })
    expect(result.current.unavailable).toBe(false)
    expect(result.current.contentSearch.query).toBe('new')
    rerender({ query: 'closed', open: true })
    expect(onSearch).toHaveBeenCalledWith('closed')
    rerender({ query: 'closed', open: false })
    await act(async () => {
      reads.get('closed')!.resolve({ items: [] })
      await Promise.resolve()
    })
    expect(result.current.contentSearch).toEqual({ query: 'closed', matches: [], searchHasMore: false })
    expect(result.current.unavailable).toBe(false)
  })
})
