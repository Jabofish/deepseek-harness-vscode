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
  const encoder = sharedUtf8Encoder
  const chunkByteLengths = frame.chunks.map((chunk) => encoder.encode(chunk.text).byteLength)
  let lastByteEnd: number | undefined
  for (const [index, chunk] of frame.chunks.entries()) {
    const end = chunk.at + chunkByteLengths[index]!
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
    const end = chunk.at + chunkByteLengths[index]!
    if (!Number.isSafeInteger(end)) return failJobFollow(previous)
    if (end <= previous.next) continue

    let acceptedChunk = chunk
    let acceptedBytes = end - chunk.at
    if (chunk.at < previous.next) {
      if (previous.receivedOutputBytes === true) return failJobFollow(previous)
      const suffix = utf8TextSuffixAfterBytes(chunk.text, previous.next - chunk.at)
      if (suffix === undefined) return failJobFollow(previous)
      acceptedChunk = {
        at: previous.next,
        text: suffix,
        ...(chunk.channel === undefined ? {} : { channel: chunk.channel }),
      }
      acceptedBytes = encoder.encode(suffix).byteLength
    }

    if (
      acceptedChunk.at > expected &&
      acceptedChunk.gapBefore !== true &&
      !(index === 0 && frame.lossy === true)
    )
      return failJobFollow(previous)
    if (acceptedChunk.at < expected) return failJobFollow(previous)
    expected = acceptedChunk.at + acceptedBytes
    if (acceptedChunk.text.length > 0) additions.push(acceptedChunk)
  }

  if (additions.length === 0 && frame.lossy !== true) return failJobFollow(previous)
  // Both lists are ordered by `at`, additions start at or after previous.next,
  // and every previous chunk ends at or before it, so a linear merge replaces
  // the per-frame rebuild-and-sort of the whole output table.
  const merged: JobOutputChunk[] = []
  let olderIndex = 0
  let newerIndex = 0
  while (olderIndex < previous.chunks.length || newerIndex < additions.length) {
    const older = previous.chunks[olderIndex]
    const newer = additions[newerIndex]
    if (newer === undefined || (older !== undefined && older.at < newer.at)) {
      if (older !== undefined) merged.push(older)
      olderIndex++
    } else {
      merged.push(newer)
      newerIndex++
    }
  }
  const chunks = merged
  let chars = chunks.reduce((total, chunk) => total + chunk.text.length, 0)
  let firstKept = 0
  while (chunks.length - firstKept > 1 && chars > 256 * 1024) {
    chars -= chunks[firstKept]?.text.length ?? 0
    firstKept++
  }
  const bounded = firstKept > 0 ? chunks.slice(firstKept) : chunks
  return {
    ...previous,
    next: frame.next,
    chunks: bounded,
    lossy,
    receivedOutputBytes: previous.receivedOutputBytes === true || additions.length > 0,
  }
}

/** Encoding is stateless; one shared instance serves every follow frame. */
const sharedUtf8Encoder = new TextEncoder()

function failJobFollow(current: JobFollowState): JobFollowState {
  return { ...current, error: 'stream-failed' }
}

function utf8TextSuffixAfterBytes(text: string, prefixBytes: number): string | undefined {
  const bytes = sharedUtf8Encoder.encode(text)
  if (prefixBytes <= 0 || prefixBytes >= bytes.byteLength) return undefined
  const nextByte = bytes[prefixBytes]
  if (nextByte === undefined || (nextByte & 0b1100_0000) === 0b1000_0000) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(prefixBytes))
  } catch {
    return undefined
  }
}
