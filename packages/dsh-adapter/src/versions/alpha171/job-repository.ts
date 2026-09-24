import {
  AppError,
  type BackendEvent,
  type JobFollowFrame,
  type JobOutputChunk,
  type JobView,
} from '@dsh-vscode/domain'

import type { EventAwareJobRepository } from '../../repositories/job-repository.js'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

/** Alpha171 Job Controller adapter: live rows, resumable output, and human stop. */
export class Alpha171JobRepository implements EventAwareJobRepository {
  public constructor(private readonly transport: AlphaLoopbackApiClient) {}

  public remember(_event: BackendEvent): void {
    // Alpha171 rows are authoritative on the dedicated list stream, not the
    // Session follow stream's legacy Jobs projection.
  }

  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly JobView[]> {
    const iterator = this.watchRows(sessionId, signal ?? new AbortController().signal)[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.done || first.value.type !== 'jobs.updated') {
        if (signal?.aborted) throw cancelled(signal.reason)
        throw malformedJobResponse('list')
      }
      return first.value.jobs
    } finally {
      await iterator.return?.()
    }
  }

  /** Each DSH `rows` frame replaces the complete set, including an empty set. */
  public async *watchRows(sessionId: string, signal: AbortSignal): AsyncIterable<BackendEvent> {
    if (signal.aborted) throw cancelled(signal.reason)
    for await (const item of this.transport.openRemoteStream(
      'job/list',
      { request: { sessionId } },
      signal,
    )) {
      if (signal.aborted) return
      const frame = recordOrUndefined(item)
      if (frame === undefined || !hasExactKeys(frame, ['type', 'jobs']) || frame.type !== 'rows')
        throw malformedJobResponse('list frame')
      if (!Array.isArray(frame.jobs) || !frame.jobs.every(validJob)) throw malformedJobResponse('rows')
      yield { type: 'jobs.updated', sessionId, jobs: frame.jobs.map(mapJob) }
    }
    if (!signal.aborted) throw malformedJobResponse('stream ended')
  }

  /** Observe from the absolute byte cursor; this read never consumes model output. */
  public async *follow(
    sessionId: string,
    jobId: string,
    from?: number,
    signal?: AbortSignal,
  ): AsyncIterable<JobFollowFrame> {
    if (signal?.aborted) throw cancelled(signal.reason)
    if (from !== undefined && !isSafeCount(from)) throw malformedJobResponse('offset')
    let receivedTerminalStatus = false
    let receivedOpenedFrame = false
    let receivedOutputFrame = false
    let nextOffset: number | undefined
    for await (const item of this.transport.openRemoteStream(
      'job/follow',
      { request: { sessionId, jobId, ...(from === undefined ? {} : { from }) } },
      signal,
    )) {
      if (signal?.aborted) return
      const frame = parseFollowFrame(item)
      if (frame === undefined) throw malformedJobResponse('follow frame')
      if (frame.type === 'opened') {
        const expectedOpeningOffset = from ?? frame.job.output?.earliest
        if (
          receivedOpenedFrame ||
          (expectedOpeningOffset !== undefined && frame.from !== expectedOpeningOffset)
        )
          throw malformedJobResponse('follow opened offset')
        receivedOpenedFrame = true
        // Host echoes the requested cursor even when it is beyond the current
        // output tail. Its first read then clamps that cursor to this opening
        // snapshot's total, so future output may legitimately start below
        // `frame.from` in that case.
        nextOffset = Math.min(frame.from, frame.job.output?.total ?? frame.from)
      } else {
        if (!receivedOpenedFrame || nextOffset === undefined)
          throw malformedJobResponse('follow frame before opened')
        if (receivedTerminalStatus) throw malformedJobResponse('follow frame after terminal status')
        if (frame.type === 'output') {
          if (frame.next <= nextOffset) throw malformedJobResponse('follow offset did not advance')
          if (frame.chunks.length === 0 && frame.lossy !== true)
            throw malformedJobResponse('follow empty output without loss')
          let expectedOffset = nextOffset
          for (const [index, chunk] of frame.chunks.entries()) {
            const chunkEnd = chunk.at + new TextEncoder().encode(chunk.text).byteLength
            if (chunkEnd <= nextOffset || (receivedOutputFrame && chunk.at < nextOffset))
              throw malformedJobResponse('follow chunk offset')
            if (
              chunk.at > expectedOffset &&
              chunk.gapBefore !== true &&
              !(index === 0 && frame.lossy === true)
            )
              throw malformedJobResponse('follow unmarked gap')
            expectedOffset = Math.max(expectedOffset, chunkEnd)
          }
          nextOffset = frame.next
          receivedOutputFrame = true
        } else {
          if (frame.job.status === 'running' || frame.job.status === 'stopping')
            throw malformedJobResponse('follow non-terminal status')
          if (frame.job.output?.total === undefined || frame.job.output.total < nextOffset)
            throw malformedJobResponse('follow status offset rollback')
          receivedTerminalStatus = true
        }
      }
      yield frame
    }
    if (!signal?.aborted && !receivedTerminalStatus) throw malformedJobResponse('follow stream ended')
  }

  public async kill(
    sessionId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<'requested' | 'already-finished'> {
    if (signal?.aborted) throw cancelled(signal.reason)
    const result = await this.transport.remoteRequest<unknown>(
      'job/kill',
      {
        request: { sessionId, jobId },
      },
      signal,
    )
    const value = unwrapRpcResultValue<unknown>(result, 'job/kill')
    const record = recordOrUndefined(value)
    if (
      record === undefined ||
      !hasExactKeys(record, ['outcome']) ||
      (record.outcome !== 'requested' && record.outcome !== 'already-finished')
    )
      throw malformedJobResponse('kill receipt')
    return record.outcome
  }
}

