import { AppError, type BackendEvent, type GoalRepository, type GoalView } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'
import { walkHistoryPages } from './shared/guards.js'

/** Match the official web client's 50-message history pages. */
const HISTORY_PAGE_MESSAGES = 50
export class Rc6GoalRepository implements GoalRepository {
  private readonly refs = new Map<
    string,
    { readonly sessionId: string; readonly id: string; revision: number }
  >()
  private readonly goalCache = new Map<string, readonly GoalView[]>()
  public constructor(private readonly transport: DshTransport) {}

  public remember(event: BackendEvent): void {
    if (event.type === 'goal.updated') this.goalCache.set(event.sessionId, event.goals)
    else if (event.type === 'session.projection' && event.key === 'goal') {
      const goals = goalViewsFromProjection(event.value)
      if (goals === undefined) return
      this.goalCache.set(event.sessionId, goals)
      // Projection payloads carry the host-bumped {id, revision} pair; the
      // edit/complete/resume/pause calls are compare-and-swap on that token,
      // so it must stay as fresh as the cached view.
      replaceProjectionRefs(this.refs, event.sessionId, event.value)
    } else if (event.type === 'session.subscribed') {
      if (event.projection === undefined) {
        this.goalCache.delete(event.sessionId)
        clearProjectionRefs(this.refs, event.sessionId)
        return
      }
      const goals = goalViewsFromProjection(event.projection.values)
      // Keep the last usable state when a reconnect carries a malformed
      // projection. A bad advisory frame must not erase a valid cache.
      if (goals === undefined) return
      this.goalCache.set(event.sessionId, goals)
      replaceProjectionRefs(this.refs, event.sessionId, event.projection.values)
    } else if (event.type === 'session.removed') {
      this.goalCache.delete(event.sessionId)
      clearProjectionRefs(this.refs, event.sessionId)
    }
  }

  public sessionForGoal(goalId: string): string | undefined {
    return this.refs.get(goalId)?.sessionId
  }

  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly GoalView[]> {
    const cached = this.goalCache.get(sessionId)
    if (cached !== undefined) return cached
    // rc.6 deliberately exposes goal state through the session projection and
    // mux events; use history only until the live stream has supplied a cache.
    const pages = await walkHistoryPages(
      async (beforeSequence) => {
        const value = await callRpc<{ events: unknown[]; hasMore: boolean; projections?: unknown }>(
          this.transport,
          'session.history',
          {
            sessionId,
            maxMessages: HISTORY_PAGE_MESSAGES,
            ...(beforeSequence === undefined ? {} : { beforeSeq: beforeSequence }),
          },
          signal,
        )
        const mapped = rc6Mapper.history(value, sessionId)
        if (
          mapped.projection !== undefined &&
          goalViewsFromProjection(mapped.projection.values) !== undefined
        )
          replaceProjectionRefs(this.refs, sessionId, mapped.projection.values)
        return mapped
      },
      {
        stopWhen: (page) => goalViewsFromProjection(page.projection?.values) !== undefined,
      },
    )
    let latest: readonly GoalView[] | undefined
    for (const mapped of pages) {
      const projectionGoals = goalViewsFromProjection(mapped.projection?.values)
      if (projectionGoals !== undefined && latest === undefined) latest = projectionGoals
      for (let index = mapped.events.length - 1; index >= 0; index -= 1) {
        const event = mapped.events[index]?.event
        if (event?.type === 'goal.updated' && latest === undefined) latest = event.goals
      }
    }
    const goals = latest ?? []
    // The mux observer (remember) can populate the cache while this walk is
    // in flight. Delivered event state is newer than anything derived from a
    // walk that started earlier; keep and return it instead of overwriting,
    // or the projection would stay stale until the next goal change.
    if (!this.goalCache.has(sessionId)) this.goalCache.set(sessionId, goals)
    return this.goalCache.get(sessionId) ?? goals
  }

