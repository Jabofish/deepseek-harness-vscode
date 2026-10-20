import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'

/** Transport limits never become presentation limits. Refresh live bodies
 * automatically, retaining the last complete body while a newer one arrives. */
export function useCompleteTranscriptNodes(
  sessionId: string,
  nodes: readonly TimelineNode[],
  omittedIds: readonly string[] | undefined,
  load: ((id: string, signal?: AbortSignal) => Promise<TimelineNode>) | undefined,
): { readonly nodes: readonly TimelineNode[]; readonly pending: boolean; readonly failed: boolean } {
  const [loaded, setLoaded] = useState<{
    readonly sessionId: string
    readonly values: ReadonlyMap<string, { readonly source: TimelineNode; readonly node: TimelineNode }>
  }>({ sessionId, values: new Map() })
  const [failed, setFailed] = useState({ sessionId, value: false })
  const wake = useRef<(() => void) | undefined>(undefined)
  const latest = useRef({ sessionId, nodes, omittedIds, load })
  useLayoutEffect(() => {
    latest.current = { sessionId, nodes, omittedIds, load }
  }, [sessionId, nodes, omittedIds, load])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let retry = 0
    let running = false
    const values = new Map<string, { source: TimelineNode; node: TimelineNode }>()
    let initialized = false
    const refresh = async (): Promise<void> => {
      if (controller.signal.aborted || running) return
      running = true
      await Promise.resolve()
      if (controller.signal.aborted) return
      const current = latest.current
      if (current.sessionId !== sessionId) return
      const omitted = new Set(current.omittedIds)
      const sources = new Map(current.nodes.map((node) => [node.id, node]))
      const before = values.size
      for (const id of values.keys()) if (!omitted.has(id) || !sources.has(id)) values.delete(id)
      if (!initialized || before !== values.size) setLoaded({ sessionId, values: new Map(values) })
      initialized = true
      let requestFailed = false
      for (const id of omitted) {
        const source = sources.get(id)
        if (source === undefined || values.get(id)?.source === source) continue
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
      const pending = next.nodes.some(
        (node) => next.omittedIds?.includes(node.id) === true && values.get(node.id)?.source !== node,
      )
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
  }, [nodes, omittedIds, load])

  return useMemo(() => {
    const omitted = new Set(omittedIds)
    const values =
      loaded.sessionId === sessionId
        ? loaded.values
        : new Map<string, { readonly source: TimelineNode; readonly node: TimelineNode }>()
    let pending = false
    let changed = false
    const complete = nodes.map((node) => {
      if (!omitted.has(node.id)) return node
      const value = values.get(node.id)
      if (value?.source !== node) pending = true
      if (value === undefined) return node
      changed = true
      return value.node
    })
    return {
      nodes: changed ? complete : nodes,
      pending,
      failed: pending && failed.sessionId === sessionId && failed.value,
    }
  }, [failed, loaded, nodes, omittedIds, sessionId])
}
