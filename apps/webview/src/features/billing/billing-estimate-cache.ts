import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { BillingDisplayCurrency } from '@dsh-vscode/domain'
import {
  billingEstimateResponseSchema,
  type BillingEstimateResponse,
  type FeatureHostEvent,
} from '@dsh-vscode/webview-protocol'
import { requestId } from '../../app/store/ids.js'
import type { BillingClient } from './billing-client.js'

interface Snapshot {
  readonly estimate?: BillingEstimateResponse['estimate']
  readonly failed: boolean
  readonly refreshing: boolean
}
interface Entry {
  readonly group: string
  readonly listeners: Set<() => void>
  snapshot: Snapshot
  expires: number
  settledAt: number
  readonly getSnapshot: () => Snapshot
  readonly subscribe: (listener: () => void) => () => void
  readonly refresh: (force?: boolean) => void
  readonly stop: () => void
}
interface ClientCache {
  readonly entries: Map<string, Entry>
  lastChange?: FeatureHostEvent
}
const clients = new WeakMap<BillingClient, ClientCache>()

/** Labels and transient details share one bounded cache, isolated by connection and session. */
export function useBillingEstimate(
  request: BillingClient,
  subscribe: (listener: (event: FeatureHostEvent) => void) => () => void,
  scope: string,
  sessionId: string,
  usageKey: string,
  currency: BillingDisplayCurrency,
): Snapshot & { readonly refresh: () => void; readonly refreshIfStale: () => void } {
  const cache = useMemo(() => {
    let value = clients.get(request)
    if (value === undefined) {
      value = { entries: new Map() }
      clients.set(request, value)
    }
    return value
  }, [request])
  const entry = useMemo(
    () => entryFor(cache, request, scope, sessionId, usageKey, currency),
    [cache, request, scope, sessionId, usageKey, currency],
  )
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot)
  useEffect(
    () =>
      subscribe((event) => {
        if (event.name !== 'billing.settings.changed' || cache.lastChange === event) return
        cache.lastChange = event
        for (const [key, current] of cache.entries) {
          current.stop()
          current.expires = 0
          if (current.listeners.size === 0) cache.entries.delete(key)
          else current.refresh()
        }
      }),
    [cache, subscribe],
  )
  return { ...snapshot, refresh: () => entry.refresh(true), refreshIfStale: () => entry.refresh() }
}

function entryFor(
  cache: ClientCache,
  request: BillingClient,
  scope: string,
  sessionId: string,
  usageKey: string,
  currency: BillingDisplayCurrency,
): Entry {
  const group = JSON.stringify([scope, sessionId, currency])
  const key = JSON.stringify([group, usageKey])
  const found = cache.entries.get(key)
  if (found !== undefined) return found
  let previous: Entry | undefined
  for (const candidate of cache.entries.values()) {
    if (
      candidate.group === group &&
      candidate.snapshot.estimate !== undefined &&
      (previous === undefined || candidate.settledAt > previous.settledAt)
    )
      previous = candidate
  }
  let pending: string | undefined
  let timer: number | undefined
  const entry: Entry = {
    group,
    listeners: new Set(),
    expires: 0,
    settledAt: 0,
    snapshot:
      previous === undefined
        ? { failed: false, refreshing: false }
        : {
            estimate: previous.snapshot.estimate!,
            failed: false,
            refreshing: true,
          },
    getSnapshot: () => entry.snapshot,
    subscribe: (listener) => {
      entry.listeners.add(listener)
      refresh()
      return () => {
        entry.listeners.delete(listener)
        // Resizing moves the same reading between slots in one React commit.
        queueMicrotask(() => {
          if (entry.listeners.size === 0) stop()
        })
      }
    },
    refresh,
    stop,
  }
  function publish(value: Snapshot): void {
    entry.snapshot = value
    for (const listener of entry.listeners) listener()
  }
  function stop(): void {
    window.clearTimeout(timer)
    timer = undefined
    const id = pending
    pending = undefined
    if (id !== undefined)
      void request({
        type: 'feature.request.cancel',
        requestId: requestId(),
        payload: { targetRequestId: id },
      }).catch(() => undefined)
    if (entry.snapshot.refreshing) publish({ ...entry.snapshot, refreshing: false })
  }
  function refresh(force = false): void {
    if (
      entry.listeners.size === 0 ||
      pending !== undefined ||
      timer !== undefined ||
      (!force && entry.expires > Date.now())
    )
      return
    publish({ ...entry.snapshot, failed: false, refreshing: true })
    timer = window.setTimeout(() => {
      timer = undefined
      const id = requestId()
      pending = id
      void request({ type: 'billing.estimate', requestId: id, payload: { sessionId, currency } })
        .then((value) => {
          if (pending !== id) return
          const result = billingEstimateResponseSchema.parse(value)
          if (result.estimate.sessionId !== sessionId) throw new Error('Invalid billing response')
          entry.settledAt = Date.now()
          entry.expires = entry.settledAt + 5 * 60_000
          publish({ estimate: result.estimate, failed: false, refreshing: false })
        })
        .catch(() => {
          if (pending !== id) return
          entry.expires = Date.now() + 30_000
          publish({ ...entry.snapshot, failed: true, refreshing: false })
        })
        .finally(() => {
          if (pending === id) pending = undefined
        })
    }, 200)
  }
  cache.entries.set(key, entry)
  for (const [oldKey, old] of cache.entries) {
    if (cache.entries.size <= 32) break
    if (old !== entry && old.listeners.size === 0) {
      old.stop()
      cache.entries.delete(oldKey)
    }
  }
  return entry
}
