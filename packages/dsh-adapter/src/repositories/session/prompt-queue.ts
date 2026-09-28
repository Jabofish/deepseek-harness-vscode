import {
  AppError,
  type BackendEvent,
  type PromptInput,
  type QueuedInput,
  type RunningInputMode,
} from '@dsh-vscode/domain'
import type { DshTransport } from '../../contracts.js'
import { callRpc, type RpcResponseLike, unavailable, unwrapRpcResult } from '../../versions/rc6/rpc.js'
import { clientTimeZoneField } from '../../client-time-zone.js'
import { encodePromptContent, type PromptContentLimits } from '../../attachment-codec.js'
import {
  assertAccepted,
  assertPromptContent,
  cancelledQueueMutation,
  findNewQueuedInput,
  isSettledSteer,
  queuedPromptKey,
  QUEUE_BASELINE_TIMEOUT_MS,
  QUEUE_IDENTITY_GRACE_MS,
  QUEUE_IDENTITY_TIMEOUT_MS,
  rejectQueueMutationOnAbort,
} from './queue-helpers.js'

export class SessionPromptQueue {
  private readonly queueOwners = new Map<string, string>()
  private readonly queues = new Map<string, readonly QueuedInput[]>()
  /** Preserve the user's order when multiple mutations target one Inbox row. */
  private readonly queueMutationTails = new Map<string, Promise<void>>()
  /** Monotonic Inbox projection cuts shared by control and follow streams. */
  private readonly queueProjectionSequences = new Map<string, number>()
  private readonly queueWaiters = new Map<string, Set<(items: readonly QueuedInput[]) => void>>()
  /**
   * Reads that arrived before the subscription published the queue baseline.
   * The mux delivers `session/subscribed` asynchronously, so a `session.open`
   * response can win the race against the baseline it depends on.
   */
  private readonly queueBaselineWaiters = new Map<string, Set<() => void>>()
  private readonly pendingQueueIdentities = new Map<string, Promise<QueuedInput | undefined>>()
  public constructor(
    private readonly transport: DshTransport,
    private readonly queueBaseline: 'subscription' | 'control' | 'control-follow',
    private readonly includesClientTimeZone: boolean,
    private readonly onSessionAccess: ((sessionId: string) => void) | undefined,
    private readonly promptContentLimits: (sessionId: string) => PromptContentLimits,
  ) {}

  public remember(event: BackendEvent): void {
    if (event.type !== 'queue.updated') {
      if (event.type === 'session.subscribed' && this.queueBaseline === 'subscription') {
        this.clearQueueState(event.sessionId)
        this.queues.set(event.sessionId, [])
        this.notifyQueueBaseline(event.sessionId)
      } else if (event.type === 'session.removed') {
        this.clearQueueState(event.sessionId)
      }
      return
    }
    // The alpha171+ queue is derived from versioned control/follow
    // projections. Accepting an unversioned legacy frame in the same profile
    // would bypass the cross-stream watermark. Older queue profiles keep their
    // historical unsequenced behavior because they use another baseline mode.
    if (this.queueBaseline === 'control-follow' && event.asOfSequence === undefined) return
    if (event.asOfSequence !== undefined) {
      if (
        !Number.isSafeInteger(event.asOfSequence) ||
        event.asOfSequence < 0 ||
        Object.is(event.asOfSequence, -0)
      )
        return
      const previousSequence = this.queueProjectionSequences.get(event.sessionId)
      // A cut is a complete queue snapshot. Equal cuts are idempotent only;
      // conflicting equal snapshots and older cross-stream frames are stale.
      if (previousSequence !== undefined && event.asOfSequence <= previousSequence) return
      this.queueProjectionSequences.set(event.sessionId, event.asOfSequence)
    }
    this.queues.set(event.sessionId, event.items)
    this.notifyQueueBaseline(event.sessionId)
    const previous = new Set(
      [...this.queueOwners.entries()]
        .filter(([, sessionId]) => sessionId === event.sessionId)
        .map(([inputId]) => inputId),
    )
    for (const itemId of previous) this.queueOwners.delete(itemId)
    for (const item of event.items) this.queueOwners.set(item.id, event.sessionId)
    for (const waiter of this.queueWaiters.get(event.sessionId) ?? []) waiter(event.items)
  }
  public async sendPrompt(
    input: PromptInput,
    mode: RunningInputMode = 'queue',
    signal?: AbortSignal,
  ): Promise<void> {
    assertPromptContent(input.text, input.attachments)
    const limits = this.promptContentLimits(input.sessionId)
    const receipt = await callRpc<unknown>(
      this.transport,
      'session.prompt',
      {
        sessionId: input.sessionId,
        mode,
        content: encodePromptContent(input.text, input.attachments, limits),
        ...(this.includesClientTimeZone ? clientTimeZoneField() : {}),
      },
      signal,
    )
    assertAccepted(receipt, 'session prompt')
  }

