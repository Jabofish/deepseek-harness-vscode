import type { GoalRepository, GoalView } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'

export class Rc6GoalRepository implements GoalRepository {
  private readonly refs = new Map<
    string,
    { readonly sessionId: string; readonly id: string; revision: number }
  >()
  public constructor(private readonly transport: DshTransport) {}

  public async list(sessionId: string, signal?: AbortSignal): Promise<readonly GoalView[]> {
    // rc.6 deliberately exposes goal state through the session projection and
    // mux events; recover the latest durable value from the history tail.
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
    return latest ?? []
  }

  public async create(sessionId: string, title: string, signal?: AbortSignal): Promise<GoalView> {
    const value = await callRpc<{ ref: { id: string; revision: number } }>(
      this.transport,
      'goal.create',
      { sessionId, objective: title },
      signal,
    )
    this.refs.set(value.ref.id, { sessionId, id: value.ref.id, revision: value.ref.revision })
    return { id: value.ref.id, title, status: 'in-progress' }
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
      const value = await callRpc<{ ref: { id: string; revision: number } }>(
        this.transport,
        'goal.edit',
        {
          sessionId: ref.sessionId,
          ref: { id: ref.id, revision: ref.revision },
          objective: update.title,
        },
        signal,
      )
      ref.revision = value.ref.revision
    }
    if (update.status === 'completed') {
      const value = await callRpc<{ ref: { id: string; revision: number } }>(
        this.transport,
        'goal.complete',
        { sessionId: ref.sessionId, ref: { id: ref.id, revision: ref.revision } },
        signal,
      )
      ref.revision = value.ref.revision
    } else if (update.status === 'in-progress') {
      const value = await callRpc<{ ref: { id: string; revision: number } }>(
        this.transport,
        'goal.resume',
        { sessionId: ref.sessionId, ref: { id: ref.id, revision: ref.revision } },
        signal,
      )
      ref.revision = value.ref.revision
    } else if (update.status === 'pending' || update.status === 'blocked') {
      const value = await callRpc<{ ref: { id: string; revision: number } }>(
        this.transport,
        'goal.pause',
        { sessionId: ref.sessionId, ref: { id: ref.id, revision: ref.revision } },
        signal,
      )
      ref.revision = value.ref.revision
    }
  }

  public async clear(goalId: string, signal?: AbortSignal): Promise<void> {
    const ref = this.refs.get(goalId)
    if (ref === undefined) throw unavailable('goal clear without a current session revision')
    await callRpc(
      this.transport,
      'goal.clear',
      { sessionId: ref.sessionId, ref: { id: ref.id, revision: ref.revision } },
      signal,
    )
    this.refs.delete(goalId)
  }
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
    revision >= 0
  )
    refs.set(record.id, { sessionId, id: record.id, revision })
  for (const entry of Object.values(record)) rememberProjectionRefs(refs, sessionId, entry, depth + 1)
}
