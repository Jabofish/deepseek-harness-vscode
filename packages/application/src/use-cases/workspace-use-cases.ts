import type { WorkspaceCreateInput, WorkspaceSummary } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class WorkspaceUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public list(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
    return unimplemented<Promise<readonly WorkspaceSummary[]>>('list DSH workspaces', [
      'delegate through the active domain repository and preserve server ordering',
      'merge no VS Code folders into DSH state without explicit user action',
      `signal present ${String(signal !== undefined)}; backend guard available ${String(this.backendService !== undefined)}`,
    ])
  }

  public create(input: WorkspaceCreateInput, signal?: AbortSignal): Promise<WorkspaceSummary> {
    return unimplemented<Promise<WorkspaceSummary>>('create DSH workspace', [
      'accept paths only from an Extension Host folder picker or current trusted workspace',
      'validate name and prevent accidental duplicate creation',
      `name ${input.name}; path length ${input.path.length}; signal present ${String(signal !== undefined)}`,
    ])
  }

  public rename(workspaceId: string, name: string, signal?: AbortSignal): Promise<void> {
    return unimplemented<Promise<void>>('rename DSH workspace', [
      'validate non-empty bounded name and delegate to DSH',
      `workspace ${workspaceId}; name ${name}; signal present ${String(signal !== undefined)}`,
    ])
  }

  public remove(workspaceId: string, signal?: AbortSignal): Promise<void> {
    return unimplemented<Promise<void>>('remove DSH workspace', [
      'require explicit confirmation that explains session impact',
      'remove only the DSH workspace record unless the upstream API explicitly documents file deletion',
      `workspace ${workspaceId}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
