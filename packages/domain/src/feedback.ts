/** Safe projection of the optional rc.8 message-feedback sidecar. */

export type MessageFeedbackRating = 'positive' | 'negative'

export interface MessageFeedbackItem {
  readonly messageId: string
  readonly rating: MessageFeedbackRating
  readonly note?: string
  readonly version: string
  readonly createdAt?: number
  readonly updatedAt?: number
}

export interface MessageFeedbackRepository {
  /** Missing optional feedback capability is represented by an empty list. */
  list(sessionId: string, signal?: AbortSignal): Promise<readonly MessageFeedbackItem[]>
  /** Create or replace one rating, using the repository's observed CAS token. */
  put(
    sessionId: string,
    messageId: string,
    rating: MessageFeedbackRating,
    note?: string,
    signal?: AbortSignal,
  ): Promise<MessageFeedbackItem>
  /** Remove one rating; absent feedback is idempotently successful. */
  remove(sessionId: string, messageId: string, signal?: AbortSignal): Promise<void>
}
