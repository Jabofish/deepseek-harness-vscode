import { AppError, type BackendEvent, type JobFollowFrame, type JobView } from '@dsh-vscode/domain'

export class JobFollowRegistry {
  private readonly controllers = new Map<string, RegisteredJobFollow>()
  private readonly starting = new Map<string, RegisteredJobFollow>()

  public async start<T>(
    key: string,
    followId: string,
    signal: AbortSignal,
    validate: (signal: AbortSignal) => Promise<T>,
    follow: (value: T, signal: AbortSignal) => void | Promise<void>,
  ): Promise<boolean> {
    signal.throwIfAborted()
    const controller = new AbortController()
    const checkSignal = AbortSignal.any([signal, controller.signal])
    this.cancelPendingStart(key)
    this.starting.set(key, { followId, controller })
    let pending = true
    try {
      const value = await validate(checkSignal)
      if (checkSignal.aborted || this.starting.get(key)?.controller !== controller) {
        this.cancelPendingStart(key, followId, controller)
        return false
      }
      this.starting.delete(key)
      pending = false
      this.stopActive(key)
      this.controllers.set(key, { followId, controller })
      void Promise.resolve(follow(value, controller.signal)).then(
        () => this.finish(key, controller),
        () => this.finish(key, controller),
      )
      return true
    } catch (error) {
      const cancelled = checkSignal.aborted || (pending && this.starting.get(key)?.controller !== controller)
      this.cancelPendingStart(key, followId, controller)
      this.finish(key, controller)
      controller.abort()
      if (cancelled) return false
      throw error
    }
  }

  public stop(key: string, followId: string): boolean {
    const stoppedPending = this.cancelPendingStart(key, followId)
    const stoppedActive = this.stopActive(key, followId)
    return stoppedPending || stoppedActive
  }

  public stopAll(): void {
    for (const entry of this.controllers.values()) entry.controller.abort()
    for (const entry of this.starting.values()) entry.controller.abort()
    this.controllers.clear()
    this.starting.clear()
  }

  private stopActive(key: string, followId?: string): boolean {
    const entry = this.controllers.get(key)
    if (entry === undefined || (followId !== undefined && entry.followId !== followId)) return false
    this.controllers.delete(key)
    entry.controller.abort()
    return true
  }

  private cancelPendingStart(key: string, followId?: string, expectedController?: AbortController): boolean {
    const entry = this.starting.get(key)
    if (
      entry === undefined ||
      (followId !== undefined && entry.followId !== followId) ||
      (expectedController !== undefined && entry.controller !== expectedController)
    )
      return false
    this.starting.delete(key)
    entry.controller.abort()
    return true
  }

  private finish(key: string, controller: AbortController): void {
    if (this.controllers.get(key)?.controller === controller) this.controllers.delete(key)
  }
}

interface RegisteredJobFollow {
  readonly followId: string
  readonly controller: AbortController
}

export function resolveJobFollowOffset(
  job: Pick<JobView, 'output'>,
  requestedFrom: number | undefined,
): number {
  const from = requestedFrom ?? job.output?.earliest ?? 0
  if (!Number.isSafeInteger(from) || from < 0)
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'The requested job output cursor is invalid.',
      retryable: false,
    })
  return from
}

export async function relayJobFollowFrames(input: {
  readonly sessionId: string
  readonly jobId: string
  readonly followId: string
  readonly frames: AsyncIterable<JobFollowFrame>
  readonly signal: AbortSignal
  readonly publish: (event: BackendEvent) => void
  readonly onFailure: (error: unknown) => void
}): Promise<void> {
  try {
    for await (const frame of input.frames) {
      input.publish({
        type: 'job.follow.updated',
        sessionId: input.sessionId,
        jobId: input.jobId,
        followId: input.followId,
        frame,
      })
    }
  } catch (error) {
    if (input.signal.aborted) return
    try {
      input.publish({
        type: 'job.follow.failed',
        sessionId: input.sessionId,
        jobId: input.jobId,
        followId: input.followId,
        reason: 'stream-failed',
      })
    } catch {
      // A failed publish cannot be repaired here; keep the upstream error local.
    }
    try {
      input.onFailure(error)
    } catch {
      // Diagnostics and the generic notice are best effort after the failure event.
    }
  }
}
