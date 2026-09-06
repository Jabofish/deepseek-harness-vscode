/**
 * The 0.1.3-alpha.1 Session Controller wire moved streaming assistant chunks
 * out of the durable journal.  This file keeps that process-local stream
 * state at the adapter boundary; no synthetic value is ever used as a DSH
 * durable sequence.
 */

export interface Alpha13ProjectedChunk {
  readonly type: 'chunk'
  readonly sessionId: string
  readonly attemptId: string
  readonly revision: number
  readonly index: number
  readonly time: number
  readonly turn: number
  readonly step: number
  readonly chunk: Record<string, unknown>
  /** Local ordering only. It is never exposed as a DSH session sequence. */
  readonly transientSequence: number
}

export interface Alpha13ProjectedInterruption {
  readonly type: 'interrupted'
  readonly sessionId: string
  readonly attemptId: string
  readonly turn: number
  readonly step: number
}

export interface Alpha13ProjectedDurableEvent {
  readonly type: 'event'
  readonly event: Record<string, unknown>
}

export type Alpha13ProjectorOutput =
  Alpha13ProjectedChunk | Alpha13ProjectedDurableEvent | Alpha13ProjectedInterruption

interface Alpha13ActiveAttempt {
  readonly attemptId: string
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
  nextIndex: number
}

interface TimedChunk {
  readonly time: number
  readonly chunk: Record<string, unknown>
}

interface StartFrame {
  readonly type: 'start'
  readonly attemptId: string
  readonly revision: number
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
}

interface ChunkFrame {
  readonly type: 'chunk'
  readonly attemptId: string
  readonly revision: number
  readonly index: number
  readonly time: number
  readonly chunk: Record<string, unknown>
}

interface EndFrame {
  readonly type: 'end'
  readonly attemptId: string
  readonly revision: number
  readonly index: number
  readonly outcome:
    | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: number
      }
    | { readonly kind: 'abandoned' }
}

type Frame = StartFrame | ChunkFrame | EndFrame

interface AssistantBaseline {
  readonly revision: number
  readonly activeAttempt?: {
    readonly attemptId: string
    readonly startedAfterSeq: number
    readonly turn: number
    readonly step: number
    readonly nextIndex: number
    readonly stream: readonly unknown[]
  }
}

// A projector normally lives for one follow subscription. Keep duplicate
// suppression bounded; matching settlements stay in the separate pending map
// until the corresponding end frame arrives.
const MAX_PUBLISHED_SEQUENCES = 4_096

/**
 * Validates and folds the v2 assistant stream exactly as the upstream Client
 * Session runtime does. Durable assistant settlements are held until their
 * matching end frame, so a reconnect cannot publish a final message twice.
 */
export class Alpha13AssistantStreamProjector {
  private revision = 0
  private activeAttempt: Alpha13ActiveAttempt | undefined
  private readonly pendingSettlements = new Map<number, Record<string, unknown>>()
  private readonly publishedSequences = new Set<number>()
  private transientSequence = 0

  public rememberDurable(event: Record<string, unknown>): void {
    const sequence = event.seq
    if (isSafeSequence(sequence)) {
      this.publishedSequences.add(sequence)
      this.trimPublishedSequences()
    }
  }

  public open(baselineValue: unknown, sessionId: string): readonly Alpha13ProjectedChunk[] {
    const baseline = parseBaseline(baselineValue)
    this.revision = baseline.revision
    this.transientSequence = 0
    this.pendingSettlements.clear()
    this.activeAttempt = undefined
    this.trimPublishedSequences()
    if (baseline.activeAttempt === undefined) return []

    const attempt = baseline.activeAttempt
    const chunks = expandAssistantStream(attempt.stream)
    if (chunks.length !== attempt.nextIndex)
      throw new Error('assistant stream baseline nextIndex does not match its compact stream')
    this.activeAttempt = {
      attemptId: attempt.attemptId,
      startedAfterSeq: attempt.startedAfterSeq,
      turn: attempt.turn,
      step: attempt.step,
      nextIndex: attempt.nextIndex,
    }
    this.trimPublishedSequences()
    return chunks.map((item, index) =>
      this.projectChunk(
        sessionId,
        {
          type: 'chunk',
          attemptId: attempt.attemptId,
          revision: baseline.revision,
          index,
          time: item.time,
          chunk: item.chunk,
        },
        attempt.turn,
        attempt.step,
      ),
    )
  }