  public async create(
    sessionId: string,
    title: string,
    signal?: AbortSignal,
    maxGoalRounds?: number,
  ): Promise<GoalView> {
    const value = assertGoalRefReceipt(
      await callRpc<unknown>(
        this.transport,
        'goal.create',
        { sessionId, objective: title, ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }) },
        signal,
      ),
      'create',
    )
    this.refs.set(value.id, { sessionId, id: value.id, revision: value.revision })
    const goal = {
      id: value.id,
      title,
      status: 'in-progress' as const,
      ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
    }
    const cached = this.goalCache.get(sessionId)
    // The host's goal.updated event can land before the HTTP receipt resolves
    // (mux vs HTTP ordering is not guaranteed); never append a second copy.
    if (cached !== undefined && !cached.some((existing) => existing.id === value.id))
      this.goalCache.set(sessionId, [...cached, goal])
    return goal
  }

  public async update(
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status' | 'maxGoalRounds'>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const ref = this.refs.get(goalId)
    if (ref === undefined) throw unavailable('goal update without a current session revision')
    const editRequested = update.title !== undefined || update.maxGoalRounds !== undefined
    if (editRequested && update.status !== undefined)
      throw unavailable('combined goal title and status edits')
    if (editRequested) {
      const value = assertGoalRefReceipt(
        await callRpc<unknown>(
          this.transport,
          'goal.edit',
          {
            sessionId: ref.sessionId,
            ref: { id: ref.id, revision: ref.revision },
            ...(update.title === undefined ? {} : { objective: update.title }),
            ...(update.maxGoalRounds === undefined ? {} : { maxGoalRounds: update.maxGoalRounds }),
          },
          signal,
        ),
        'edit',
      )
      assertSameGoalRef(ref, value, 'edit')
      ref.revision = value.revision
      this.patchCachedGoal(ref.sessionId, ref.id, {
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.maxGoalRounds === undefined ? {} : { maxGoalRounds: update.maxGoalRounds }),
      })
    }
    if (update.status === 'completed') {
      const value = assertGoalRefReceipt(
        await callRpc<unknown>(
          this.transport,
          'goal.complete',
          { sessionId: ref.sessionId, ref: { id: ref.id, revision: ref.revision } },
          signal,
        ),
        'complete',
      )
      assertSameGoalRef(ref, value, 'complete')
      ref.revision = value.revision
      this.patchCachedGoal(ref.sessionId, ref.id, { status: 'completed' })
    } else if (update.status === 'in-progress') {
      const value = assertGoalRefReceipt(
        await callRpc<unknown>(
          this.transport,
          'goal.resume',
          { sessionId: ref.sessionId, ref: { id: ref.id, revision: ref.revision } },
          signal,
        ),
        'resume',
      )
      assertSameGoalRef(ref, value, 'resume')
      ref.revision = value.revision
      this.patchCachedGoal(ref.sessionId, ref.id, { status: 'in-progress' })
    } else if (update.status === 'pending' || update.status === 'blocked') {
      const value = assertGoalRefReceipt(
        await callRpc<unknown>(
          this.transport,
          'goal.pause',
          { sessionId: ref.sessionId, ref: { id: ref.id, revision: ref.revision } },
          signal,
        ),
        'pause',
      )
      assertSameGoalRef(ref, value, 'pause')
      ref.revision = value.revision
      this.patchCachedGoal(ref.sessionId, ref.id, { status: update.status })
    }
  }

  public async clear(goalId: string, signal?: AbortSignal): Promise<void> {
    const ref = this.refs.get(goalId)
    if (ref === undefined) throw unavailable('goal clear without a current session revision')
    const value = asRecord(
      await callRpc<unknown>(
        this.transport,
        'goal.clear',
        { sessionId: ref.sessionId, ref: { id: ref.id, revision: ref.revision } },
        signal,
      ),
    )
    if (value?.cleared !== true) throw malformedGoalResponse('clear receipt')
    this.refs.delete(goalId)
    const sessionGoals = this.goalCache.get(ref.sessionId)
    if (sessionGoals !== undefined)
      this.goalCache.set(
        ref.sessionId,
        sessionGoals.filter((goal) => goal.id !== goalId),
      )
  }

  private patchCachedGoal(sessionId: string, goalId: string, patch: Partial<GoalView>): void {
    const goals = this.goalCache.get(sessionId)
    if (goals === undefined) return
    this.goalCache.set(
      sessionId,
      goals.map((goal) => (goal.id === goalId ? { ...goal, ...patch } : goal)),
    )
  }
}

