import {
  AppError,
  EditorBridgeError,
  isEditorStateSnapshot,
  type EditorBridgeRepository,
  type EditorBridgeReply,
  type EditorStatePort,
  type EditorStateSnapshot,
} from '@dsh-vscode/domain'

interface Run {
  readonly controller: AbortController
  done: Promise<void>
}

/** An explicit, volatile grant. A stopped generation can never publish a late snapshot. */
export class EditorBridgeService {
  private current: Run | undefined
  public constructor(private readonly onStopped: () => void = () => undefined) {}
  public get active(): boolean {
    return this.current !== undefined
  }

  public start(
    repository: EditorBridgeRepository,
    sessionId: string,
    ownerId: string,
    port: EditorStatePort,
  ): Promise<void> {
    if (this.current !== undefined) return Promise.reject(new EditorBridgeError('busy'))
    const run: Run = { controller: new AbortController(), done: Promise.resolve() }
    this.current = run
    return new Promise<void>((resolve, reject) => {
      run.done = this.run(run, repository, sessionId, ownerId, port, resolve)
        .catch((error: unknown) => {
          reject(error instanceof Error ? error : new EditorBridgeError('unavailable'))
        })
        .finally(() => {
          if (this.current === run) {
            this.current = undefined
            this.onStopped()
          }
        })
    })
  }

  public stop(): Promise<void> {
    const run = this.current
    this.current = undefined
    run?.controller.abort()
    this.onStopped()
    return run?.done ?? Promise.resolve()
  }

  private async run(
    run: Run,
    repository: EditorBridgeRepository,
    sessionId: string,
    ownerId: string,
    port: EditorStatePort,
    ready: () => void,
  ): Promise<void> {
    const signal = run.controller.signal
    let bindingId: string | undefined
    try {
      const binding = await repository.attach(sessionId, ownerId, signal)
      bindingId = binding.bindingId
      signal.throwIfAborted()
      if (this.current !== run) throw new EditorBridgeError('cancelled')
      ready()
      while (!signal.aborted && this.current === run) {
        const request = await repository.poll(bindingId, signal)
        signal.throwIfAborted()
        if (request.kind === 'idle') continue
        let reply: EditorBridgeReply
        try {
          const snapshot = await readSnapshot(port, signal)
          reply = isEditorStateSnapshot(snapshot)
            ? { ok: true, snapshot }
            : { ok: false, reason: 'invalid-response' }
        } catch (error) {
          reply = { ok: false, reason: error instanceof EditorBridgeError ? error.reason : 'unavailable' }
        }
        if (signal.aborted || this.current !== run) break
        try {
          await repository.respond(bindingId, request.requestId, reply, signal)
        } catch (error) {
          // Tool cancellation or expiry invalidates this reply, not the user's sharing grant.
          if (!(error instanceof AppError && error.code === 'STALE_INTERACTION')) throw error
        }
        if (!reply.ok && ['untrusted', 'workspace-mismatch', 'invalid-response'].includes(reply.reason)) break
      }
    } finally {
      if (bindingId !== undefined)
        await repository.detach(bindingId, AbortSignal.timeout(2_000)).catch(() => undefined)
    }
  }
}

/** Observe late port failures, but do not let an uncancellable filesystem read hold up revocation. */
function readSnapshot(port: EditorStatePort, signal: AbortSignal): Promise<EditorStateSnapshot> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new EditorBridgeError('cancelled'))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return port.read(signal)
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort)
          reject(error instanceof Error ? error : new EditorBridgeError('unavailable'))
        },
      )
  })
}
