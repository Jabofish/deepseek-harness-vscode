import type { BackendEvent, JobRepository, JobView } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { unavailable } from '../versions/rc6/rpc.js'

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
  }

  public list(sessionId: string, _signal?: AbortSignal): Promise<readonly JobView[]> {
    const jobs = this.jobs.get(sessionId)
    return jobs === undefined ? Promise.reject(unavailable('background job snapshot')) : Promise.resolve(jobs)
  }
}
