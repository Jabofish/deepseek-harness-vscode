import type { GoalView } from '@dsh-vscode/domain'

import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import type { AppState, StateSetter } from './types.js'

export interface GoalQueueActionDependencies {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
  readonly refreshGoals: () => Promise<void>
}

export interface GoalQueueActions {
  updateGoal(
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status' | 'maxGoalRounds'>>,
  ): Promise<void>
  clearGoal(goalId: string): Promise<void>
  updateQueue(inputId: string, text: string): Promise<void>
  removeQueue(inputId: string): Promise<void>
  steerQueue(inputId: string): Promise<void>
  /** Steer every still-queued pending input into the running turn (official empty-draft accelerated Enter). */
  steerAllQueued(): Promise<void>
}

export function createGoalQueueActions(dependencies: GoalQueueActionDependencies): GoalQueueActions {
  const { client, getState, setState, refreshGoals } = dependencies

  const updateGoal = async (
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status' | 'maxGoalRounds'>>,
  ): Promise<void> => {
    if (update.title === undefined && update.status === undefined && update.maxGoalRounds === undefined)
      return
    await client.request<unknown>({
      type: 'goal.update',
      requestId: requestId(),
      payload: { goalId, ...update },
    })
    setState((current) => ({
      ...current,
      goals: current.goals.map((goal) => (goal.id === goalId ? { ...goal, ...update } : goal)),
    }))
    await refreshGoals()
  }

  const clearGoal = async (goalId: string): Promise<void> => {
    await client.request<unknown>({
      type: 'goal.clear',
      requestId: requestId(),
      payload: { goalId },
    })
    setState((current) => ({
      ...current,
      goals: current.goals.filter((goal) => goal.id !== goalId),
    }))
  }

  const updateQueue = (inputId: string, text: string): Promise<void> =>
    client
      .request<unknown>({
        type: 'session.queue.update',
        requestId: requestId(),
        payload: { inputId, text },
      })
      .then(() => undefined)

  const removeQueue = (inputId: string): Promise<void> =>
    client
      .request<unknown>({
        type: 'session.queue.remove',
        requestId: requestId(),
        payload: { inputId },
      })
      .then(() => undefined)

  const steerQueue = (inputId: string): Promise<void> =>
    client
      .request<unknown>({
        type: 'session.queue.steer',
        requestId: requestId(),
        payload: { inputId },
      })
      .then(() => undefined)

  const steerAllQueued = async (): Promise<void> => {
    // Mirrors the official empty-draft accelerated Enter: every still-queued
    // pending input is steered FIFO into the running turn. Steer is
    // best-effort (a closed delivery window turns the item back into the
    // next waking Queue item), so failures of one row must not abort the rest.
    const targets = getState().queue.filter((item) => item.mode === 'queue')
    let firstFailure: unknown
    let failed = false
    for (const item of targets) {
      try {
        await client.request<unknown>({
          type: 'session.queue.steer',
          requestId: requestId(),
          payload: { inputId: item.id },
        })
      } catch (reason: unknown) {
        // Try every row, then report one failure to the App's public-error
        // boundary instead of silently losing a rejected steer request.
        if (!failed) firstFailure = reason
        failed = true
      }
    }
    if (failed) throw firstFailure
  }

  return { updateGoal, clearGoal, updateQueue, removeQueue, steerQueue, steerAllQueued }
}