function parseFollowFrame(value: unknown): JobFollowFrame | undefined {
  const frame = recordOrUndefined(value)
  if (frame === undefined || typeof frame.type !== 'string') return undefined
  if (frame.type === 'opened' || frame.type === 'status') {
    const keys = frame.type === 'opened' ? ['type', 'job', 'from'] : ['type', 'job']
    if (!hasExactKeys(frame, keys) || !validJob(frame.job)) return undefined
    const job = mapJob(frame.job)
    if (frame.type === 'status') return { type: 'status', job }
    return isSafeCount(frame.from) ? { type: 'opened', job, from: frame.from } : undefined
  }
  if (frame.type !== 'output' || !hasKeysWithin(frame, ['type', 'chunks', 'next', 'lossy'])) return undefined
  if (
    !Array.isArray(frame.chunks) ||
    !frame.chunks.every(validChunk) ||
    !isSafeCount(frame.next) ||
    (frame.lossy !== undefined && frame.lossy !== true) ||
    (frame.chunks.length === 0 && frame.lossy !== true)
  )
    return undefined
  let priorEnd: number | undefined
  let lastByteEnd: number | undefined
  for (const chunk of frame.chunks) {
    if (chunk.at > frame.next || (priorEnd !== undefined && chunk.at < priorEnd)) return undefined
    if (priorEnd !== undefined && chunk.at > priorEnd && chunk.gapBefore !== true) return undefined
    const chunkEnd = chunk.at + new TextEncoder().encode(chunk.text).byteLength
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > frame.next) return undefined
    priorEnd = chunkEnd
    if (chunk.text.length === 0) {
      if (chunk.at !== frame.next || chunk.gapBefore !== true || frame.lossy !== true) return undefined
    } else {
      lastByteEnd = chunkEnd
    }
  }
  if (lastByteEnd !== undefined && lastByteEnd !== frame.next) return undefined
  return {
    type: 'output',
    chunks: frame.chunks,
    next: frame.next,
    ...(frame.lossy === true ? { lossy: true } : {}),
  }
}

function mapJob(value: Record<string, unknown>): JobView {
  const output = value.output as Record<string, unknown>
  return {
    id: value.id as string,
    kind: value.kind as string,
    label: value.label as string,
    status: value.status as JobView['status'],
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.progress === 'string' ? { progress: value.progress } : {}),
    startedAt: value.startedAt as number,
    ...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {}),
    output: { total: output.total as number, earliest: output.earliest as number },
  }
}

function validJob(value: unknown): value is Record<string, unknown> {
  const record = recordOrUndefined(value)
  const output = recordOrUndefined(record?.output)
  return (
    record !== undefined &&
    isNonEmptyString(record.id) &&
    isNonEmptyString(record.kind) &&
    typeof record.label === 'string' &&
    (record.owner === undefined || isNonEmptyString(record.owner)) &&
    (record.outputLimitBytes === undefined || isSafeCount(record.outputLimitBytes)) &&
    (record.status === 'running' ||
      record.status === 'stopping' ||
      record.status === 'completed' ||
      record.status === 'failed' ||
      record.status === 'killed') &&
    isSafeTime(record.startedAt) &&
    (record.finishedAt === undefined || isSafeTime(record.finishedAt)) &&
    (record.detail === undefined || typeof record.detail === 'string') &&
    (record.progress === undefined || typeof record.progress === 'string') &&
    output !== undefined &&
    isSafeCount(output.total) &&
    isSafeCount(output.earliest) &&
    output.earliest <= output.total &&
    (output.spillPaths === undefined ||
      (Array.isArray(output.spillPaths) && output.spillPaths.every((path) => typeof path === 'string')))
  )
}

function validChunk(value: unknown): value is JobOutputChunk {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    hasKeysWithin(record, ['at', 'text', 'channel', 'gapBefore']) &&
    isSafeCount(record.at) &&
    typeof record.text === 'string' &&
    (record.channel === undefined ||
      record.channel === 'stdout' ||
      record.channel === 'stderr' ||
      record.channel === 'log') &&
    (record.gapBefore === undefined || record.gapBefore === true)
  )
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function hasKeysWithin(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
}

function malformedJobResponse(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed alpha171 job ${part}.`,
    retryable: false,
  })
}

function cancelled(cause: unknown): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'The DSH request was cancelled.',
    retryable: false,
    cause,
  })
}
