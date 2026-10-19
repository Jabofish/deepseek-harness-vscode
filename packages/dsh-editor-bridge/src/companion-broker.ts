import { randomUUID } from 'node:crypto'
import {
  EDITOR_COMPANION_LIMITS,
  EditorCompanionError,
  editorCapability,
  editorValueMatches,
  type EditorCompanionBinding,
  type EditorCompanionCapability,
  type EditorCompanionFailure,
  type EditorCompanionPoll,
  type EditorCompanionReply,
  type EditorCompanionRequest,
  type EditorCompanionResult,
  type EditorCompanionValue,
} from '@dsh-vscode/domain'

interface Pending {
  readonly request: EditorCompanionRequest
  readonly finish: (reply: EditorCompanionReply) => void
  delivered: boolean
}
interface Grant {
  readonly id: string
  readonly sessionId: string
  readonly ownerId: string
  readonly peerId: string
  readonly capabilities: readonly EditorCompanionCapability[]
  readonly pending: Map<string, Pending>
  readonly queue: EditorCompanionPoll[]
  lease: ReturnType<typeof setTimeout>
  polling?: (event: EditorCompanionPoll) => void
}
const ok = <T>(value: T): EditorCompanionResult<T> => ({ status: 'ok', value })
const fail = (reason: EditorCompanionFailure): EditorCompanionResult<never> => ({ status: 'error', reason })

