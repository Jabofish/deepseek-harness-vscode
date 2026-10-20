import type { TranscriptViewMode } from '../../app/ui-preferences.js'

/** Adapted from the pinned DSH ui-chat policy; layout never changes Host settings. */
export interface FocusedPresentationPolicy {
  readonly foldCompletedTurns: boolean
  readonly groupTools: boolean
  readonly liveProcessDetail: boolean
  readonly settledReasoningPreview: boolean
  readonly requestMetrics: boolean
}
const POLICIES: Readonly<Record<TranscriptViewMode, FocusedPresentationPolicy>> = {
  compact: {
    foldCompletedTurns: true,
    groupTools: true,
    liveProcessDetail: false,
    settledReasoningPreview: false,
    requestMetrics: false,
  },
  standard: {
    foldCompletedTurns: true,
    groupTools: true,
    liveProcessDetail: true,
    settledReasoningPreview: true,
    requestMetrics: false,
  },
  detailed: {
    foldCompletedTurns: true,
    groupTools: false,
    liveProcessDetail: true,
    settledReasoningPreview: true,
    requestMetrics: true,
  },
  verbose: {
    foldCompletedTurns: false,
    groupTools: false,
    liveProcessDetail: false,
    settledReasoningPreview: true,
    requestMetrics: true,
  },
}
export function focusedPresentationPolicy(mode: TranscriptViewMode): FocusedPresentationPolicy {
  return POLICIES[mode]
}
