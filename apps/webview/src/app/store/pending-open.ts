import type { HostMessage } from '@dsh-vscode/webview-protocol'
import { isAdvisoryReplayMessage, orderPendingReplayMessages } from './history-replay.js'

export interface PendingSessionOpen {
  readonly version: number
  readonly sessionId: string
  /** Lossless until the authoritative open/advisory replay has committed. */
  readonly messages: HostMessage[]
  readonly messageKeys: Set<string>
  replayedMessages: number
  ready: boolean
}

export interface PendingOpenBuffer {
  readonly create: (sessionId: string, version: number) => PendingSessionOpen
  readonly settle: (pending: PendingSessionOpen, completed: boolean) => void
  /** Record one live event against the session's in-flight open; undefined when nothing buffers it. */
  readonly capture: (sessionId: string, message: HostMessage) => PendingSessionOpen | undefined
  readonly messagesAfterReplay: (pending: PendingSessionOpen) => readonly HostMessage[]
  readonly messagesFrom: (pending: PendingSessionOpen, startIndex: number) => readonly HostMessage[]
}

/**
 * Buffers the events that arrive while a session open is in flight. A pending
 * open owns its message list until it settles; whatever is left when it loses
 * the race is handed to the next open for the same session (or deferred until
 * one starts), so a superseded open cannot silently drop live records.
 */
export function createPendingOpenBuffer(readOpenVersion: () => number): PendingOpenBuffer {
  const pendingOpens = new Map<number, PendingSessionOpen>()
  const latestPendingOpen = new Map<string, PendingSessionOpen>()
  const deferredOpenMessages = new Map<string, HostMessage[]>()
  const deferredOpenMessageKeys = new Map<string, Set<string>>()
  const sameHostEvent = (left: HostMessage, right: HostMessage): boolean => {
    if (left.type !== 'event' || right.type !== 'event') return false
    if (left.sequence !== right.sequence) return false
    try {
      // Host sequence is the transport ordering key, not the durable DSH
      // identity. Keep two distinct events if a reconnect/replay ever reuses
      // one host slot; otherwise a valid projection/tool record can vanish
      // before the open barrier is released.
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  }
  const hostMessageIdentity = (message: HostMessage): string | undefined => {
    if (message.type !== 'event') return undefined
    try {
      return JSON.stringify(message)
    } catch {
      return undefined
    }
  }
  const hostMessageSequence = (message: HostMessage): number =>
    message.type === 'event' ? message.sequence : Number.MAX_SAFE_INTEGER
  const appendUniqueHostMessage = (
    messages: HostMessage[],
    messageKeys: Set<string>,
    message: HostMessage,
  ): void => {
    const identity = hostMessageIdentity(message)
    if (identity !== undefined) {
      if (messageKeys.has(identity)) return
      messageKeys.add(identity)
    } else if (messages.some((candidate) => sameHostEvent(candidate, message))) return
    messages.push(message)
  }
  const appendPendingMessage = (pending: PendingSessionOpen, message: HostMessage): void => {
    appendUniqueHostMessage(pending.messages, pending.messageKeys, message)
  }
  const defer = (sessionId: string, message: HostMessage): void => {
    const messages = deferredOpenMessages.get(sessionId) ?? []
    const messageKeys = deferredOpenMessageKeys.get(sessionId) ?? new Set<string>()
    appendUniqueHostMessage(messages, messageKeys, message)
    deferredOpenMessages.set(sessionId, messages)
    deferredOpenMessageKeys.set(sessionId, messageKeys)
  }
  const create = (sessionId: string, version: number): PendingSessionOpen => {
    const pending: PendingSessionOpen = {
      version,
      sessionId,
      messages: [],
      messageKeys: new Set(),
      replayedMessages: 0,
      ready: false,
    }
    const deferred = deferredOpenMessages.get(sessionId)
    if (deferred !== undefined) {
      for (const message of deferred) appendPendingMessage(pending, message)
      deferredOpenMessages.delete(sessionId)
      deferredOpenMessageKeys.delete(sessionId)
    }
    const previous = latestPendingOpen.get(sessionId)
    if (previous !== undefined)
      for (const message of previous.messages) appendPendingMessage(pending, message)
    pending.messages.sort((left, right) => hostMessageSequence(left) - hostMessageSequence(right))
    pendingOpens.set(version, pending)
    latestPendingOpen.set(sessionId, pending)
    return pending
  }
  const settle = (pending: PendingSessionOpen, completed: boolean): void => {
    pendingOpens.delete(pending.version)
    const latest = latestPendingOpen.get(pending.sessionId)
    const ownsLatest = latest === pending
    const keepMessages = !completed || !ownsLatest || pending.version !== readOpenVersion()
    if (keepMessages) {
      if (latest !== undefined && latest !== pending) {
        for (const message of pending.messages) appendPendingMessage(latest, message)
      } else {
        for (const message of pending.messages) defer(pending.sessionId, message)
      }
    }
    if (ownsLatest) latestPendingOpen.delete(pending.sessionId)
  }
  const capture = (sessionId: string, message: HostMessage): PendingSessionOpen | undefined => {
    const pending = latestPendingOpen.get(sessionId)
    if (pending !== undefined) appendPendingMessage(pending, message)
    return pending
  }
  const messagesAfterReplay = (pending: PendingSessionOpen): readonly HostMessage[] => {
    const messages = pending.messages.slice(pending.replayedMessages)
    pending.replayedMessages = pending.messages.length
    return orderPendingReplayMessages(messages)
  }
  const messagesFrom = (pending: PendingSessionOpen, startIndex: number): readonly HostMessage[] => {
    // Durable records are cursor-gated and control records are idempotent,
    // but cursorless assistant frames deliberately bypass that gate. They
    // were already reduced during first paint/live delivery; replaying them
    // after an advisory snapshot would apply a stale prefix over a settled
    // assistant because the matching durable completion is now <= the cursor.
    const messages = pending.messages.slice(startIndex).filter(isAdvisoryReplayMessage)
    pending.replayedMessages = pending.messages.length
    return orderPendingReplayMessages(messages)
  }

  return { create, settle, capture, messagesAfterReplay, messagesFrom }
}