  public acceptDurable(event: Record<string, unknown>): readonly Alpha13ProjectorOutput[] {
    const sequence = event.seq
    if (!isSafeSequence(sequence)) throw new Error('assistant stream settlement has an invalid sequence')
    const active = this.activeAttempt
    const data = record(event.data)
    const eventType = event.type
    const isAppendMessage = eventType !== 'assistant/message' || event.surfaceOp === 'append'
    if (
      active !== undefined &&
      (eventType === 'assistant/message' || eventType === 'assistant/attempt') &&
      isAppendMessage &&
      sequence > active.startedAfterSeq &&
      data !== undefined &&
      data.turn === active.turn &&
      data.step === active.step
    ) {
      if (this.pendingSettlements.has(sequence)) throw new Error('duplicate assistant settlement')
      this.pendingSettlements.set(sequence, event)
      return []
    }
    this.publishedSequences.add(sequence)
    this.trimPublishedSequences()
    return [{ type: 'event', event }]
  }

  public acceptFrame(value: unknown, sessionId: string): readonly Alpha13ProjectorOutput[] {
    const frame = parseFrame(value)
    if (frame.revision !== this.revision + 1)
      throw new Error(`assistant stream skipped revision ${String(this.revision + 1)}`)
    this.revision = frame.revision

    if (frame.type === 'start') {
      if (this.activeAttempt !== undefined || this.pendingSettlements.size > 0)
        throw new Error('assistant stream started before its previous attempt settled')
      this.activeAttempt = {
        attemptId: frame.attemptId,
        startedAfterSeq: frame.startedAfterSeq,
        turn: frame.turn,
        step: frame.step,
        nextIndex: 0,
      }
      this.trimPublishedSequences()
      return []
    }

    const active = this.activeAttempt
    if (active === undefined || active.attemptId !== frame.attemptId) return []
    if (frame.index !== active.nextIndex)
      throw new Error(`assistant stream expected chunk index ${String(active.nextIndex)}`)

    if (frame.type === 'chunk') {
      active.nextIndex += 1
      return [this.projectChunk(sessionId, frame, active.turn, active.step)]
    }

    active.nextIndex = frame.index
    this.activeAttempt = undefined
    if (frame.outcome.kind === 'abandoned') {
      if (this.pendingSettlements.size > 0)
        throw new Error('assistant stream abandoned with a pending durable settlement')
      this.trimPublishedSequences()
      return [
        {
          type: 'interrupted',
          sessionId,
          attemptId: frame.attemptId,
          turn: active.turn,
          step: active.step,
        },
      ]
    }
    const sequence = frame.outcome.seq
    if (this.publishedSequences.has(sequence)) return []
    const pending = this.pendingSettlements.get(sequence)
    if (pending === undefined || pending.type !== frame.outcome.eventType)
      throw new Error('assistant stream committed without its matching durable settlement')
    this.pendingSettlements.delete(sequence)
    this.publishedSequences.add(sequence)
    this.trimPublishedSequences()
    return [{ type: 'event', event: pending }]
  }

  private trimPublishedSequences(): void {
    const activeFloor = this.activeAttempt?.startedAfterSeq
    if (activeFloor !== undefined) {
      for (const sequence of this.publishedSequences) {
        if (sequence <= activeFloor) this.publishedSequences.delete(sequence)
      }
    }
    while (this.publishedSequences.size > MAX_PUBLISHED_SEQUENCES) {
      const oldest = this.publishedSequences.values().next().value
      if (!isSafeSequence(oldest)) return
      this.publishedSequences.delete(oldest)
    }
  }

  private projectChunk(
    sessionId: string,
    frame: ChunkFrame,
    turn: number,
    step: number,
  ): Alpha13ProjectedChunk {
    this.transientSequence += 1
    return {
      type: 'chunk',
      sessionId,
      attemptId: frame.attemptId,
      revision: frame.revision,
      index: frame.index,
      time: frame.time,
      turn,
      step,
      chunk: frame.chunk,
      transientSequence: this.transientSequence,
    }
  }
}

