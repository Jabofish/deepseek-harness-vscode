import type { CommandRepository, DynamicCommand } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6CommandRepository implements CommandRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(sessionId?: string, signal?: AbortSignal): Promise<readonly DynamicCommand[]> {
    return unimplemented(
      'rc6 list dynamic commands',
      this.requirements(`list:${sessionId ?? 'global'}`, signal),
    )
  }

  public execute(sessionId: string, command: string, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 execute dynamic command',
      this.requirements(`execute:${sessionId}:${command}`, signal),
    )
  }

  private requirements(operation: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'discover built-in, skill, and plugin commands dynamically',
      'support plan, goal, compact, feedback, and future commands through typed DSH execution',
      'never send an unknown slash command to the model as ordinary prompt text',
      `operation ${operation}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
