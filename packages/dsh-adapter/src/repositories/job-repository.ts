import type { BackendEvent, JobRepository, JobView } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { unavailable } from '../versions/rc6/rpc.js'

export class Rc6JobRepository implements JobRepository {
  private readonly jobs = new Map<string, readonly JobView[]>()
  public constructor(_transport: DshTransport) {}

  public remember(event: BackendEvent): void {
    if (event.type === 'jobs.updated') this.jobs.set(event.sessionId, event.jobs)
    else if (event.type === 'job.updated') {
      const current = [...(this.jobs.get(event.sessionId) ?? [])]
      const index = current.findIndex((job) => job.id === event.job.id)
      if (index < 0) current.push(event.job)
      else current[index] = event.job
      this.jobs.set(event.sessionId, current)
    }
  }

  public list(sessionId: string, _signal?: AbortSignal): Promise<readonly JobView[]> {
    const jobs = this.jobs.get(sessionId)
    return jobs === undefined ? Promise.reject(unavailable('background job snapshot')) : Promise.resolve(jobs)
  }
  public cancel(_jobId: string, _signal?: AbortSignal): Promise<void> {
    return Promise.reject(unavailable('background job control'))
  }
}
