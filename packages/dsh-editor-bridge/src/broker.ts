import { randomUUID } from 'node:crypto'
import {
  EditorBridgeError,
  EDITOR_BRIDGE_PROTOCOL,
  type EditorBridgeBinding,
  type EditorBridgePoll,
  type EditorBridgeReply,
  type EditorBridgeResult,
  type EditorStateSnapshot,
  type EditorBridgeFailure,
} from '@dsh-vscode/domain'

interface Pending {
  readonly requestId: string
  readonly finish: (reply: EditorBridgeReply) => void
  delivered: boolean
}
interface Binding {
  readonly id: string
  readonly sessionId: string
  readonly ownerId: string
  readonly peerId: string
  lease: ReturnType<typeof setTimeout>
  pending?: Pending
  polling?: (poll: EditorBridgePoll) => void
}
const ok = <T>(value: T): EditorBridgeResult<T> => ({ status: 'ok', value })
const fail = (reason: EditorBridgeFailure): EditorBridgeResult<never> => ({ status: 'error', reason })

/** One explicit owner/session lease. No persisted grants, snapshots, or unbounded queues. */
export class EditorBridgeBroker {
  private binding: Binding | undefined
  public hasSession(sessionId: string): boolean {
    return this.binding?.sessionId === sessionId
  }
  public constructor(private readonly limits = { leaseMs: 10_000, pollMs: 1_000, callMs: 5_000 }) {}

  public attach(sessionId: string, ownerId: string, peerId: string): EditorBridgeResult<EditorBridgeBinding> {
    const current = this.binding
    if (
      current !== undefined &&
      (current.sessionId !== sessionId || current.ownerId !== ownerId || current.peerId !== peerId)
    )
      return fail('busy')
    const binding = current ?? {
      id: randomUUID(),
      sessionId,
      ownerId,
      peerId,
      lease: setTimeout(() => this.dispose(), this.limits.leaseMs),
    }
    this.binding = binding
    this.renew(binding)
    return ok({ bindingId: binding.id, protocolVersion: EDITOR_BRIDGE_PROTOCOL })
  }

  public async poll(
    bindingId: string,
    peerId: string,
    signal: AbortSignal,
  ): Promise<EditorBridgeResult<EditorBridgePoll>> {
    const binding = this.owned(bindingId, peerId)
    if (binding === undefined) return fail('not-bound')
    if (signal.aborted) return fail('cancelled')
    if (binding.polling !== undefined) return fail('busy')
    this.renew(binding)
    const pending = binding.pending
    if (pending !== undefined && !pending.delivered) {
      pending.delivered = true
      return ok({ kind: 'request', requestId: pending.requestId })
    }
    const result = await new Promise<EditorBridgePoll>((resolve) => {
      const finish = (value: EditorBridgePoll): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        delete binding.polling
        resolve(value)
      }
      const abort = (): void => finish({ kind: 'idle' })
      const timer = setTimeout(abort, this.limits.pollMs)
      binding.polling = finish
      signal.addEventListener('abort', abort, { once: true })
    })
    if (signal.aborted) return fail('cancelled')
    return this.binding === binding ? ok(result) : fail('not-bound')
  }

  public respond(
    bindingId: string,
    peerId: string,
    requestId: string,
    reply: EditorBridgeReply,
  ): EditorBridgeResult<true> {
    const binding = this.owned(bindingId, peerId)
    if (binding === undefined) return fail('not-bound')
    const pending = binding.pending
    if (pending === undefined || pending.requestId !== requestId || !pending.delivered)
      return fail('stale-request')
    pending.finish(reply)
    return ok(true)
  }

  public detach(bindingId: string, peerId: string): EditorBridgeResult<true> {
    if (this.binding === undefined) return ok(true)
    if (this.owned(bindingId, peerId) === undefined) return fail('not-bound')
    this.dispose()
    return ok(true)
  }

  public read(sessionId: string | undefined, signal: AbortSignal): Promise<EditorStateSnapshot> {
    if (signal.aborted) return Promise.reject(new EditorBridgeError('cancelled'))
    const binding = this.binding
    if (binding === undefined || binding.sessionId !== sessionId)
      return Promise.reject(new EditorBridgeError('not-bound'))
    if (binding.pending !== undefined) return Promise.reject(new EditorBridgeError('busy'))
    return new Promise((resolve, reject) => {
      const finish = (reply: EditorBridgeReply): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        delete binding.pending
        if (reply.ok) resolve(reply.snapshot)
        else reject(new EditorBridgeError(reply.reason))
      }
      const abort = (): void => finish({ ok: false, reason: 'cancelled' })
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), this.limits.callMs)
      const requestId = randomUUID()
      binding.pending = { requestId, finish, delivered: false }
      signal.addEventListener('abort', abort, { once: true })
      if (binding.polling !== undefined) {
        binding.pending.delivered = true
        binding.polling({ kind: 'request', requestId })
      }
    })
  }

  public dispose(): void {
    const binding = this.binding
    this.binding = undefined
    if (binding === undefined) return
    clearTimeout(binding.lease)
    binding.pending?.finish({ ok: false, reason: 'not-bound' })
    binding.polling?.({ kind: 'idle' })
  }

  private owned(bindingId: string, peerId: string): Binding | undefined {
    const binding = this.binding
    return binding?.id === bindingId && binding.peerId === peerId ? binding : undefined
  }
  private renew(binding: Binding): void {
    clearTimeout(binding.lease)
    binding.lease = setTimeout(() => this.dispose(), this.limits.leaseMs)
    binding.lease.unref()
  }
}
