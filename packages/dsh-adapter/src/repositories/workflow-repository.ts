import type { WorkflowRepository, WorkflowSummary } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6WorkflowRepository implements WorkflowRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(sessionId: string, signal?: AbortSignal): Promise<readonly WorkflowSummary[]> {
    return unimplemented('rc6 list workflows', this.requirements('list', sessionId, signal))
  }

  public start(sessionId: string, workflowId: string, signal?: AbortSignal): Promise<WorkflowSummary> {
    return unimplemented(
      'rc6 start workflow',
      this.requirements('start', `${sessionId}:${workflowId}`, signal),
    )
  }

  public cancel(workflowId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented('rc6 cancel workflow', this.requirements('cancel', workflowId, signal))
  }

  private requirements(operation: string, key: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'map official rc6 Workflow and Ralph lifecycle RPCs and events',
      'preserve stage ordering, transitions, failure details, and cancellation state',
      'never infer workflow completion from model text',
      `operation ${operation}; key ${key}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
