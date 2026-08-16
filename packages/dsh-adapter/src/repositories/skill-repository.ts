import type { SkillDescriptor, SkillRepository } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6SkillRepository implements SkillRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    return unimplemented('rc6 list skills', this.requirements('list', signal))
  }

  public refresh(signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    return unimplemented('rc6 refresh skill discovery', this.requirements('refresh', signal))
  }

  public execute(sessionId: string, skillId: string, input: string, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 execute skill',
      this.requirements(`execute:${sessionId}:${skillId}:${input.length}`, signal),
    )
  }

  private requirements(operation: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'map official rc6 skill inventory, discovery, priority, and execution behavior',
      'preserve project, user, and plugin sources and let DSH resolve precedence',
      'require explicit invocation and never read skill files directly in the Webview',
      `operation ${operation}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