function parseBaseline(value: unknown): AssistantBaseline {
  const source = record(value)
  if (
    source === undefined ||
    !hasKeysWithin(source, ['revision', 'activeAttempt']) ||
    !Object.hasOwn(source, 'revision')
  )
    throw new Error('assistant stream baseline is malformed')
  if (!isSafeIndex(source.revision)) throw new Error('assistant stream baseline revision is malformed')
  if (source.activeAttempt === undefined) return { revision: source.revision }
  const attempt = record(source.activeAttempt)
  if (
    attempt === undefined ||
    !hasOnlyKeys(attempt, ['attemptId', 'startedAfterSeq', 'turn', 'step', 'nextIndex', 'stream']) ||
    !isNonEmptyString(attempt.attemptId) ||
    !isSafeCursor(attempt.startedAfterSeq) ||
    !isSafeIndex(attempt.turn) ||
    !isSafeIndex(attempt.step) ||
    !isSafeIndex(attempt.nextIndex) ||
    !Array.isArray(attempt.stream)
  )
    throw new Error('assistant stream baseline attempt is malformed')
  if (source.revision === 0) throw new Error('assistant stream baseline attempt has no active revision')
  return {
    revision: source.revision,
    activeAttempt: {
      attemptId: attempt.attemptId,
      startedAfterSeq: attempt.startedAfterSeq,
      turn: attempt.turn,
      step: attempt.step,
      nextIndex: attempt.nextIndex,
      stream: attempt.stream,
    },
  }
}

function parseFrame(value: unknown): Frame {
  const source = record(value)
  if (source === undefined || typeof source.type !== 'string')
    throw new Error('assistant stream frame is malformed')
  if (source.type === 'start') {
    if (
      !hasOnlyKeys(source, ['type', 'attemptId', 'revision', 'startedAfterSeq', 'turn', 'step']) ||
      !isNonEmptyString(source.attemptId) ||
      !isSafeIndex(source.revision) ||
      !isSafeCursor(source.startedAfterSeq) ||
      !isSafeIndex(source.turn) ||
      !isSafeIndex(source.step)
    )
      throw new Error('assistant stream start frame is malformed')
    return {
      type: 'start',
      attemptId: source.attemptId,
      revision: source.revision,
      startedAfterSeq: source.startedAfterSeq,
      turn: source.turn,
      step: source.step,
    }
  }
  if (source.type === 'chunk') {
    const chunk = record(source.chunk)
    if (
      !hasOnlyKeys(source, ['type', 'attemptId', 'revision', 'index', 'time', 'chunk']) ||
      !isNonEmptyString(source.attemptId) ||
      !isSafeIndex(source.revision) ||
      !isSafeIndex(source.index) ||
      !isSafeTime(source.time) ||
      chunk === undefined ||
      !validStreamChunk(chunk)
    )
      throw new Error('assistant stream chunk frame is malformed')
    return {
      type: 'chunk',
      attemptId: source.attemptId,
      revision: source.revision,
      index: source.index,
      time: source.time,
      chunk,
    }
  }
  if (source.type === 'end') {
    const outcome = record(source.outcome)
    if (
      !hasOnlyKeys(source, ['type', 'attemptId', 'revision', 'index', 'outcome']) ||
      !isNonEmptyString(source.attemptId) ||
      !isSafeIndex(source.revision) ||
      !isSafeIndex(source.index) ||
      outcome === undefined
    )
      throw new Error('assistant stream end frame is malformed')
    if (outcome.kind === 'abandoned' && hasOnlyKeys(outcome, ['kind']))
      return {
        type: 'end',
        attemptId: source.attemptId,
        revision: source.revision,
        index: source.index,
        outcome: { kind: 'abandoned' },
      }
    if (
      outcome.kind === 'committed' &&
      hasOnlyKeys(outcome, ['kind', 'eventType', 'seq']) &&
      (outcome.eventType === 'assistant/message' || outcome.eventType === 'assistant/attempt') &&
      isSafeSequence(outcome.seq)
    )
      return {
        type: 'end',
        attemptId: source.attemptId,
        revision: source.revision,
        index: source.index,
        outcome: { kind: 'committed', eventType: outcome.eventType, seq: outcome.seq },
      }
  }
  throw new Error('assistant stream end frame is malformed')
}

