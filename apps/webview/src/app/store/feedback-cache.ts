import type { ProtocolClient } from '../protocol-client.js'
import { feedbackRecord } from './feature-parsers.js'
import { safeFeedbackList } from './session-registry.js'
import type { FeedbackListResult } from './session-registry.js'
import type { AppState, StateSetter } from './types.js'

/**
 * Feedback is an advisory first-paint read, but a mutation must never race
 * that read with an empty CAS cache. Share the in-flight request and remember
 * successful seeds so a cold row can wait for the same authoritative catalog
 * without issuing a second list call.
 */
export function createFeedbackCache({
  client,
  setState,
  getState,
}: {
  client: ProtocolClient
  setState: StateSetter
  getState: () => AppState
}): {
  invalidate: () => void
  forget: (sessionId: string) => void
  isReady: (sessionId: string) => boolean
  requestFeedbackSnapshot: (sessionId: string, force?: boolean) => Promise<FeedbackListResult>
  applyFeedbackSnapshot: (sessionId: string, result: FeedbackListResult) => void
} {
  const feedbackLoads = new Map<string, Promise<FeedbackListResult>>()
  const feedbackReadySessions = new Set<string>()
  let feedbackGeneration = 0
  const invalidate = (): void => {
    feedbackGeneration += 1
    feedbackLoads.clear()
    feedbackReadySessions.clear()
  }
  const forget = (sessionId: string): void => {
    feedbackReadySessions.delete(sessionId)
  }
  const isReady = (sessionId: string): boolean => feedbackReadySessions.has(sessionId)
  const requestFeedbackSnapshot = (sessionId: string, force = false): Promise<FeedbackListResult> => {
    if (force) feedbackReadySessions.delete(sessionId)
    if (!force && feedbackReadySessions.has(sessionId) && getState().activeSessionId === sessionId) {
      const state = getState()
      return Promise.resolve({
        items: Object.values(state.feedback),
        unavailable: state.feedbackUnavailable === true,
      })
    }
    const existing = feedbackLoads.get(sessionId)
    if (existing !== undefined) return existing
    const generation = feedbackGeneration
    const pending = safeFeedbackList(client, sessionId).then((result) => {
      if (generation === feedbackGeneration && (result.items !== undefined || result.unavailable === true))
        feedbackReadySessions.add(sessionId)
      return result
    })
    feedbackLoads.set(sessionId, pending)
    void pending.finally(() => {
      if (feedbackLoads.get(sessionId) === pending) feedbackLoads.delete(sessionId)
    })
    return pending
  }
  const applyFeedbackSnapshot = (sessionId: string, result: FeedbackListResult): void => {
    setState((current) => {
      if (current.activeSessionId !== sessionId) return current
      return {
        ...current,
        ...(result.items === undefined ? {} : { feedback: feedbackRecord(result.items) }),
        ...(result.unavailable === undefined ? {} : { feedbackUnavailable: result.unavailable }),
      }
    })
  }
  return { invalidate, forget, isReady, requestFeedbackSnapshot, applyFeedbackSnapshot }
}
