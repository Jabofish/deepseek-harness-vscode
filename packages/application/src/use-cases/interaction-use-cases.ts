import type { PermissionOption } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class InteractionUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public respondToPermission(
    requestId: string,
    option: PermissionOption,
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented<Promise<void>>('respond to DSH permission request', [
      'look up the live request and reject an option not advertised by DSH',
      'serialize duplicate responses and return a recoverable stale-request result',
      `request ${requestId}; option ${option.id}; signal present ${String(signal !== undefined)}; backend guard ${String(this.backendService !== undefined)}`,
    ])
  }

  public respondToQuestion(
    questionId: string,
    response: string | readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented<Promise<void>>('respond to DSH user question', [
      'validate the response against the live single, multiple, or free-text question',
      'serialize duplicate responses and handle stale requests',
      `question ${questionId}; items ${Array.isArray(response) ? response.length : 1}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
