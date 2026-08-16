import type { WorkspaceCreateInput, WorkspaceSummary } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class WorkspaceUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public list(signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> {
    return this.backendService.requireBackend().workspaces.list(signal)
  }

  public create(input: WorkspaceCreateInput, signal?: AbortSignal): Promise<WorkspaceSummary> {
    if (input.name.trim() === '' || input.name.length > 256) throw new Error('Workspace name is invalid')
    return this.backendService.requireBackend().workspaces.create(input, signal)
  }

  public rename(workspaceId: string, name: string, signal?: AbortSignal): Promise<void> {
    if (workspaceId.trim() === '' || name.trim() === '' || name.length > 256)
      throw new Error('Workspace name is invalid')
    return this.backendService.requireBackend().workspaces.rename(workspaceId, name, signal)
  }

  public remove(workspaceId: string, signal?: AbortSignal): Promise<void> {
    return this.backendService.requireBackend().workspaces.remove(workspaceId, signal)
  }
}
