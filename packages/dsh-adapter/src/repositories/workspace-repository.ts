import type { WorkspaceCreateInput, WorkspaceRepository, WorkspaceSummary } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6WorkspaceRepository implements WorkspaceRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
    return unimplemented('rc6 list workspaces', this.requirements('list', signal))
  }

  public create(input: WorkspaceCreateInput, signal?: AbortSignal): Promise<WorkspaceSummary> {
    return unimplemented('rc6 create workspace', this.requirements(`create:${input.path}`, signal))
  }

  public rename(workspaceId: string, name: string, signal?: AbortSignal): Promise<void> {
    return unimplemented('rc6 rename workspace', this.requirements(`rename:${workspaceId}:${name}`, signal))
  }

  public remove(workspaceId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented('rc6 remove workspace', this.requirements(`remove:${workspaceId}`, signal))
  }

  private requirements(operation: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'use official rc6 workspace RPCs',
      'normalize and validate filesystem paths without resolving outside the user-selected folder',
      'add contract tests for empty, duplicate, invalid, and active workspaces',
      `operation ${operation}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
