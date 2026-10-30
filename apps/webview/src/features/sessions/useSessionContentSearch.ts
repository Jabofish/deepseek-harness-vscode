import { useEffect, useMemo, useState } from 'react'
import type { SessionSummary } from '@dsh-vscode/domain'

const SEARCH_RESULT_LIMIT = 20

/**
 * Dispatch content searches as soon as the query changes. Retired requests
 * cannot replace the current results or publish errors after the drawer closes.
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
  const enabled = open && query !== '' && archiveFilter !== 'archived'

  useEffect(() => {
    if (!enabled) return
    let retired = false
    const search = async (): Promise<void> => {
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
    void search()
    return () => {
      retired = true
    }
  }, [enabled, request])

  const current = enabled && result?.request === request ? result : undefined
  return {
    contentSearch: { query, matches: current?.matches ?? [], searchHasMore: current?.searchHasMore === true },
    unavailable: current?.unavailable === true,
    pending: enabled && current === undefined,
  }
}
