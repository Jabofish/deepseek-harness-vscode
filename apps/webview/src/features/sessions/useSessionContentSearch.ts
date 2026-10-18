import { useEffect, useRef, useState } from 'react'
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
} {
  const { open, query, archiveFilter, onSearch } = options
  const [contentSearch, setContentSearch] = useState<{
    readonly query: string
    readonly matches: readonly SessionSummary[]
    readonly searchHasMore: boolean
  }>({ query: '', matches: [], searchHasMore: false })
  const [unavailable, setUnavailable] = useState(false)
  const searchSequence = useRef(0)

  useEffect(() => {
    const sequence = searchSequence.current + 1
    searchSequence.current = sequence
    // The previous query's failure must not linger under a new query.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUnavailable(false)
    if (!open || query === '' || archiveFilter === 'archived') {
      setContentSearch({ query, matches: [], searchHasMore: false })
      return
    }
    let retired = false
    void onSearch(query)
      .then((page) => {
        if (retired || searchSequence.current !== sequence) return
        setContentSearch({
          query,
          matches: page.items.slice(0, SEARCH_RESULT_LIMIT),
          searchHasMore: page.searchHasMore === true,
        })
        setUnavailable(false)
      })
      .catch(() => {
        if (retired || searchSequence.current !== sequence) return
        // A refused content search leaves the name filter as the only result
        // source; reporting the empty list as "no matches" would claim the
        // host searched and found nothing.
        setContentSearch({ query, matches: [], searchHasMore: false })
        setUnavailable(true)
      })
    return () => {
      retired = true
    }
  }, [archiveFilter, onSearch, open, query])

  return { contentSearch, unavailable }
}
