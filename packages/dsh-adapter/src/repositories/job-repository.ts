import { AppError, type BackendEvent, type JobRepository, type JobView } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export interface EventAwareJobRepository extends JobRepository {
  remember(event: BackendEvent): void
}

export class Rc6JobRepository implements EventAwareJobRepository {
  private readonly jobs = new Map<string, readonly JobView[]>()
  private readonly resetOnSubscribe: boolean
  private readonly supported: boolean
  public constructor(
    _transport: DshTransport,
    options?: { readonly resetOnSubscribe?: boolean; readonly supported?: boolean },
  ) {
    this.supported = options?.supported ?? true
    this.resetOnSubscribe = options?.resetOnSubscribe ?? true
  }

  public remember(event: BackendEvent): void {
    if (event.type === 'jobs.updated') this.jobs.set(event.sessionId, event.jobs)
    else if (event.type === 'session.subscribed') {
      if (!this.resetOnSubscribe) return
      // The pinned Host sends a baseline only when a session currently has
      // jobs. Every new subscription starts a fresh baseline: retaining a
      // snapshot from the previous stream would resurrect already-settled
      // process-local jobs when the reconnect carries no jobs frame.
      this.jobs.set(event.sessionId, [])
    } else if (event.type === 'session.removed')
      // The official runtime drops the jobs state when the session is
      // removed; keeping it would surface stale rows for a recycled id.
      this.jobs.delete(event.sessionId)
  }

  public list(sessionId: string, _signal?: AbortSignal): Promise<readonly JobView[]> {
    if (!this.supported)
      return Promise.reject(
        new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'This DSH version does not expose background jobs.',
          retryable: false,
        }),
      )
    // The official runtime treats an absent key as an empty set rather than
    // an error; the caller has simply not observed a subscription yet.
    return Promise.resolve(this.jobs.get(sessionId) ?? [])
  }
}
