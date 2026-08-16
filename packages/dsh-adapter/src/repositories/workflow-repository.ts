import type { WorkflowRepository, WorkflowSummary } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { unavailable } from '../versions/rc6/rpc.js'

export class Rc6WorkflowRepository implements WorkflowRepository {
  public constructor(_transport: DshTransport) {}
  public list(_sessionId: string, _signal?: AbortSignal): Promise<readonly WorkflowSummary[]> {
    return Promise.reject(unavailable('Workflow/Ralph inventory'))
  }
  public start(_sessionId: string, _workflowId: string, _signal?: AbortSignal): Promise<WorkflowSummary> {
    return Promise.reject(unavailable('Workflow/Ralph control'))
  }
  public cancel(_workflowId: string, _signal?: AbortSignal): Promise<void> {
    return Promise.reject(unavailable('Workflow/Ralph control'))
  }
}
