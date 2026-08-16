import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

export class BackendService {
  private backend: DshBackend | undefined
  private unsubscribe: (() => void) | undefined
  private readonly replay = new Map<string, BackendEvent>()

  public attach(backend: DshBackend, onEvent: (event: BackendEvent) => void): void {
    if (this.backend !== backend) this.replay.clear()
    if (this.unsubscribe !== undefined) this.unsubscribe()
    // Connection ownership belongs to DshConnectionCoordinator.  Closing the
    // previous backend here races a concurrent attach and made one logical
    // connection have two independent owners.  This service only binds the
    // application event sink; the coordinator closes the backend and any
    // managed process exactly once during disconnect.
    this.backend = backend
    this.unsubscribe = backend.events.subscribe((event) => {
      this.remember(event)
      onEvent(event)
    })
    for (const event of this.replay.values()) onEvent(event)
  }

  public requireBackend(): DshBackend {
    if (this.backend !== undefined) return this.backend
    throw new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'Connect to a local DSH instance first.',
      retryable: true,
    })
  }

  public detach(): Promise<void> {
    const unsubscribe = this.unsubscribe
    const backend = this.backend
    this.unsubscribe = undefined
    this.backend = undefined
    this.replay.clear()
    unsubscribe?.()
    // Do not close the backend here.  The coordinator owns its lifetime and
    // may be in the middle of a serialized disconnect/replace operation.
    void backend
    return Promise.resolve()
  }

  private remember(event: BackendEvent): void {
    const key = replayKey(event)
    if (key === undefined) return
    if (event.type === 'permission.resolved') {
      this.replay.delete(`permission:${event.sessionId}:${event.requestId}`)
      return
    }
    if (event.type === 'question.resolved') {
      for (const replayKeyValue of this.replay.keys())
        if (replayKeyValue.startsWith(`question:${event.sessionId}:`)) this.replay.delete(replayKeyValue)
      return
    }
    this.replay.set(key, event)
    while (this.replay.size > 256) this.replay.delete(this.replay.keys().next().value as string)
  }
}

function replayKey(event: BackendEvent): string | undefined {
  switch (event.type) {
    case 'permission.requested':
      return `permission:${event.request.sessionId}:${event.request.id}`
    case 'question.requested':
      return `question:${event.question.sessionId}:${event.question.id}`
    case 'queue.updated':
    case 'goal.updated':
    case 'todo.updated':
    case 'jobs.updated':
    case 'session.subscribed':
    case 'session.projection':
    case 'session.configuration':
    case 'compaction.updated':
      return `${event.type}:${event.sessionId}:${'key' in event ? event.key : ''}`
    case 'job.updated':
      return `job:${event.sessionId}:${event.job.id}`
    case 'subagent.updated':
      return `subagent:${event.sessionId}:${event.subagent.id}`
    case 'session.status':
      return `status:${event.sessionId}`
    default:
      return undefined
  }
}
