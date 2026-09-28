import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { isMessageFeedbackItem } from './feature-parsers.js'
import { isFeedbackCapabilityUnavailable } from './session-registry.js'
import { object } from './unknown-record.js'
import type { AppActions, AppState, StateSetter } from './types.js'
import type { createFeedbackCache } from './feedback-cache.js'

export interface FeedbackActionHost {
  readonly client: ProtocolClient
  readonly setState: StateSetter
  readonly getState: () => AppState
  readonly feedbackCache: ReturnType<typeof createFeedbackCache>
}

export type FeedbackActionMethods = Pick<
  AppActions,
  | 'loadFeedback'
  | 'ensureFeedback'
  | 'toggleFeedback'
  | 'submitFeedback'
  | 'setFeedbackNote'
  | 'removeFeedback'
>

export function createFeedbackActions({
  client,
  setState,
  getState,
  feedbackCache,
}: FeedbackActionHost): FeedbackActionMethods {
  const { requestFeedbackSnapshot, applyFeedbackSnapshot } = feedbackCache
  return {
    loadFeedback: async (sessionId) => {
      applyFeedbackSnapshot(sessionId, await requestFeedbackSnapshot(sessionId, true))
    },
    ensureFeedback: async (sessionId, messageId) => {
      const alreadyReady = feedbackCache.isReady(sessionId) && getState().activeSessionId === sessionId
      const result = await requestFeedbackSnapshot(sessionId)
      if (!alreadyReady) applyFeedbackSnapshot(sessionId, result)
      return getState().activeSessionId === sessionId ? getState().feedback[messageId] : undefined
    },
    toggleFeedback: async (sessionId, messageId, rating) => {
      try {
        const current = getState().feedback[messageId]
        if (current?.rating === rating) {
          await client.request<unknown>({
            type: 'feedback.remove',
            requestId: requestId(),
            payload: { sessionId, messageId },
          })
          setState((next) => {
            if (next.activeSessionId !== sessionId) return next
            const feedback = { ...next.feedback }
            delete feedback[messageId]
            return { ...next, feedback }
          })
          return
        }
        const item = object(
          await client.request<unknown>({
            type: 'feedback.toggle',
            requestId: requestId(),
            payload: {
              sessionId,
              messageId,
              rating,
              ...(current?.note === undefined ? {} : { note: current.note }),
              ...(current?.category === undefined ? {} : { category: current.category }),
            },
          }),
        )
        if (!isMessageFeedbackItem(item)) throw new Error(translate('app.error.feedback'))
        setState((next) =>
          next.activeSessionId === sessionId
            ? { ...next, feedback: { ...next.feedback, [item.messageId]: item } }
            : next,
        )
      } catch (error) {
        if (!isFeedbackCapabilityUnavailable(error)) throw error
        setState((next) =>
          next.activeSessionId === sessionId ? { ...next, feedbackUnavailable: true } : next,
        )
      }
    },
    submitFeedback: async (sessionId, messageId, rating, note, category) => {
      try {
        const item = object(
          await client.request<unknown>({
            type: 'feedback.toggle',
            requestId: requestId(),
            payload: {
              sessionId,
              messageId,
              rating,
              ...(note === undefined ? {} : { note }),
              ...(category === undefined ? {} : { category }),
            },
          }),
        )
        if (!isMessageFeedbackItem(item)) throw new Error(translate('app.error.feedback'))
        setState((next) =>
          next.activeSessionId === sessionId
            ? { ...next, feedback: { ...next.feedback, [item.messageId]: item } }
            : next,
        )
      } catch (error) {
        if (!isFeedbackCapabilityUnavailable(error)) throw error
        setState((next) =>
          next.activeSessionId === sessionId ? { ...next, feedbackUnavailable: true } : next,
        )
        // A dialog submission must remain pending in the UI when the optional
        // sidecar is absent; resolving here would make MessageActions show a
        // false success acknowledgement.
        throw error
      }
    },
    setFeedbackNote: async (sessionId, messageId, note) => {
      try {
        const current = getState().feedback[messageId]
        if (current === undefined) return
        const item = object(
          await client.request<unknown>({
            type: 'feedback.note',
            requestId: requestId(),
            payload: {
              sessionId,
              messageId,
              rating: current.rating,
              ...(note === undefined ? {} : { note }),
              ...(current.category === undefined ? {} : { category: current.category }),
            },
          }),
        )
        if (!isMessageFeedbackItem(item)) throw new Error(translate('app.error.feedback'))
        setState((next) =>
          next.activeSessionId === sessionId
            ? { ...next, feedback: { ...next.feedback, [item.messageId]: item } }
            : next,
        )
      } catch (error) {
        if (!isFeedbackCapabilityUnavailable(error)) throw error
        setState((next) =>
          next.activeSessionId === sessionId ? { ...next, feedbackUnavailable: true } : next,
        )
      }
    },
    removeFeedback: async (sessionId, messageId) => {
      try {
        await client.request<unknown>({
          type: 'feedback.remove',
          requestId: requestId(),
          payload: { sessionId, messageId },
        })
        setState((next) => {
          if (next.activeSessionId !== sessionId) return next
          const feedback = { ...next.feedback }
          delete feedback[messageId]
          return { ...next, feedback }
        })
      } catch (error) {
        if (!isFeedbackCapabilityUnavailable(error)) throw error
        setState((next) =>
          next.activeSessionId === sessionId ? { ...next, feedbackUnavailable: true } : next,
        )
      }
    },
  }
}
