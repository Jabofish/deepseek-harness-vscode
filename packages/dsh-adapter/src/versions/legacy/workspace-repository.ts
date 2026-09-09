import { unavailable } from '../rc6/rpc.js'
import { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'

/** 0.0.1 exposes session ordering but not the later workspace ordering RPC. */
export class LegacyWorkspaceRepository extends Rc6WorkspaceRepository {
  public override insertBefore(
    _workspaceId: string,
    _beforeWorkspaceId?: string,
    _signal?: AbortSignal,
  ): Promise<void> {
    return Promise.reject(unavailable('workspace ordering'))
  }
}
