import type { TokenUsage } from '@dsh-vscode/domain'
import type { AssistantTiming, TimelineState, TurnUsageTracking } from './nodes.js'

type Snapshot = Pick<TimelineState, 'activeTurn' | 'closedTurns' | 'stepTimings' | 'turnUsageTracking'>
const EMPTY_STEP_TIMINGS: Readonly<Record<string, AssistantTiming>> = Object.freeze({})
const EMPTY_CLOSED_TURNS: ReadonlySet<number> = new Set()
const EMPTY_TURN_USAGE_TRACKING: Readonly<Record<string, TurnUsageTracking>> = Object.freeze({})

interface TurnTracking {
  activeTurn: number | undefined
  readonly snapshot: () => Snapshot
  readonly readStepTimings: () => Readonly<Record<string, AssistantTiming>>
  readonly hasClosedTurn: (turn: number) => boolean
  readonly readTurnUsage: (turn: number) => TurnUsageTracking | undefined
  readonly trackTurnStart: (turn: number, duplicate: boolean) => void
  readonly trackStepStart: (turn: number, step: number) => void
  readonly settleUsageAttempt: (
    turn: number,
    step: number | undefined,
    usage: TokenUsage | undefined,
    settlement: 'attempt-settled' | 'message-settled',
  ) => void
  readonly scheduleUsageRetry: (turn: number, step: number, id: string, attempt: number) => void
  readonly startUsageRetry: (turn: number, step: number, id: string, attempt: number) => void
  readonly closeUsageStep: (turn: number, step: number) => void
  readonly noteStepActivity: (turn: number, step: number | undefined) => void
  readonly invalidateTurnUsage: (turn: number | undefined) => void
  readonly commitTiming: (key: string | undefined, timing: AssistantTiming | undefined) => void
  readonly deleteStepTiming: (key: string | undefined) => void
  readonly deleteStepTimingsForTurn: (turn: number) => void
  readonly openTurn: (turn: number) => void
  readonly reopenTurn: (turn: number) => void
  readonly recordClosedTurn: (turn: number) => void
  readonly forgetTurnUsage: (turn: number) => void
}