function expandAssistantStream(stream: readonly unknown[]): readonly TimedChunk[] {
  const chunks: TimedChunk[] = []
  for (const value of stream) {
    const recordValue = record(value)
    if (recordValue === undefined || typeof recordValue.type !== 'string')
      throw new Error('assistant stream record is malformed')
    if (recordValue.type === 'chunk') {
      const chunk = record(recordValue.chunk)
      if (
        !hasOnlyKeys(recordValue, ['type', 'time', 'chunk']) ||
        !isSafeTime(recordValue.time) ||
        chunk === undefined ||
        !validStreamChunk(chunk)
      )
        throw new Error('assistant stream raw chunk record is malformed')
      chunks.push({ time: recordValue.time, chunk })
      continue
    }
    const isText = recordValue.type === 'text-chunks' || recordValue.type === 'reasoning-chunks'
    const isTool = recordValue.type === 'tool-call-chunks'
    if (!isText && !isTool) throw new Error('assistant stream compact record is unsupported')
    const commonKeys = ['type', 'time0', 'index', 'dt', isTool ? 'id' : '']
    const keys = isTool
      ? [...commonKeys.filter(Boolean), ...(Object.hasOwn(recordValue, 'name') ? ['name'] : []), 'args']
      : [...commonKeys.filter(Boolean), 'texts']
    if (
      !hasOnlyKeys(recordValue, keys) ||
      !isSafeTime(recordValue.time0) ||
      !isSafeIndex(recordValue.index) ||
      !Array.isArray(recordValue.dt) ||
      !recordValue.dt.every((gap) => Number.isSafeInteger(gap))
    )
      throw new Error('assistant stream compact record is malformed')
    const members = recordValue[isTool ? 'args' : 'texts']
    if (
      !Array.isArray(members) ||
      members.length === 0 ||
      !members.every((member) => typeof member === 'string')
    )
      throw new Error('assistant stream compact members are malformed')
    if (recordValue.dt.length !== members.length - 1)
      throw new Error('assistant stream compact gaps are malformed')
    if (
      isTool &&
      (!isNonEmptyString(recordValue.id) ||
        (recordValue.name !== undefined && !isNonEmptyString(recordValue.name)))
    )
      throw new Error('assistant stream tool record is malformed')
    let time = recordValue.time0
    for (let index = 0; index < members.length; index += 1) {
      if (index > 0) time += recordValue.dt[index - 1] as number
      if (!isSafeTime(time)) throw new Error('assistant stream compact time is malformed')
      const chunk = isTool
        ? {
            type: 'tool-call-delta',
            index: recordValue.index,
            id: recordValue.id,
            ...(recordValue.name === undefined ? {} : { name: recordValue.name }),
            argumentsDelta: members[index],
          }
        : {
            type: recordValue.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
            index: recordValue.index,
            text: members[index],
          }
      chunks.push({ time, chunk })
    }
  }
  return chunks
}

function validStreamChunk(value: Record<string, unknown>): boolean {
  if (typeof value.type !== 'string') return false
  switch (value.type) {
    case 'block-start':
      return (
        hasOnlyKeys(value, ['type', 'index', 'blockType']) &&
        isSafeIndex(value.index) &&
        typeof value.blockType === 'string'
      )
    case 'text-delta':
    case 'reasoning-delta':
      return (
        hasOnlyKeys(value, ['type', 'index', 'text']) &&
        isSafeIndex(value.index) &&
        typeof value.text === 'string'
      )
    case 'tool-call-delta':
      return (
        (hasOnlyKeys(value, ['type', 'index', 'id', 'argumentsDelta']) ||
          hasOnlyKeys(value, ['type', 'index', 'id', 'name', 'argumentsDelta'])) &&
        isSafeIndex(value.index) &&
        typeof value.id === 'string' &&
        (value.name === undefined || typeof value.name === 'string') &&
        typeof value.argumentsDelta === 'string'
      )
    case 'block-end':
      return (
        hasOnlyKeys(value, ['type', 'index', 'block']) && isSafeIndex(value.index) && isJsonLike(value.block)
      )
    case 'usage':
      return hasOnlyKeys(value, ['type', 'usage']) && isJsonLike(value.usage)
    case 'finish':
      return (
        (hasOnlyKeys(value, ['type', 'reason']) || hasOnlyKeys(value, ['type', 'reason', 'replayState'])) &&
        isJsonLike(value.reason) &&
        (value.replayState === undefined || isJsonLike(value.replayState))
      )
    default:
      return false
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value)
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function hasKeysWithin(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSafeIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isSafeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function isSafeCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0)
}

function isSafeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isJsonLike(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (
        Reflect.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        return false
      for (let index = 0; index < value.length; index += 1)
        if (!Object.hasOwn(value, index) || !isJsonLike(value[index], seen)) return false
      return true
    }
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !isJsonLike(Reflect.get(value, key), seen)) return false
    }
    return true
  } finally {
    seen.delete(value)
  }
}
