import type { JobRepository, JobView } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6JobRepository implements JobRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(sessionId: string, signal?: AbortSignal): Promise<readonly JobView[]> {
    return unimplemented('rc6 list jobs', this.requirements('list', sessionId, signal))
  }

  public cancel(jobId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented('rc6 cancel job', this.requirements('cancel', jobId, signal))
  }

  private requirements(operation: string, key: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'map official rc6 background job RPCs and status events',
      'cancel only the requested job and never terminate the DSH process',
      'add running, complete, failed, stale, and cancel contract tests',
      `operation ${operation}; key ${key}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