/** Own a copy-on-write turn/attempt ledger for one immutable reducer transition. */
export function createTurnTracking(state: Snapshot): TurnTracking {
  let stepTimings: Record<string, AssistantTiming> | undefined
  let turnUsageTracking: Record<string, TurnUsageTracking> | undefined
  let activeTurn = state.activeTurn
  let closedTurns: Set<number> | undefined
  const readStepTimings = (): Readonly<Record<string, AssistantTiming>> =>
    stepTimings ?? state.stepTimings ?? EMPTY_STEP_TIMINGS
  const ensureStepTimings = (): Record<string, AssistantTiming> => {
    if (stepTimings === undefined) stepTimings = { ...(state.stepTimings ?? EMPTY_STEP_TIMINGS) }
    return stepTimings
  }
  const hasClosedTurn = (turn: number): boolean =>
    closedTurns?.has(turn) ?? state.closedTurns?.includes(turn) ?? false
  const ensureClosedTurns = (): Set<number> => {
    if (closedTurns === undefined) closedTurns = new Set(state.closedTurns ?? EMPTY_CLOSED_TURNS)
    return closedTurns
  }
  const readTurnUsageTracking = (): Readonly<Record<string, TurnUsageTracking>> =>
    turnUsageTracking ?? state.turnUsageTracking ?? EMPTY_TURN_USAGE_TRACKING
  const readTurnUsage = (turn: number): TurnUsageTracking | undefined => readTurnUsageTracking()[String(turn)]
  const writeTurnUsage = (turn: number, tracking: TurnUsageTracking | undefined): void => {
    if (turnUsageTracking === undefined) turnUsageTracking = { ...readTurnUsageTracking() }
    const key = String(turn)
    if (tracking === undefined) delete turnUsageTracking[key]
    else turnUsageTracking[key] = tracking
  }
  const trackTurnStart = (turn: number, duplicate: boolean): void => {
    const previous = readTurnUsage(turn)
    writeTurnUsage(turn, {
      turnStarted: true,
      invalid: duplicate || previous !== undefined,
      attempts: previous?.attempts ?? [],
      ...(previous?.active === undefined ? {} : { active: previous.active }),
    })
  }
  const trackStepStart = (turn: number, step: number): void => {
    const tracking = readTurnUsage(turn) ?? { turnStarted: false, invalid: false, attempts: [] }
    writeTurnUsage(turn, {
      ...tracking,
      invalid: tracking.invalid || tracking.active !== undefined,
      active: { step, state: 'open' },
    })
  }
  const settleUsageAttempt = (
    turn: number,
    step: number | undefined,
    usage: TokenUsage | undefined,
    settlement: 'attempt-settled' | 'message-settled',
  ): void => {
    const tracking = readTurnUsage(turn)
    if (tracking === undefined) return
    const active = tracking.active
    if (step === undefined || active === undefined || active.step !== step || active.state !== 'open') {
      writeTurnUsage(turn, { ...tracking, invalid: true })
      return
    }
    writeTurnUsage(turn, {
      ...tracking,
      invalid: tracking.invalid || usage === undefined,
      attempts: usage === undefined ? tracking.attempts : [...tracking.attempts, usage],
      active: { step, state: settlement },
    })
  }
  const scheduleUsageRetry = (turn: number, step: number, id: string, attempt: number): void => {
    const tracking = readTurnUsage(turn)
    if (tracking === undefined) return
    const active = tracking.active
    if (active === undefined || active.step !== step || active.state !== 'attempt-settled') {
      writeTurnUsage(turn, { ...tracking, invalid: true })
      return
    }
    writeTurnUsage(turn, {
      ...tracking,
      active: { step, state: 'retry-scheduled', retry: { id, attempt } },
    })
  }
  const startUsageRetry = (turn: number, step: number, id: string, attempt: number): void => {
    const tracking = readTurnUsage(turn)
    if (tracking === undefined) return
    const active = tracking.active
    if (
      active === undefined ||
      active.step !== step ||
      active.state !== 'retry-scheduled' ||
      active.retry?.id !== id ||
      active.retry.attempt !== attempt
    ) {
      writeTurnUsage(turn, { ...tracking, invalid: true })
      return
    }
    writeTurnUsage(turn, { ...tracking, active: { step, state: 'open' } })
  }
  const closeUsageStep = (turn: number, step: number): void => {
    const tracking = readTurnUsage(turn)
    if (tracking === undefined) return
    const { active, ...rest } = tracking
    if (
      active === undefined ||
      active.step !== step ||
      (active.state !== 'attempt-settled' &&
        active.state !== 'retry-scheduled' &&
        active.state !== 'message-settled')
    ) {
      writeTurnUsage(turn, { ...tracking, invalid: true })
      return
    }
    writeTurnUsage(turn, rest)
  }
  const noteStepActivity = (turn: number, step: number | undefined): void => {
    const tracking = readTurnUsage(turn)
    if (tracking === undefined) return
    if (step === undefined) {
      writeTurnUsage(turn, { ...tracking, invalid: true })
      return
    }
    const active = tracking.active
    if (active?.step !== step || active.state !== 'open') writeTurnUsage(turn, { ...tracking, invalid: true })
  }
  const invalidateTurnUsage = (turn: number | undefined): void => {
    if (turn === undefined) return
    const tracking = readTurnUsage(turn)
    if (tracking !== undefined) writeTurnUsage(turn, { ...tracking, invalid: true })
  }
  const commitTiming = (key: string | undefined, timing: AssistantTiming | undefined): void => {
    if (key === undefined || timing === undefined || timing === readStepTimings()[key]) return
    ensureStepTimings()[key] = timing
  }
  const deleteStepTiming = (key: string | undefined): void => {
    if (key === undefined || !Object.prototype.hasOwnProperty.call(readStepTimings(), key)) return
    delete ensureStepTimings()[key]
  }
  const deleteStepTimingsForTurn = (turn: number): void => {
    const prefix = `${turn}:`
    for (const key of Object.keys(readStepTimings())) if (key.startsWith(prefix)) deleteStepTiming(key)
  }
  const openTurn = (turn: number): void => {
    if (!hasClosedTurn(turn)) activeTurn = turn
  }
  return {
    get activeTurn(): number | undefined {
      return activeTurn
    },
    set activeTurn(value: number | undefined) {
      activeTurn = value
    },
    readStepTimings,
    hasClosedTurn,
    readTurnUsage,
    trackTurnStart,
    trackStepStart,
    settleUsageAttempt,
    scheduleUsageRetry,
    startUsageRetry,
    closeUsageStep,
    noteStepActivity,
    invalidateTurnUsage,
    commitTiming,
    deleteStepTiming,
    deleteStepTimingsForTurn,
    openTurn,
    reopenTurn: (turn): void => {
      ensureClosedTurns().delete(turn)
    },
    recordClosedTurn: (turn): void => {
      ensureClosedTurns().add(turn)
    },
    forgetTurnUsage: (turn): void => {
      writeTurnUsage(turn, undefined)
    },
    snapshot: (): Snapshot => {
      const nextStepTimings = stepTimings ?? state.stepTimings
      const nextTurnUsageTracking = turnUsageTracking ?? state.turnUsageTracking
      const nextClosedTurns = closedTurns === undefined ? state.closedTurns : [...closedTurns]
      return {
        ...(nextStepTimings === undefined || Object.keys(nextStepTimings).length === 0
          ? {}
          : { stepTimings: nextStepTimings }),
        ...(nextTurnUsageTracking === undefined || Object.keys(nextTurnUsageTracking).length === 0
          ? {}
          : { turnUsageTracking: nextTurnUsageTracking }),
        ...(activeTurn === undefined ? {} : { activeTurn }),
        ...(nextClosedTurns === undefined || nextClosedTurns.length === 0
          ? {}
          : { closedTurns: nextClosedTurns }),
      }
    },
  }
}