function goalViewsFromProjection(value: unknown): readonly GoalView[] | undefined {
  const goal = goalSnapshotFromProjection(value)
  if (goal === null) return []
  if (goal === undefined) return undefined
  const id = typeof goal.id === 'string' ? goal.id : undefined
  const title =
    typeof goal.title === 'string'
      ? goal.title
      : typeof goal.objective === 'string'
        ? goal.objective
        : undefined
  const phase = goal.phase
  const status = goal.status
  const maxGoalRounds = goal.maxGoalRounds === undefined ? undefined : positiveSafeInteger(goal.maxGoalRounds)
  if (id === undefined || id.trim() === '' || title === undefined || title.trim() === '') return undefined
  if (goal.maxGoalRounds !== undefined && maxGoalRounds === undefined) return undefined
  if (
    status !== undefined &&
    status !== 'pending' &&
    status !== 'in-progress' &&
    status !== 'completed' &&
    status !== 'blocked'
  )
    return undefined
  const mappedStatus =
    status ??
    (phase === 'active'
      ? 'in-progress'
      : phase === 'paused'
        ? 'pending'
        : phase === 'blocked'
          ? 'blocked'
          : phase === 'complete'
            ? 'completed'
            : undefined)
  if (mappedStatus === undefined) return undefined
  const blockedReason = goalBlockedReason(goal.blockedReason)
  return [
    {
      id,
      title,
      status: mappedStatus,
      ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
      ...(blockedReason === undefined ? {} : { blockedReason }),
    },
  ]
}

/** Keep the host's block reason only when both halves are present and usable. */
function goalBlockedReason(value: unknown): { readonly code: string; readonly message: string } | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const code = typeof record.code === 'string' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  if (code === undefined || code.trim() === '' || message === undefined || message.trim() === '')
    return undefined
  return { code, message }
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function assertGoalRefReceipt(
  value: unknown,
  operation: string,
): { readonly id: string; readonly revision: number } {
  const record = asRecord(value)
  const ref = asRecord(record?.ref)
  if (
    ref !== undefined &&
    typeof ref.id === 'string' &&
    ref.id.trim() !== '' &&
    Number.isSafeInteger(ref.revision) &&
    (ref.revision as number) > 0
  )
    return { id: ref.id, revision: ref.revision as number }
  throw malformedGoalResponse(`${operation} receipt`)
}

function assertSameGoalRef(
  current: { readonly id: string; readonly revision: number },
  next: { readonly id: string; readonly revision: number },
  operation: string,
): void {
  if (current.id !== next.id || next.revision <= current.revision)
    throw malformedGoalResponse(`${operation} receipt`)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function malformedGoalResponse(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed goal ${part}.`,
    retryable: false,
  })
}

function replaceProjectionRefs(
  refs: Map<string, { readonly sessionId: string; readonly id: string; revision: number }>,
  sessionId: string,
  value: unknown,
): void {
  clearProjectionRefs(refs, sessionId)
  const goal = goalSnapshotFromProjection(value)
  if (goal === undefined || goal === null) return
  const revision = goal.revision
  if (
    typeof goal.id === 'string' &&
    typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision >= 1
  )
    refs.set(goal.id, { sessionId, id: goal.id, revision })
}

function clearProjectionRefs(
  refs: Map<string, { readonly sessionId: string; readonly id: string; revision: number }>,
  sessionId: string,
): void {
  for (const [goalId, ref] of refs) if (ref.sessionId === sessionId) refs.delete(goalId)
}

function goalSnapshotFromProjection(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null
  const values = asRecord(value)
  if (values === undefined || !Object.prototype.hasOwnProperty.call(values, 'goal')) return undefined
  if (values.goal === null) return null
  const projection = asRecord(values.goal)
  if (projection === undefined) return undefined
  if (!Object.prototype.hasOwnProperty.call(projection, 'goal')) return projection
  if (projection.goal === null) return null
  return asRecord(projection.goal)
}