/** Bounded session/Peer grants. A tool's cancellation is independent of its grant. */
export class EditorCompanionBroker {
  private readonly grants = new Map<string, Grant>()
  private readonly waiting = new Map<string, Set<(available: boolean) => void>>()
  public constructor(private readonly limits = { leaseMs: 45_000, pollMs: 1_000, callMs: 10_000 }) {}
  public hasSession(sessionId: string): boolean {
    return this.session(sessionId) !== undefined
  }
  public attach(
    sessionId: string,
    ownerId: string,
    peerId: string,
    capabilities: readonly EditorCompanionCapability[],
  ): EditorCompanionResult<EditorCompanionBinding> {
    const existing = this.session(sessionId)
    if (existing !== undefined) {
      if (
        existing.ownerId !== ownerId ||
        existing.peerId !== peerId ||
        existing.capabilities.length !== capabilities.length ||
        !existing.capabilities.every((capability) => capabilities.includes(capability))
      )
        return fail('busy')
      this.renew(existing)
      return ok({ bindingId: existing.id, protocolVersion: 2 })
    }
    if (this.grants.size >= EDITOR_COMPANION_LIMITS.grants) return fail('busy')
    const id = randomUUID()
    const grant: Grant = {
      id,
      sessionId,
      ownerId,
      peerId,
      capabilities: [...capabilities],
      pending: new Map(),
      queue: [],
      lease: setTimeout(() => this.release(id), this.limits.leaseMs),
    }
    grant.lease.unref()
    this.grants.set(id, grant)
    for (const ready of this.waiting.get(sessionId) ?? []) ready(true)
    return ok({ bindingId: id, protocolVersion: 2 })
  }
  public async poll(
    bindingId: string,
    peerId: string,
    signal: AbortSignal,
  ): Promise<EditorCompanionResult<EditorCompanionPoll>> {
    const grant = this.owned(bindingId, peerId)
    if (grant === undefined) return fail('not-bound')
    if (signal.aborted) return fail('cancelled')
    if (grant.polling !== undefined) return fail('busy')
    this.renew(grant)
    const next = grant.queue.shift()
    if (next !== undefined) return ok(this.delivered(grant, next))
    const event = await new Promise<EditorCompanionPoll>((resolve) => {
      const finish = (value: EditorCompanionPoll): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        delete grant.polling
        resolve(value)
      }
      const abort = (): void => finish({ kind: 'idle' })
      const timer = setTimeout(abort, this.limits.pollMs)
      grant.polling = finish
      signal.addEventListener('abort', abort, { once: true })
    })
    if (signal.aborted) return fail('cancelled')
    return this.grants.get(bindingId) === grant ? ok(event) : fail('not-bound')
  }
  public respond(
    bindingId: string,
    peerId: string,
    requestId: string,
    reply: EditorCompanionReply,
  ): EditorCompanionResult<true> {
    const grant = this.owned(bindingId, peerId)
    if (grant === undefined) return fail('not-bound')
    const pending = grant.pending.get(requestId)
    if (pending === undefined || !pending.delivered) return fail('stale-request')
    if (reply.ok && !editorValueMatches(pending.request, reply.value)) {
      pending.finish({ ok: false, reason: 'invalid-response' })
      return fail('invalid-response')
    }
    pending.finish(reply)
    return ok(true)
  }
  public detach(bindingId: string, peerId: string): EditorCompanionResult<true> {
    if (this.owned(bindingId, peerId) === undefined) return fail('not-bound')
    this.release(bindingId)
    return ok(true)
  }
  public async read(
    sessionId: string | undefined,
    request: EditorCompanionRequest,
    signal: AbortSignal,
  ): Promise<EditorCompanionValue> {
    if (signal.aborted) return Promise.reject(new EditorCompanionError('cancelled'))
    if (sessionId !== undefined && !this.hasSession(sessionId)) await this.waitForSession(sessionId, signal)
    if (signal.aborted) throw new EditorCompanionError('cancelled')
    const grant = sessionId === undefined ? undefined : this.session(sessionId)
    if (grant === undefined) return Promise.reject(new EditorCompanionError('not-bound'))
    const capability = editorCapability(request)
    if (capability !== undefined && !grant.capabilities.includes(capability))
      return Promise.reject(new EditorCompanionError('denied'))
    if (grant.pending.size >= EDITOR_COMPANION_LIMITS.requests || grant.queue.length >= 32)
      return Promise.reject(new EditorCompanionError('busy'))
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const finish = (reply: EditorCompanionReply): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        grant.pending.delete(requestId)
        if (reply.ok) resolve(reply.value)
        else reject(new EditorCompanionError(reply.reason))
      }
      const cancel = (reason: 'cancelled' | 'timeout'): void => {
        const delivered = grant.pending.get(requestId)?.delivered
        finish({ ok: false, reason })
        const queued = grant.queue.findIndex(
          (event) => event.kind === 'request' && event.requestId === requestId,
        )
        if (queued >= 0) grant.queue.splice(queued, 1)
        if (delivered) this.enqueue(grant, { kind: 'cancel', requestId })
      }
      const abort = (): void => cancel('cancelled')
      const timer = setTimeout(() => cancel('timeout'), this.limits.callMs)
      grant.pending.set(requestId, { request, finish, delivered: false })
      signal.addEventListener('abort', abort, { once: true })
      this.enqueue(grant, { kind: 'request', requestId, request })
    })
  }
  public dispose(): void {
    for (const group of this.waiting.values()) for (const ready of [...group]) ready(false)
    for (const id of this.grants.keys()) this.release(id)
  }
  public waitForSession(sessionId: string, signal: AbortSignal): Promise<boolean> {
    if (this.hasSession(sessionId)) return Promise.resolve(true)
    if (signal.aborted) return Promise.resolve(false)
    const group = this.waiting.get(sessionId) ?? new Set<(available: boolean) => void>()
    if (group.size >= 4 || (this.waiting.size >= 16 && !this.waiting.has(sessionId)))
      return Promise.resolve(false)
    this.waiting.set(sessionId, group)
    return new Promise((resolve) => {
      const finish = (available: boolean): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        group.delete(finish)
        if (group.size === 0) this.waiting.delete(sessionId)
        resolve(available)
      }
      const abort = (): void => finish(false)
      const timer = setTimeout(abort, 2_500)
      group.add(finish)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  private enqueue(grant: Grant, event: EditorCompanionPoll): void {
    if (grant.polling !== undefined) grant.polling(this.delivered(grant, event))
    else if (grant.queue.length < 32) grant.queue.push(event)
  }
  private delivered(grant: Grant, event: EditorCompanionPoll): EditorCompanionPoll {
    if (event.kind === 'request') {
      const pending = grant.pending.get(event.requestId)
      if (pending === undefined) return { kind: 'idle' }
      pending.delivered = true
    }
    return event
  }
  private session(sessionId: string): Grant | undefined {
    return [...this.grants.values()].find((grant) => grant.sessionId === sessionId)
  }
  private owned(id: string, peer: string): Grant | undefined {
    const grant = this.grants.get(id)
    return grant?.peerId === peer ? grant : undefined
  }
  private renew(grant: Grant): void {
    clearTimeout(grant.lease)
    grant.lease = setTimeout(() => this.release(grant.id), this.limits.leaseMs)
    grant.lease.unref()
  }
  private release(id: string): void {
    const grant = this.grants.get(id)
    if (grant === undefined) return
    this.grants.delete(id)
    clearTimeout(grant.lease)
    for (const pending of grant.pending.values()) pending.finish({ ok: false, reason: 'not-bound' })
    grant.queue.length = 0
    grant.polling?.({ kind: 'idle' })
  }
}
