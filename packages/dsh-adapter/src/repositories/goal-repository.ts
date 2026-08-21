import { AppError, type BackendEvent, type GoalRepository, type GoalView } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'

export class Rc6GoalRepository implements GoalRepository {
  private readonly refs = new Map<
    string,
    { readonly sessionId: string; readonly id: string; revision: number }
  >()
  private readonly goalCache = new Map<string, readonly GoalView[]>()
  public constructor(private readonly transport: DshTransport) {}

  public remember(event: BackendEvent): void {
    if (event.type === 'goal.updated') this.goalCache.set(event.sessionId, event.goals)
    else if (event.type === 'session.subscribed' || event.type === 'session.removed')
      this.goalCache.delete(event.sessionId)
  }

  public sessionForGoal(goalId: string): string | undefined {
    return this.refs.get(goalId)?.sessionId
  }

  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly GoalView[]> {
    const cached = this.goalCache.get(sessionId)
    if (cached !== undefined) return cached
    // rc.6 deliberately exposes goal state through the session projection and
    // mux events; use history only until the live stream has supplied a cache.
    let beforeSeq: number | undefined
    let latest: readonly GoalView[] | undefined
    for (let page = 0; page < 100; page += 1) {
      const value = await callRpc<{ events: unknown[]; hasMore: boolean; projections?: unknown }>(
        this.transport,
        'session.history',
        { sessionId, maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
        signal,
      )
      const mapped = rc6Mapper.history(value, sessionId)
      rememberProjectionRefs(this.refs, sessionId, mapped.projection?.values)
      for (let index = mapped.events.length - 1; index >= 0; index -= 1) {
        const event = mapped.events[index]?.event
        if (event?.type === 'goal.updated' && latest === undefined) latest = event.goals
      }
      if (!mapped.hasMore) break
      const sequences = mapped.events.map((entry) => entry.sequence).filter((entry) => entry >= 0)
      const oldest = sequences.length === 0 ? undefined : Math.min(...sequences)
      if (oldest === undefined || (beforeSeq !== undefined && oldest >= beforeSeq)) break
      beforeSeq = oldest
    }
    const goals = latest ?? []
    this.goalCache.set(sessionId, goals)
    return goals
  }

  public async create(sessionId: string, title: string, signal?: AbortSignal): Promise<GoalView> {
    const value = assertGoalRefReceipt(
      await callRpc<unknown>(this.transport, 'goal.create', { sessionId, objective: title }, signal),
      'create',
    )
    this.refs.set(value.id, { sessionId, id: value.id, revision: value.revision })
    const goal = { id: value.id, title, status: 'in-progress' as const }
    const cached = this.goalCache.get(sessionId)
    if (cached !== undefined) this.goalCache.set(sessionId, [...cached, goal])
    return goal
  }

  public async update(
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status'>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const ref = this.refs.get(goalId)
    if (ref === undefined) throw unavailable('goal update without a current session revision')
    if (update.title !== undefined && update.status !== undefined)
      throw unavailable('combined goal title and status edits')
    if (update.title !== undefined) {
      const value = assertGoalRefReceipt(
        await callRpc<unknown>(
          this.transport,
          'goal.edit',
          {
            sessionId: ref.sessionId,
            ref: { id: ref.id, revision: ref.revision },
            objective: update.title,
          },
          signal,
        ),
        'edit',
      )
      assertSameGoalRef(ref, value, 'edit')
      ref.revision = value.revision
      this.patchCachedGoal(ref.sessionId, ref.id, { title: update.title })
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

function rememberProjectionRefs(
  refs: Map<string, { readonly sessionId: string; readonly id: string; revision: number }>,
  sessionId: string,
  value: unknown,
  depth = 0,
): void {
  if (depth > 4 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const entry of value) rememberProjectionRefs(refs, sessionId, entry, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  if (depth === 0) {
    for (const [key, entry] of Object.entries(record))
      if (/^goals?$/i.test(key)) rememberProjectionRefs(refs, sessionId, entry, depth + 1)
    return
  }
  const revision = record.revision
  if (
    typeof record.id === 'string' &&
    typeof revision === 'number' &&
    Number.isInteger(revision) &&
    revision >= 1
  )
    refs.set(record.id, { sessionId, id: record.id, revision })
  for (const entry of Object.values(record)) rememberProjectionRefs(refs, sessionId, entry, depth + 1)
}
