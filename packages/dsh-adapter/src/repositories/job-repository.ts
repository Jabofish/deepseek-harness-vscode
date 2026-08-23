import type { BackendEvent, JobRepository, JobView } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6JobRepository implements JobRepository {
  private readonly jobs = new Map<string, readonly JobView[]>()
  public constructor(_transport: DshTransport) {}

  public remember(event: BackendEvent): void {
    if (event.type === 'jobs.updated') this.jobs.set(event.sessionId, event.jobs)
    else if (event.type === 'session.subscribed')
      // The pinned Host sends a baseline only when a session currently has
      // jobs. Every new subscription starts a fresh baseline: retaining a
      // snapshot from the previous stream would resurrect already-settled
      // process-local jobs when the reconnect carries no jobs frame.
      this.jobs.set(event.sessionId, [])
    else if (event.type === 'session.removed')
      // The official runtime drops the jobs state when the session is
      // removed; keeping it would surface stale rows for a recycled id.
      this.jobs.delete(event.sessionId)
  }

  public list(sessionId: string, _signal?: AbortSignal): Promise<readonly JobView[]> {
    // The official runtime treats an absent key as an empty set rather than
    // an error; the caller has simply not observed a subscription yet.
    return Promise.resolve(this.jobs.get(sessionId) ?? [])
  }
}
