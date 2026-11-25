import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@dsh-vscode/domain'

const SEARCH_RESULT_LIMIT = 20
const RAPID_SEARCH_DEBOUNCE_MS = 120

/**
 * Dispatch content searches immediately on a quiet input and debounce rapid
 * consecutive keystrokes so typing does not flood the Host with RPCs. Retired
 * requests cannot replace the current results or publish errors after closing.
 */
export function useSessionContentSearch(options: {
  open: boolean
  query: string
  archiveFilter: string
  onSearch: (query: string) => Promise<{ items: readonly SessionSummary[]; searchHasMore?: boolean }>
}): {
  contentSearch: {
    readonly query: string
    readonly matches: readonly SessionSummary[]
    readonly searchHasMore: boolean
  }
  unavailable: boolean
  pending: boolean
} {
  const { open, query, archiveFilter, onSearch } = options
  // Query text alone does not identify a read: reopening a drawer or changing
  // its search source requires a fresh result even when the text is unchanged.
  const request = useMemo(
    () => ({ open, query, archiveFilter, onSearch }),
    [open, query, archiveFilter, onSearch],
  )
  const [result, setResult] = useState<{
    readonly request: typeof request
    readonly matches: readonly SessionSummary[]
    readonly searchHasMore: boolean
    readonly unavailable: boolean
  }>()
  const lastDispatchRef = useRef<{ readonly at: number; readonly query: string } | undefined>(undefined)
  const enabled = open && query !== '' && archiveFilter !== 'archived'

  useEffect(() => {
    if (!enabled) {
      lastDispatchRef.current = undefined
      return
    }
    let retired = false
    const search = async (): Promise<void> => {
      lastDispatchRef.current = { at: Date.now(), query: request.query }
      try {
        const page = await request.onSearch(request.query)
        if (retired) return
        setResult({
          request,
          matches: page.items.slice(0, SEARCH_RESULT_LIMIT),
          searchHasMore: page.searchHasMore === true || page.items.length > SEARCH_RESULT_LIMIT,
          unavailable: false,
        })
      } catch {
        if (retired) return
        // A refused content search leaves the name filter as the only result
        // source; reporting the empty list as "no matches" would claim the
        // host searched and found nothing.
        setResult({ request, matches: [], searchHasMore: false, unavailable: true })
      }
    }
    const previous = lastDispatchRef.current
    const rapidFollowup =
      previous !== undefined &&
      previous.query !== request.query &&
      Date.now() - previous.at < RAPID_SEARCH_DEBOUNCE_MS
    if (!rapidFollowup) {
      void search()
      return () => {
        retired = true
      }
    }
    const timer = window.setTimeout(() => {
      void search()
    }, RAPID_SEARCH_DEBOUNCE_MS)
    return () => {
      retired = true
      window.clearTimeout(timer)
    }
  }, [enabled, request])

  const current = enabled && result?.request === request ? result : undefined
  return {
    contentSearch: { query, matches: current?.matches ?? [], searchHasMore: current?.searchHasMore === true },
    unavailable: current?.unavailable === true,
    pending: enabled && current === undefined,
  }
}