  public async enqueuePrompt(
    input: PromptInput,
    mode: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    assertPromptContent(input.text, input.attachments)
    const limits = this.promptContentLimits(input.sessionId)
    const promptKey = queuedPromptKey(input, mode)
    const pending = this.pendingQueueIdentities.get(promptKey)
    if (pending !== undefined) {
      const queued = await this.awaitQueueIdentity(pending, signal, QUEUE_IDENTITY_GRACE_MS)
      if (queued !== undefined) {
        this.queueOwners.set(queued.id, input.sessionId)
        return queued
      }
      if (this.pendingQueueIdentities.get(promptKey) === pending)
        this.pendingQueueIdentities.delete(promptKey)
    }
    const beforeIds = new Set(
      (this.queues.get(input.sessionId) ?? []).filter((item) => item.mode === mode).map((item) => item.id),
    )
    // Register the shared identity promise before the network round trip: a
    // concurrent identical enqueue issued while this request is in flight
    // must wait for this attempt's outcome instead of sending a second
    // session.prompt to the host.
    let resolveIdentity!: (value: QueuedInput | undefined) => void
    const identityPromise = new Promise<QueuedInput | undefined>((resolve) => {
      resolveIdentity = resolve
    })
    this.pendingQueueIdentities.set(promptKey, identityPromise)
    void identityPromise.then(
      (resolved) => {
        if (this.pendingQueueIdentities.get(promptKey) === identityPromise)
          this.pendingQueueIdentities.delete(promptKey)
        if (resolved !== undefined) this.queueOwners.set(resolved.id, input.sessionId)
      },
      () => {
        if (this.pendingQueueIdentities.get(promptKey) === identityPromise)
          this.pendingQueueIdentities.delete(promptKey)
      },
    )
    let response: RpcResponseLike<unknown>
    try {
      response = await this.transport.request<RpcResponseLike<unknown>>(
        'session.prompt',
        {
          sessionId: input.sessionId,
          mode,
          content: encodePromptContent(input.text, input.attachments, limits),
          ...(this.includesClientTimeZone ? clientTimeZoneField() : {}),
        },
        signal,
      )
      const receipt = unwrapRpcResult(response, 'session.prompt')
      assertAccepted(receipt, 'session prompt')
    } catch (error) {
      // Settle the shared promise so concurrent waiters retry on their own
      // instead of hanging for the whole grace window after a failed attempt.
      resolveIdentity(undefined)
      throw error
    }
    const queued = findNewQueuedInput(
      this.queues.get(input.sessionId),
      beforeIds,
      input,
      mode,
      response.rpcId,
    )
    if (queued !== undefined) {
      resolveIdentity(queued)
      this.queueOwners.set(queued.id, input.sessionId)
      return queued
    }
    void this.waitForQueuedIdentity(input, mode, beforeIds, response.rpcId, QUEUE_IDENTITY_GRACE_MS).then(
      (value) => resolveIdentity(value),
    )
    const waited = await this.awaitQueueIdentity(identityPromise, signal, QUEUE_IDENTITY_TIMEOUT_MS)
    if (waited !== undefined) {
      this.queueOwners.set(waited.id, input.sessionId)
      return waited
    }
    // The prompt was accepted, so a missing identity within the wait window
    // is a slow host rather than a broken protocol; classify it like every
    // other transport timeout instead of signalling protocol drift.
    throw new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'DSH accepted the prompt but did not publish its queue identity in time.',
      retryable: true,
      context: { method: 'session.prompt', timedOut: true },
    })
  }

  public async listQueue(sessionId: string, signal?: AbortSignal): Promise<readonly QueuedInput[]> {
    if (!this.queues.has(sessionId)) {
      // The control stream is the queue owner: a Session it never named has
      // nothing pending, so the read is an empty list rather than an unknown.
      if (this.queueBaseline === 'control') return []
      if (this.queueBaseline === 'control-follow') {
        if (signal?.aborted === true)
          throw new AppError({
            code: 'REQUEST_CANCELLED',
            message: 'The queue snapshot request was cancelled.',
            retryable: false,
          })
        // A fork may inherit Inbox state without producing a live control
        // projection frame. Open its durable follow stream and wait for the
        // version adapter's queue snapshot derived from session.subscribed.
        this.onSessionAccess?.(sessionId)
      }
      // A session that was just opened has no queue entry until its baseline
      // lands. Wait instead of reporting an empty queue while the host is still
      // delivering that session's authoritative snapshot.
      await this.waitForQueueBaseline(sessionId, signal)
      if (signal?.aborted === true)
        throw new AppError({
          code: 'REQUEST_CANCELLED',
          message: 'The queue snapshot request was cancelled.',
          retryable: false,
        })
      if (!this.queues.has(sessionId)) throw unavailable('queue snapshot')
    }
    const items = this.queues.get(sessionId) ?? []
    for (const item of items) this.queueOwners.set(item.id, sessionId)
    return items
  }

  private notifyQueueBaseline(sessionId: string): void {
    const waiters = this.queueBaselineWaiters.get(sessionId)
    if (waiters === undefined) return
    this.queueBaselineWaiters.delete(sessionId)
    for (const waiter of waiters) waiter()
  }

  private async waitForQueueBaseline(sessionId: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + QUEUE_BASELINE_TIMEOUT_MS
    while (!this.queues.has(sessionId) && !(signal?.aborted ?? false)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', finish)
          const waiters = this.queueBaselineWaiters.get(sessionId)
          waiters?.delete(onBaseline)
          if (waiters !== undefined && waiters.size === 0) this.queueBaselineWaiters.delete(sessionId)
          resolve()
        }
        const onBaseline = (): void => finish()
        const waiters = this.queueBaselineWaiters.get(sessionId) ?? new Set<() => void>()
        waiters.add(onBaseline)
        this.queueBaselineWaiters.set(sessionId, waiters)
        const timer = setTimeout(finish, remaining)
        signal?.addEventListener('abort', finish, { once: true })
      })
    }
  }

  public sessionForQueuedInput(inputId: string): string | undefined {
    return this.queueOwners.get(inputId)
  }

  public async updateQueuedInput(inputId: string, text: string, signal?: AbortSignal): Promise<void> {
    if (text.trim() === '')
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'Queue edit content must include non-whitespace text.',
        retryable: false,
      })
    const sessionId = this.ownerOf(inputId)
    return this.serializeQueueMutation(inputId, signal, async () => {
      const queued = this.queues.get(sessionId)?.find((item) => item.id === inputId)
      // The wire's only edit is a text-only replacement of the whole content,
      // so a row carrying an image or a file would lose it. Check the latest
      // cached snapshot after prior mutations on this row have settled.
      if (queued?.textOnly === false)
        throw new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'Editing a queued DSH prompt that carries attachments would drop them.',
          retryable: false,
        })
      const receipt = await callRpc<unknown>(
        this.transport,
        'session.updateQueue',
        {
          sessionId,
          itemId: inputId,
          action: { kind: 'edit', content: [{ type: 'text', text }] },
        },
        signal,
      )
      assertAccepted(receipt, 'queue update')
    })
  }

  public async removeQueuedInput(inputId: string, signal?: AbortSignal): Promise<void> {
    const sessionId = this.ownerOf(inputId)
    return this.serializeQueueMutation(inputId, signal, async () => {
      const receipt = await callRpc<unknown>(
        this.transport,
        'session.updateQueue',
        { sessionId, itemId: inputId, action: { kind: 'remove' } },
        signal,
      )
      assertAccepted(receipt, 'queue removal')
      this.queueOwners.delete(inputId)
    })
  }

  public async convertQueuedInputToSteer(inputId: string, signal?: AbortSignal): Promise<void> {
    const sessionId = this.ownerOf(inputId)
    return this.serializeQueueMutation(inputId, signal, async () => {
      try {
        const receipt = await callRpc<unknown>(
          this.transport,
          'session.updateQueue',
          { sessionId, itemId: inputId, action: { kind: 'steer' } },
          signal,
        )
        assertAccepted(receipt, 'queue steering')
      } catch (error) {
        if (!isSettledSteer(error)) throw error
      }
    })
  }

  private serializeQueueMutation(
    inputId: string,
    signal: AbortSignal | undefined,
    mutate: () => Promise<void>,
  ): Promise<void> {
    const preceding = this.queueMutationTails.get(inputId) ?? Promise.resolve()
    const operation = preceding.then(async () => {
      if (signal?.aborted === true) throw cancelledQueueMutation()
      await mutate()
    })
    const tail = operation.then(
      () => undefined,
      () => undefined,
    )
    this.queueMutationTails.set(inputId, tail)
    void tail.then(() => {
      if (this.queueMutationTails.get(inputId) === tail) this.queueMutationTails.delete(inputId)
    })
    return rejectQueueMutationOnAbort(operation, signal)
  }

  private ownerOf(inputId: string): string {
    const sessionId = this.queueOwners.get(inputId)
    if (sessionId === undefined)
      throw new AppError({
        code: 'STALE_INTERACTION',
        message: 'The queued DSH input is no longer available.',
        retryable: true,
      })
    return sessionId
  }

  private clearQueueState(sessionId: string): void {
    this.queues.delete(sessionId)
    this.queueProjectionSequences.delete(sessionId)
    for (const [inputId, owner] of this.queueOwners) if (owner === sessionId) this.queueOwners.delete(inputId)
    const prefix = `${sessionId}\u0000`
    for (const key of this.pendingQueueIdentities.keys())
      if (key.startsWith(prefix)) this.pendingQueueIdentities.delete(key)
  }

  private waitForQueuedIdentity(
    input: PromptInput,
    mode: RunningInputMode,
    beforeIds: ReadonlySet<string>,
    rpcId: string | undefined,
    timeoutMs: number,
  ): Promise<QueuedInput | undefined> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: QueuedInput | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const waiters = this.queueWaiters.get(input.sessionId)
        if (waiters !== undefined) {
          waiters.delete(onQueue)
          if (waiters.size === 0) this.queueWaiters.delete(input.sessionId)
        }
        resolve(value)
      }
      const onQueue = (items: readonly QueuedInput[]): void => {
        const candidate = findNewQueuedInput(items, beforeIds, input, mode, rpcId)
        if (candidate !== undefined) finish(candidate)
      }
      const waiters =
        this.queueWaiters.get(input.sessionId) ?? new Set<(items: readonly QueuedInput[]) => void>()
      waiters.add(onQueue)
      this.queueWaiters.set(input.sessionId, waiters)
      const timer = setTimeout(() => finish(undefined), timeoutMs)
    })
  }

  private awaitQueueIdentity(
    promise: Promise<QueuedInput | undefined>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<QueuedInput | undefined> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value: QueuedInput | undefined, error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const onAbort = (): void =>
        finish(
          undefined,
          new AppError({
            code: 'REQUEST_CANCELLED',
            message: 'The DSH request was cancelled.',
            retryable: false,
          }),
        )
      const timer = setTimeout(() => finish(undefined), timeoutMs)
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => finish(value),
        (error: unknown) =>
          finish(undefined, error instanceof Error ? error : new Error('Queue identity failed.')),
      )
    })
  }
}
