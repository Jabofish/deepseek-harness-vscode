import type { SubagentRepository, SubagentView } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6SubagentRepository implements SubagentRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(sessionId: string, signal?: AbortSignal): Promise<readonly SubagentView[]> {
    return unimplemented('rc6 list subagents', this.requirements('list', sessionId, signal))
  }

  public send(sessionId: string, message: string, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 send subagent message',
      this.requirements('send', `${sessionId}:${message.length}`, signal),
    )
  }

  public interrupt(sessionId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented('rc6 interrupt subagent', this.requirements('interrupt', sessionId, signal))
  }

  private requirements(operation: string, key: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'map official rc6 subagent list, state, and messaging APIs',
      'retain parent-child session identity and route events to the correct drawer',
      'add multi-agent and stale-session contract tests',
      `operation ${operation}; key ${key}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
