import type { GoalRepository, GoalView } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6GoalRepository implements GoalRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(sessionId: string, signal?: AbortSignal): Promise<readonly GoalView[]> {
    return unimplemented('rc6 list goals', this.requirements('list', sessionId, signal))
  }

  public create(sessionId: string, title: string, signal?: AbortSignal): Promise<GoalView> {
    return unimplemented('rc6 create goal', this.requirements('create', `${sessionId}:${title}`, signal))
  }

  public update(
    goalId: string,
    update: Partial<Pick<GoalView, 'title' | 'status'>>,
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented('rc6 update goal', this.requirements('update', `${goalId}:${typeof update}`, signal))
  }

  private requirements(operation: string, key: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'map all official rc6 goal and todo RPCs and events',
      'preserve ordering, parent relationships, status, and token budget fields where supported',
      'add lifecycle contract tests',
      `operation ${operation}; key ${key}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
