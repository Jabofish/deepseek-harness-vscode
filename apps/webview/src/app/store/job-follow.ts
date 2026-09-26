import type { JobFollowFrame, JobOutputChunk, JobView } from '@dsh-vscode/domain'

export interface JobFollowState {
  readonly jobId: string
  /** Host-issued observer identity; frames from older follows are ignored. */
  readonly followId: string
  readonly next: number
  readonly chunks: readonly JobOutputChunk[]
  readonly lossy: boolean
  /** Local request identity used to ignore an older start failure. */
  readonly generation?: number
  /** The matching `opened(from)` frame must arrive before this follow is live. */
  readonly awaitingOpenFrom?: number
  /** Only the first byte-bearing frame after open may replay a chunk across the saved byte cursor. */
  readonly receivedOutputBytes?: boolean
  readonly job?: JobView
  /** An opened row may already be settled; only a terminal status frame closes output delivery. */
  readonly terminalStatusReceived?: boolean
  /** Safe failure category for the current observer; it keeps output retryable. */
  readonly error?: 'stream-failed' | undefined
}

function isTerminalJobStatus(status: JobView['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export function reduceJobFollow(
  current: JobFollowState,
  jobId: string,
  frame: JobFollowFrame,
): JobFollowState {
  if (current.jobId !== jobId || current.error !== undefined) return current
  if (frame.type === 'opened') {
    if (current.awaitingOpenFrom === undefined || frame.from !== current.awaitingOpenFrom) return current
    return {
      jobId: current.jobId,
      followId: current.followId,
      next: Math.max(current.next, frame.from),
      chunks: current.chunks,
      lossy: current.lossy,
      ...(current.generation === undefined ? {} : { generation: current.generation }),
      receivedOutputBytes: false,
      terminalStatusReceived: false,
      job: frame.job,
    }
  }
  if (current.awaitingOpenFrom !== undefined || current.terminalStatusReceived === true) return current
  const previous = current
  if (frame.type === 'status')
    return {
      ...previous,
      next: Math.max(previous.next, frame.job.output?.total ?? previous.next),
      job: frame.job,
      terminalStatusReceived: isTerminalJobStatus(frame.job.status),
    }
  if (frame.next < previous.next) return previous
  const encoder = new TextEncoder()
  let lastByteEnd: number | undefined
  for (const chunk of frame.chunks) {
    const end = chunk.at + encoder.encode(chunk.text).byteLength
    if (!Number.isSafeInteger(end) || end > frame.next) return failJobFollow(previous)
    if (chunk.text.length === 0) {
      if (chunk.at !== frame.next || chunk.gapBefore !== true || frame.lossy !== true)
        return failJobFollow(previous)
    } else {
      lastByteEnd = end
    }
  }
  if (lastByteEnd !== undefined && lastByteEnd !== frame.next) return failJobFollow(previous)
  if (frame.chunks.length === 0 && frame.next > previous.next && frame.lossy !== true)
    return failJobFollow(previous)
  const lossy =
    previous.lossy || frame.lossy === true || frame.chunks.some((chunk) => chunk.gapBefore === true)
  if (frame.next === previous.next)
    return {
      ...previous,
      lossy,
    }

  const additions: JobOutputChunk[] = []
  let expected = previous.next
  for (const [index, chunk] of frame.chunks.entries()) {
    const byteLength = encoder.encode(chunk.text).byteLength
    const end = chunk.at + byteLength
    if (!Number.isSafeInteger(end)) return failJobFollow(previous)
    if (end <= previous.next) continue

    let acceptedChunk = chunk
    if (chunk.at < previous.next) {
      if (previous.receivedOutputBytes === true) return failJobFollow(previous)
      const suffix = utf8TextSuffixAfterBytes(chunk.text, previous.next - chunk.at)
      if (suffix === undefined) return failJobFollow(previous)
      acceptedChunk = {
        at: previous.next,
        text: suffix,
        ...(chunk.channel === undefined ? {} : { channel: chunk.channel }),
      }
    }

    if (
      acceptedChunk.at > expected &&
      acceptedChunk.gapBefore !== true &&
      !(index === 0 && frame.lossy === true)
    )
      return failJobFollow(previous)
    if (acceptedChunk.at < expected) return failJobFollow(previous)
    expected = acceptedChunk.at + encoder.encode(acceptedChunk.text).byteLength
    if (acceptedChunk.text.length > 0) additions.push(acceptedChunk)
  }

  if (additions.length === 0 && frame.lossy !== true) return failJobFollow(previous)
  const byOffset = new Map<number, JobOutputChunk>()
  for (const chunk of previous.chunks) byOffset.set(chunk.at, chunk)
  for (const chunk of additions) byOffset.set(chunk.at, chunk)
  const chunks = [...byOffset.values()].sort((left, right) => left.at - right.at)
  let chars = chunks.reduce((total, chunk) => total + chunk.text.length, 0)
  while (chunks.length > 1 && chars > 256 * 1024) {
    const removed = chunks.shift()
    chars -= removed?.text.length ?? 0
  }
  return {
    ...previous,
    next: frame.next,
    chunks,
    lossy,
    receivedOutputBytes: previous.receivedOutputBytes === true || additions.length > 0,
  }
}

function failJobFollow(current: JobFollowState): JobFollowState {
  return { ...current, error: 'stream-failed' }
}

function utf8TextSuffixAfterBytes(text: string, prefixBytes: number): string | undefined {
  const bytes = new TextEncoder().encode(text)
  if (prefixBytes <= 0 || prefixBytes >= bytes.byteLength) return undefined
  const nextByte = bytes[prefixBytes]
  if (nextByte === undefined || (nextByte & 0b1100_0000) === 0b1000_0000) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(prefixBytes))
  } catch {
    return undefined
  }
}
