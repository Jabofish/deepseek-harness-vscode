import type { AssistantTiming } from './nodes.js'

export function timingKey(turn: number | undefined, step: number | undefined): string | undefined {
  return turn === undefined || step === undefined ? undefined : `${turn}:${step}`
}

function timingForEvent(
  timings: Readonly<Record<string, AssistantTiming>>,
  turn: number | undefined,
  step: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  return key === undefined ? undefined : timings[key]
}

export function noteFirstToken(
  timings: Readonly<Record<string, AssistantTiming>>,
  turn: number | undefined,
  step: number | undefined,
  time: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  if (key === undefined || time === undefined) return timingForEvent(timings, turn, step)
  const previous = timings[key] ?? { stepStartTime: null, firstTokenTime: null, completedTime: null }
  return previous.firstTokenTime === null ? { ...previous, firstTokenTime: time } : previous
}

export function completeTiming(
  timings: Readonly<Record<string, AssistantTiming>>,
  turn: number | undefined,
  step: number | undefined,
  time: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  if (key === undefined) return undefined
  const previous = timings[key] ?? { stepStartTime: null, firstTokenTime: null, completedTime: null }
  return time === undefined ? timings[key] : { ...previous, completedTime: time }
}
