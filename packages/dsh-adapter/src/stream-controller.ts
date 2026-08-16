import type { AsyncEventSource, BackendEvent } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from './contracts.js'

export class DshStreamController implements AsyncEventSource<BackendEvent> {
  public constructor(private readonly transport: DshTransport) {}

  public subscribe(listener: (event: BackendEvent) => void): () => void {
    return unimplemented<() => void>('shared normalized event subscription', [
      'maintain one upstream stream per connected backend, not one per Webview component',
      'multicast normalized immutable events to listeners',
      'start on first subscriber and release listener resources on unsubscribe',
      'sequence events monotonically and handle malformed frames without crashing the extension host',
      `listener type ${typeof listener}; transport available ${String(this.transport !== undefined)}`,
    ])
  }

  public close(): Promise<void> {
    return unimplemented<Promise<void>>('event controller disposal', [
      'cancel the read loop',
      'clear listeners',
      'close the transport once',
      'prevent events after close resolves',
    ])
  }
}
