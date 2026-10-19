import {
  AppError,
  EditorBridgeError,
  EditorCompanionError,
  EDITOR_COMPANION_LIMITS,
  editorValueMatches,
  isEditorCompanionValue,
  type EditorCompanionCapability,
  type EditorCompanionPoll,
  type EditorCompanionPort,
  type EditorCompanionReply,
  type EditorCompanionRepository,
  type EditorCompanionRequest,
} from '@dsh-vscode/domain'
import { delay, POLL_ATTEMPTS, retryDelay } from './poll-retry.js'

interface Work {
  readonly controller: AbortController
  done: Promise<void>
}
interface Run {
  readonly controller: AbortController
  readonly workers: Map<string, Work>
  done: Promise<void>
}
export type EditorCompanionStopReason = 'requested' | 'ended'

/**
 * Polling keeps leases alive while bounded independent reads run; revocation aborts all of them.
 * A short connection stall is retried, so it does not silently end the user's grant.
 */
export class EditorCompanionService {
  private current: Run | undefined
  public constructor(
    private readonly onStopped: (reason: EditorCompanionStopReason) => void = () => undefined,
  ) {}
  public get active(): boolean {
    return this.current !== undefined
  }
  public start(
    repository: EditorCompanionRepository,
    sessionId: string,
    ownerId: string,
    capabilities: readonly EditorCompanionCapability[],
    port: EditorCompanionPort,
  ): Promise<void> {
    if (this.current !== undefined) return Promise.reject(new EditorCompanionError('busy'))
    const run: Run = { controller: new AbortController(), workers: new Map(), done: Promise.resolve() }
    this.current = run
    return new Promise((resolve, reject) => {
      run.done = this.run(run, repository, sessionId, ownerId, capabilities, port, resolve)
        .catch((error: unknown) =>
          reject(error instanceof Error ? error : new EditorCompanionError('unavailable')),
        )
        .finally(() => {
          if (this.current === run) {
            this.current = undefined
            this.onStopped('ended')
          }
        })
    })
  }
  public stop(): Promise<void> {
    const run = this.current
    this.current = undefined
    run?.controller.abort()
    this.onStopped('requested')
    return run?.done ?? Promise.resolve()
  }
  private async run(
    run: Run,
    repository: EditorCompanionRepository,
    sessionId: string,
    ownerId: string,
    capabilities: readonly EditorCompanionCapability[],
    port: EditorCompanionPort,
    ready: () => void,
  ): Promise<void> {
    let bindingId: string | undefined
    const signal = run.controller.signal
    try {
      bindingId = (await repository.attach(sessionId, ownerId, capabilities, signal)).bindingId
      signal.throwIfAborted()
      ready()
      let failures = 0
      while (!signal.aborted && this.current === run) {
        let event: EditorCompanionPoll
        try {
          event = await repository.poll(bindingId, signal)
          failures = 0
        } catch (error) {
          if (signal.aborted) break
          failures += 1
          if (failures >= POLL_ATTEMPTS) throw error
          await delay(retryDelay(failures), signal)
          continue
        }
        signal.throwIfAborted()
        if (event.kind === 'idle') continue
        if (event.kind === 'cancel') {
          run.workers.get(event.requestId)?.controller.abort()
          continue
        }
        if (run.workers.has(event.requestId)) throw new EditorCompanionError('invalid-response')
        if (run.workers.size >= EDITOR_COMPANION_LIMITS.requests) {
          await repository.respond(bindingId, event.requestId, { ok: false, reason: 'busy' }, signal)
          continue
        }
        const work: Work = { controller: new AbortController(), done: Promise.resolve() }
        run.workers.set(event.requestId, work)
        work.done = this.execute(run, work, repository, bindingId, event.requestId, event.request, port)
          .catch(() => run.controller.abort())
          .finally(() => run.workers.delete(event.requestId))
      }
    } finally {
      run.controller.abort()
      await Promise.all([...run.workers.values()].map((work) => work.done))
      if (bindingId !== undefined)
        await repository.detach(bindingId, AbortSignal.timeout(2_000)).catch(() => undefined)
    }
  }
  private async execute(
    run: Run,
    work: Work,
    repository: EditorCompanionRepository,
    bindingId: string,
    requestId: string,
    request: EditorCompanionRequest,
    port: EditorCompanionPort,
  ): Promise<void> {
    const signal = AbortSignal.any([run.controller.signal, work.controller.signal])
    let reply: EditorCompanionReply
    try {
      const value = await abortable(() => port.execute(request, signal), signal)
      reply =
        isEditorCompanionValue(value) && editorValueMatches(request, value)
          ? { ok: true, value }
          : { ok: false, reason: 'invalid-response' }
    } catch (error) {
      reply = {
        ok: false,
        reason:
          error instanceof EditorCompanionError || error instanceof EditorBridgeError
            ? error.reason
            : 'unavailable',
      }
    }
    if (signal.aborted || this.current !== run) return
    try {
      await repository.respond(bindingId, requestId, reply, run.controller.signal)
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'STALE_INTERACTION')) throw error
    }
    if (!reply.ok && reply.reason === 'untrusted') run.controller.abort()
  }
}

function abortable<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new EditorCompanionError('cancelled'))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return read()
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort)
          reject(error instanceof Error ? error : new EditorCompanionError('unavailable'))
        },
      )
  })
}
