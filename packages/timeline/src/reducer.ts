import type { BackendEvent } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { TimelineState } from './nodes.js'

export interface SequencedBackendEvent {
  readonly sequence: number
  readonly event: BackendEvent
}

export function reduceTimeline(state: TimelineState, input: SequencedBackendEvent): TimelineState {
  return unimplemented<TimelineState>('normalized event to timeline reducer', [
    'ignore duplicate or stale sequence numbers',
    'append deltas to the matching message without quadratic string or array copying',
    'upsert tool, goal, job, and subagent nodes by stable id',
    'retain unknown events as diagnostic notices only in development mode',
    'stay pure and deterministic for replay and tests',
    `current sequence ${state.lastSequence}; incoming sequence ${input.sequence}`,
  ])
}
