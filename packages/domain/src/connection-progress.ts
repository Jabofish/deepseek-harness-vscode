import type { BackendCandidate, ConnectionMode, ProcessOwnership } from './runtime.js'
import type { AppErrorCode } from './errors.js'

export const CONNECTION_LOG_PHASES = [
  'connect',
  'discovery',
  'discovery-cache',
  'runtime',
  'process',
  'authorization',
  'verification',
  'initialization',
  'disconnect',
] as const
export const CONNECTION_LOG_STATUSES = ['started', 'succeeded', 'unavailable', 'failed', 'cancelled'] as const

/** Host observations only; no process output, address, path or exception text. */
export interface ConnectionProgress {
  readonly phase: (typeof CONNECTION_LOG_PHASES)[number]
  readonly status: (typeof CONNECTION_LOG_STATUSES)[number]
  readonly attempt?: number
  readonly count?: number
  readonly hostVersion?: string
  readonly candidateSource?: BackendCandidate['source']
  readonly ownership?: ProcessOwnership
  readonly mode?: ConnectionMode
  readonly code?: AppErrorCode
}

export interface ConnectionLogEntry extends ConnectionProgress {
  readonly id: number
  readonly time: string
  readonly elapsedMs: number
}
