import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '@dsh-vscode/domain'

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_RESULT_LIMIT = 20

/**
 * The name filter applies instantly; the content search is the expensive host
 * round-trip, so it debounces behind the same query and drops stale responses
 * by sequence instead of by request cancellation.
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
    // Resetting the stale outputs before the next debounce is the state machine
    // here: the previous window's matches must not linger under a new query.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUnavailable(false)
    if (!open || query === '' || archiveFilter === 'archived') {
      setContentSearch({ query, matches: [], searchHasMore: false })
      return
    }
    const timer = window.setTimeout(() => {
      void onSearch(query)
        .then((page) => {
          if (searchSequence.current !== sequence) return
          setContentSearch({
            query,
            matches: page.items.slice(0, SEARCH_RESULT_LIMIT),
            searchHasMore: page.searchHasMore === true,
          })
          setUnavailable(false)
        })
        .catch(() => {
          if (searchSequence.current !== sequence) return
          // A refused content search leaves the name filter as the only result
          // source; reporting the empty list as "no matches" would claim the
          // host searched and found nothing.
          setContentSearch({ query, matches: [], searchHasMore: false })
          setUnavailable(true)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [archiveFilter, onSearch, open, query])

  return { contentSearch, unavailable }
}
