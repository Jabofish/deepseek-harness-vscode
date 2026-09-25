import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import {
  Rc6SessionRepository,
  type Rc6SessionRepositoryOptions,
} from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { unwrapOptionalRpcResultValue } from '../rc6/rpc.js'

const INITIALIZE_DEFAULT_MODEL = 'session/initializeDefaultModel'

/** RC2-only Session Remote added after account authorization succeeds. */
export class Rc172SessionRepository extends Rc6SessionRepository {
  public constructor(
    private readonly remoteTransport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
    samePath: ((left: string, right: string) => boolean) | undefined,
    options: Rc6SessionRepositoryOptions,
  ) {
    super(remoteTransport, workspaces, samePath, options)
  }

  public async initializeDefaultModel(signal?: AbortSignal): Promise<void> {
    const result = await this.remoteTransport.remoteRequest(INITIALIZE_DEFAULT_MODEL, {}, signal)
    const value = unwrapOptionalRpcResultValue<unknown>(result, INITIALIZE_DEFAULT_MODEL)
    if (value !== undefined)
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned an unexpected value for default model initialization.',
        retryable: false,
      })
  }
}
