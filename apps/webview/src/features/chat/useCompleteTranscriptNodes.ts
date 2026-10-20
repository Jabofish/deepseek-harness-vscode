import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'

/** Transport limits never become presentation limits. Refresh live bodies
 * automatically, retaining the last complete body while a newer one arrives. */
export function useCompleteTranscriptNodes(
  sessionId: string,
  nodes: readonly TimelineNode[],
  omittedIds: readonly string[] | undefined,
  load: ((id: string, signal?: AbortSignal) => Promise<TimelineNode>) | undefined,
  requiredIds?: readonly string[],
): {
  readonly nodes: readonly TimelineNode[]
  readonly pending: boolean
  readonly pendingIds: ReadonlySet<string>
  readonly failed: boolean
} {
  const [loaded, setLoaded] = useState<{
    readonly sessionId: string
    readonly values: ReadonlyMap<
      string,
      { readonly source: TimelineNode | undefined; readonly node: TimelineNode }
    >
  }>({ sessionId, values: new Map() })
  const [failed, setFailed] = useState({ sessionId, value: false })
  const wake = useRef<(() => void) | undefined>(undefined)
  const latest = useRef({ sessionId, nodes, omittedIds, load, requiredIds })
  useLayoutEffect(() => {
    latest.current = { sessionId, nodes, omittedIds, load, requiredIds }
  }, [sessionId, nodes, omittedIds, load, requiredIds])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let retry = 0
    let running = false
    const values = new Map<string, { source: TimelineNode | undefined; node: TimelineNode }>()
    let initialized = false
    const refresh = async (): Promise<void> => {
      if (controller.signal.aborted || running) return
      running = true
      await Promise.resolve()
      if (controller.signal.aborted) return
      const current = latest.current
      if (current.sessionId !== sessionId) return
      const required = new Set(current.requiredIds)
      const omitted = new Set([...(current.omittedIds ?? []), ...required])
      const sources = new Map(current.nodes.map((node) => [node.id, node]))
      const before = values.size
      for (const id of values.keys())
        if (!omitted.has(id) || (!sources.has(id) && !required.has(id))) values.delete(id)
      if (!initialized || before !== values.size) setLoaded({ sessionId, values: new Map(values) })
      initialized = true
      let requestFailed = false
      for (const id of omitted) {
        const source = sources.get(id)
        if ((!sources.has(id) && !required.has(id)) || (values.has(id) && values.get(id)?.source === source))
          continue
        // Required ids already represented by an intact transport node need no read.
        if (source !== undefined && current.omittedIds?.includes(id) !== true) continue
        try {
          if (current.load === undefined) throw new Error('Transcript reader unavailable')
          const node = await current.load(id, controller.signal)
          if (controller.signal.aborted || latest.current.sessionId !== sessionId) return
          if (node.id !== id) throw new Error('Unexpected transcript node')
          values.set(id, { source, node })
          setLoaded({ sessionId, values: new Map(values) })
        } catch {
          if (controller.signal.aborted) return
          requestFailed = true
        }
      }
      if (controller.signal.aborted) return
      setFailed({ sessionId, value: requestFailed })
      retry = requestFailed ? Math.min(retry + 1, 5) : 0
      running = false
      const next = latest.current
      const pending =
        next.nodes.some(
          (node) => next.omittedIds?.includes(node.id) === true && values.get(node.id)?.source !== node,
        ) ||
        next.requiredIds?.some((id) => !next.nodes.some((node) => node.id === id) && !values.has(id)) === true
      if (pending)
        timer = setTimeout(
          () => {
            void refresh()
          },
          requestFailed ? 250 * 2 ** retry : 0,
        )
    }
    wake.current = () => {
      if (timer !== undefined) clearTimeout(timer)
      void refresh()
    }
    void refresh()
    return () => {
      wake.current = undefined
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [sessionId])

  useEffect(() => {
    wake.current?.()
  }, [nodes, omittedIds, load, requiredIds])

  return useMemo(() => {
    const omitted = new Set(omittedIds)
    const values =
      loaded.sessionId === sessionId
        ? loaded.values
        : new Map<string, { readonly source: TimelineNode | undefined; readonly node: TimelineNode }>()
    const pendingIds = new Set<string>()
    let changed = false
    const complete = nodes.map((node) => {
      if (!omitted.has(node.id)) return node
      const value = values.get(node.id)
      if (value?.source !== node) pendingIds.add(node.id)
      if (value === undefined) return node
      changed = true
      return value.node
    })
    for (const id of requiredIds ?? []) {
      if (nodes.some((node) => node.id === id)) continue
      const value = values.get(id)
      if (value === undefined) pendingIds.add(id)
      else {
        complete.push(value.node)
        changed = true
      }
    }
    const pending = pendingIds.size > 0
    return {
      nodes: changed ? complete : nodes,
      pending,
      pendingIds,
      failed: pending && failed.sessionId === sessionId && failed.value,
    }
  }, [failed, loaded, nodes, omittedIds, requiredIds, sessionId])
}
