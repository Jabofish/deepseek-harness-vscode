import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export class BackendService {
  private backend: DshBackend | undefined
  private unsubscribe: (() => void) | undefined

  public attach(backend: DshBackend, onEvent: (event: BackendEvent) => void): void {
    unimplemented<void>('application backend attachment lifecycle', [
      'detach and close prior client subscriptions before replacing a backend',
      'subscribe exactly once to normalized events',
      'forward events without leaking transport-specific payloads',
      `retain ${backend.connection.endpoint.baseUrl} and register the provided event callback`,
      `current backend present: ${String(this.backend !== undefined)}; callback type: ${typeof onEvent}`,
    ])
  }

  public requireBackend(): DshBackend {
    return unimplemented<DshBackend>('backend availability guard', [
      'return the active backend when connected',
      'throw a retryable BACKEND_UNREACHABLE AppError otherwise',
    ])
  }

  public async detach(): Promise<void> {
    return unimplemented<Promise<void>>('backend service detach', [
      'invoke the stored unsubscribe callback at most once',
      'close the current backend client',
      'clear backend and subscription references even if close fails',
      `stored unsubscribe present: ${String(this.unsubscribe !== undefined)}`,
    ])
  }
}
