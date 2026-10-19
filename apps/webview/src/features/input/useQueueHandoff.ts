import { useState } from 'react'
import type { QueuedInput } from '@dsh-vscode/domain'
import type { TranscriptWindow } from '@dsh-vscode/webview-protocol'

/** A display receipt only: never resends input or adds invented transcript nodes. */
export function useQueueHandoff(
  items: readonly QueuedInput[],
  transcript: TranscriptWindow | undefined,
  connected: boolean,
): {
  readonly pending: readonly QueuedInput[]
  readonly confirmed: ReadonlySet<string>
  readonly markRemoval: (id: string) => void
  readonly rejectRemoval: (id: string) => void
  readonly dismiss: (id: string) => void
} {
  const [previous, setPrevious] = useState({
    items,
    pending: [] as readonly QueuedInput[],
    removals: new Set<string>(),
  })
  const confirmed = new Set(
    items.length + previous.items.length + previous.pending.length === 0
      ? []
      : transcript?.nodes.filter((node) => node.kind === 'user-message').map((node) => node.id),
  )
  const currentIds = new Set(items.map((item) => item.id))
  let pending = previous.pending.filter(
    (item) => connected && !confirmed.has(item.id) && !currentIds.has(item.id),
  )
  if (previous.items !== items) {
    const pendingIds = new Set(pending.map((item) => item.id))
    if (connected && transcript !== undefined)
      for (const item of previous.items) {
        if (
          item.sessionId === transcript.sessionId &&
          !currentIds.has(item.id) &&
          !confirmed.has(item.id) &&
          !previous.removals.has(item.id) &&
          !pendingIds.has(item.id)
        )
          pending.push(item)
      }
    // Bound display-only receipts even if an upstream never publishes admission.
    pending = pending.slice(-200)
    const removals = new Set([...previous.removals].filter((id) => currentIds.has(id)))
    setPrevious({ items, pending, removals })
  } else if (pending.length !== previous.pending.length) {
    setPrevious({ ...previous, items, pending })
  }
  return {
    pending,
    confirmed,
    markRemoval: (id) =>
      setPrevious((current) => ({ ...current, removals: new Set([...current.removals, id]) })),
    rejectRemoval: (id) =>
      setPrevious((current) => ({
        ...current,
        removals: new Set([...current.removals].filter((entry) => entry !== id)),
      })),
    dismiss: (id) =>
      setPrevious((current) => ({ ...current, pending: current.pending.filter((item) => item.id !== id) })),
  }
}
