import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

import { AppError, type BackendEndpoint } from '@dsh-vscode/domain'

import type { RetryPolicy } from '../../contracts.js'
import { cancelled, normalizeTransportError } from '../../transport-errors.js'
import { closedConnectionError as closedError } from '../../transport-internal.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'
import type { SubagentAddressRegistry } from '../../repositories/shared/subagent-addresses.js'

/** The small subset of the `ws`/browser WebSocket surface used by the adapter. */
export interface AlphaWebSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: unknown) => void, options?: AddEventListenerOptions): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

export interface AlphaWebSocketConstructor {
  new (url: string, options?: { readonly headers?: Readonly<Record<string, string>> }): AlphaWebSocket
}

/** Normalize one upstream alpha Remote code into the local compatibility vocabulary. */
export type AlphaErrorCodeNormalizer = (code: string, details: Readonly<Record<string, unknown>>) => string

export type AlphaSessionWireVersion = 'v0' | 'v2' | 'v3' | 'v4'
export type AlphaSessionControlWireVersion = 'queue-v1' | 'inbox-v1' | 'projection-v2'
export type AlphaWorkspaceWireVersion = 'archive-v1' | 'pinned-v2'
export type AlphaPresetWireVersion = 'legacy-v1' | 'registry-v2'

export interface AlphaLoopbackApiClientOptions {
  readonly cordisClientBoundary?: boolean
  readonly fileUploads?: boolean
  readonly endpoint: BackendEndpoint
  readonly requestTimeoutMs: number
  readonly retryPolicy: RetryPolicy
  readonly fetch: typeof globalThis.fetch
  /** The Extension Host owns the browser-auth cookie; the Webview never sees it. */
  readonly authCookie?: (endpoint: BackendEndpoint) => string | undefined
  readonly webSocket?: AlphaWebSocketConstructor
  /** Optional version-specific Remote error compatibility profile. */
  readonly normalizeErrorCode?: AlphaErrorCodeNormalizer
  /** Exact Alpha.2+ contract for structured Auto Review denial errors. */
  readonly autoReviewDenialContract?: boolean
  /** Session Controller wire profile; old alpha uses v0, alpha13 uses v2, and alpha151+ uses v3. */
  readonly sessionWireVersion?: AlphaSessionWireVersion
  /** The exact Host profile requires its registered durable model-selection projection. */
  readonly requireModelSelectionProjection?: boolean
  /** Version-specific queue projection for Session/follow opening snapshots. */
  readonly normalizeSessionQueueProjection?: (sessionId: string, projection: unknown) => unknown
  /** Session Controller control profile; alpha.2 replaces queue snapshots with Inbox projections. */
  readonly controlWireVersion?: AlphaSessionControlWireVersion
  /** Workspace follow profile; alpha171 adds a registry-global pinned-session set. */
  readonly workspaceWireVersion?: AlphaWorkspaceWireVersion
  /** Preset roster profile; alpha171's registry has no user-root authoring fields. */
  readonly presetWireVersion?: AlphaPresetWireVersion
  /** Alpha.2, rc.1, and rc.2 add the Session Controller turnWindow request field. */
  readonly sessionHistoryTurnWindow?: boolean
  /**
   * Child-session routing committed by the subagent catalog. The Session
   * Controller refuses a session-kind address for a subagent-origin Session,
   * so every session-addressed read has to reuse the descriptor the catalog
   * published for that child.
   */
  readonly subagentAddresses?: SubagentAddressRegistry
}

interface AlphaMuxStream {
  readonly endpoint: string
  readonly queue: AsyncQueue<unknown>
  socket?: AlphaWebSocket
  terminal: boolean
}

/**
 * Keep one physical alpha Gateway connection per backend and multiplex the
 * independently cancellable logical streams required by `remote.mux`.
 */
export class AlphaRemoteMux {
  private socket: AlphaWebSocket | undefined
  private connectingSocket: AlphaWebSocket | undefined
  private socketCleanup: (() => void) | undefined
  private connecting: Promise<AlphaWebSocket> | undefined
  private readonly streams = new Map<string, AlphaMuxStream>()
  private closed = false

  public constructor(private readonly options: AlphaLoopbackApiClientOptions) {}

  public async *open(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown> {
    if (this.closed) throw closedError()
    if (signal?.aborted === true) return

    const state: AlphaMuxStream = {
      endpoint,
      queue: new AsyncQueue<unknown>(RECEIVE_QUEUE_LIMIT),
      terminal: false,
    }
    const streamId = randomUUID()
    this.streams.set(streamId, state)
    const handleAbort = (): void => {
      if (state.terminal) return
      state.terminal = true
      this.sendCancel(streamId, state)
      state.queue.end()
    }
    signal?.addEventListener('abort', handleAbort, { once: true })

    let firstFrameTimer: ReturnType<typeof setTimeout> | undefined
    try {
      let socket: AlphaWebSocket
      try {
        socket = await this.ensureSocket(signal)
      } catch (error) {
        if (error instanceof AppError && error.code === 'REQUEST_CANCELLED') return
        throw error
      }
      if (state.terminal || this.closed) return
      state.socket = socket
      this.send(socket, {
        type: 'open',
        streamId,
        endpoint,
        payload: { args },
      })
      if (
        ['job/list', 'job/follow', 'session/follow', 'session/control', 'workspace/follow'].includes(endpoint)
      ) {
        firstFrameTimer = setTimeout(() => {
          if (state.terminal) return
          state.terminal = true
          this.sendCancel(streamId, state)
          state.queue.fail(
            new AppError({
              code: 'BACKEND_UNREACHABLE',
              message: 'DSH did not send the stream baseline before the deadline.',
              retryable: true,
              context: { method: endpoint, timedOut: true },
            }),
          )
        }, this.options.requestTimeoutMs)
      }
      for await (const item of state.queue) {
        clearTimeout(firstFrameTimer)
        firstFrameTimer = undefined
        yield item
      }
    } finally {
      clearTimeout(firstFrameTimer)
      signal?.removeEventListener('abort', handleAbort)
      if (!state.terminal) {
        state.terminal = true
        this.sendCancel(streamId, state)
        state.queue.end()
      }
      this.streams.delete(streamId)
    }
  }

  public close(): Promise<void> {
    this.closed = true
    for (const state of this.streams.values()) {
      state.terminal = true
      state.queue.end()
    }
    this.streams.clear()

    const socket = this.socket ?? this.connectingSocket
    this.socket = undefined
    this.connectingSocket = undefined
    this.socketCleanup?.()
    this.socketCleanup = undefined
    if (socket !== undefined && (socket.readyState === 0 || socket.readyState === 1)) {
      try {
        socket.close()
      } catch {
        /* disposal is best effort */
      }
    }
    return Promise.resolve()
  }

  private async ensureSocket(signal?: AbortSignal): Promise<AlphaWebSocket> {
    if (this.closed) throw closedError()
    if (this.socket?.readyState === 1) return this.socket
    const pending =
      this.connecting ??
      (() => {
        const connection = this.connect()
        this.connecting = connection
        void connection.then(
          () => {
            if (this.connecting === connection) this.connecting = undefined
          },
          () => {
            if (this.connecting === connection) this.connecting = undefined
          },
        )
        return connection
      })()
    return this.waitFor(pending, signal)
  }

  private async connect(): Promise<AlphaWebSocket> {
    const WebSocketConstructor = this.options.webSocket ?? WebSocket
    if (typeof WebSocketConstructor !== 'function')
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The Extension Host does not provide WebSocket transport.',
        retryable: true,
      })

    const target = new URL('/api/remote.mux', this.options.endpoint.baseUrl)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const cookie = this.options.authCookie?.(this.options.endpoint)
    const socket =
      cookie === undefined || cookie.trim() === ''
        ? new WebSocketConstructor(target.toString())
        : new WebSocketConstructor(target.toString(), { headers: { Cookie: cookie } })
    this.connectingSocket = socket

    return new Promise<AlphaWebSocket>((resolve, reject) => {
      let settled = false
      let opened = false
      const timerState: { timer?: ReturnType<typeof setTimeout> } = {}
      let removed = false
      const removeListeners = (): void => {
        if (removed) return
        removed = true
        if (timerState.timer !== undefined) clearTimeout(timerState.timer)
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('message', handleMessage)
        socket.removeEventListener('error', handleError)
        socket.removeEventListener('close', handleClose)
        if (this.socketCleanup === removeListeners) this.socketCleanup = undefined
      }
      const failBeforeOpen = (error: unknown): void => {
        if (settled) return
        settled = true
        if (this.connectingSocket === socket) this.connectingSocket = undefined
        removeListeners()
        try {
          if (socket.readyState === 0 || socket.readyState === 1) socket.close()
        } catch {
          /* close is best effort after a failed handshake */
        }
        reject(
          error instanceof Error ? error : new Error('The alpha DSH handshake failed.', { cause: error }),
        )
      }
      const handleOpen = (): void => {
        if (settled) return
        if (this.closed) {
          failBeforeOpen(closedError())
          return
        }
        settled = true
        opened = true
        if (this.connectingSocket === socket) this.connectingSocket = undefined
        if (timerState.timer !== undefined) clearTimeout(timerState.timer)
        this.socket = socket
        this.socketCleanup = removeListeners
        resolve(socket)
      }
      const handleMessage = (event: unknown): void => {
        if (!opened) {
          failBeforeOpen(malformedResponse('remote.mux'))
          return
        }
        this.dispatch(socket, event, removeListeners)
      }
      const handleError = (event: unknown): void => {
        const error = normalizeTransportError('remote.mux', socketError(event))
        if (!opened) failBeforeOpen(error)
        else this.failSocket(socket, error, removeListeners)
      }
      const handleClose = (): void => {
        const error = new AppError({
          code: 'BACKEND_UNREACHABLE',
          message: opened
            ? 'The alpha DSH multiplexed stream closed unexpectedly.'
            : 'The alpha DSH multiplexed stream closed before it became ready.',
          retryable: true,
        })
        if (!opened) failBeforeOpen(error)
        else this.failSocket(socket, error, removeListeners)
      }

      socket.addEventListener('open', handleOpen)
      socket.addEventListener('message', handleMessage)
      socket.addEventListener('error', handleError)
      socket.addEventListener('close', handleClose)
      timerState.timer = setTimeout(
        () =>
          failBeforeOpen(
            new AppError({
              code: 'BACKEND_UNREACHABLE',
              message: 'The alpha DSH multiplexed stream timed out before it became ready.',
              retryable: true,
              context: { method: 'remote.mux', timedOut: true },
            }),
          ),
        this.options.requestTimeoutMs,
      )
      if (socket.readyState === 1) queueMicrotask(handleOpen)
      else if (socket.readyState === 3) queueMicrotask(handleClose)
    })
  }

  private dispatch(socket: AlphaWebSocket, event: unknown, cleanup: () => void): void {
    let frame: Record<string, unknown>
    try {
      const text = textOfSocketData(event)
      if (text.length > 8 * 1024 * 1024) throw new Error('frame too large')
      const decoded: unknown = JSON.parse(text)
      if (!isPlainRecord(decoded)) throw new Error('frame is not an object')
      frame = decoded
    } catch (cause) {
      this.failSocket(socket, malformedResponse('remote.mux', cause), cleanup)
      return
    }

    const streamId = frame.streamId
    if (typeof streamId !== 'string' || streamId.trim() === '') {
      this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
      return
    }
    const state = this.streams.get(streamId)
    switch (frame.type) {
      case 'item':
        if (
          !hasExactKeys(frame, ['type', 'streamId']) &&
          !hasExactKeys(frame, ['type', 'streamId', 'value'])
        ) {
          this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
          return
        }
        if (state !== undefined && !state.terminal) state.queue.push(frame.value)
        return
      case 'end':
        if (!hasExactKeys(frame, ['type', 'streamId'])) {
          this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
          return
        }
        if (state !== undefined && !state.terminal) {
          state.terminal = true
          state.queue.end()
        }
        return
      case 'error':
        if (!hasExactKeys(frame, ['type', 'streamId', 'error']) || !validAlphaStreamError(frame.error)) {
          this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
          return
        }
        if (state !== undefined && !state.terminal) {
          state.terminal = true
          state.queue.fail(alphaStreamError(frame.error, this.options.normalizeErrorCode))
        }
        return
      default:
        this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
    }
  }

  private failAll(error: unknown): void {
    for (const state of this.streams.values()) {
      state.terminal = true
      state.queue.fail(error)
    }
  }

  private failSocket(socket: AlphaWebSocket, error: unknown, cleanup: () => void): void {
    cleanup()
    if (this.socket === socket) this.socket = undefined
    if (!this.closed) this.failAll(error)
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close()
    } catch {
      /* close is best effort after a transport failure */
    }
  }

  private send(socket: AlphaWebSocket, message: Record<string, unknown>): void {
    if (socket.readyState !== 1)
      throw normalizeTransportError('remote.mux', new Error('The alpha DSH stream is not open.'))
    try {
      socket.send(JSON.stringify(message))
    } catch (cause) {
      throw normalizeTransportError('remote.mux', cause)
    }
  }

  private sendCancel(streamId: string, state: AlphaMuxStream): void {
    const socket = state.socket
    if (socket === undefined || socket.readyState !== 1) return
    try {
      socket.send(JSON.stringify({ type: 'cancel', streamId }))
    } catch {
      /* cancellation is best effort; the physical socket remains shared */
    }
  }

  private async waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return promise
    if (signal.aborted) throw cancelled(signal.reason)
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const handleAbort = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', handleAbort)
        reject(cancelled(signal.reason))
      }
      signal.addEventListener('abort', handleAbort, { once: true })
      void promise.then(
        (value) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', handleAbort)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', handleAbort)
          reject(error instanceof Error ? error : new Error('The alpha DSH stream failed.', { cause: error }))
        },
      )
    })
  }
}

/** Matches the rc.6 transport's per-stream receive queue bound. */
const RECEIVE_QUEUE_LIMIT = 256

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private finished = false
  private failure: unknown

  public constructor(private readonly capacity: number) {}

  public push(value: T): void {
    if (this.finished) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) {
      // The stream consumer can await inside its read loop (history recovery
      // on a seq gap), so the host can keep pushing frames while the
      // generator is suspended at its yield. Bound the buffer like the rc.6
      // transport does, but keep the stream alive past the bound: dropping
      // the buffered frames turns into an ordinary sequence hole that the
      // stream controller's gap detection and history recovery heal, while
      // failing the stream here tore down the mux generation mid-answer and
      // cascaded into reconnect storms that lost whole turns.
      if (this.values.length >= this.capacity) this.values.length = 0
      this.values.push(value)
      return
    }
    waiter.resolve({ value, done: false })
  }

  public end(): void {
    if (this.finished) return
    this.finished = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as T, done: true })
  }

  public fail(error: unknown): void {
    if (this.finished) return
    this.failure = error
    this.finished = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) return Promise.resolve({ value: this.values.shift() as T, done: false })
        if (this.finished) {
          if (this.failure === undefined) return Promise.resolve({ value: undefined as T, done: true })
          return Promise.reject(
            this.failure instanceof Error ? this.failure : new Error('The alpha DSH stream failed.'),
          )
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
    }
  }
}

export function malformedResponse(method: string, cause?: unknown): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed alpha response for ${method}.`,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

export function isSafeAlphaCursor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= -1
}

export function isSafeAlphaSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function isJsonLike(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (
        Reflect.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        return false
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonLike(value[index], seen)) return false
      }
      return true
    }
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !isJsonLike(Reflect.get(value, key), seen)) return false
    }
    return true
  } finally {
    seen.delete(value)
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validAlphaStreamError(value: unknown): value is Record<string, unknown> {
  const error = recordOrUndefined(value)
  return (
    error !== undefined &&
    hasExactKeys(error, ['code', 'message', 'details']) &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    isPlainRecord(error.details)
  )
}

function alphaStreamError(value: unknown, normalizeErrorCode?: AlphaErrorCodeNormalizer): AppError {
  const error = recordOrUndefined(value) ?? {}
  if (typeof error.code === 'string' && typeof error.message === 'string' && isPlainRecord(error.details)) {
    const code = normalizeErrorCode?.(error.code, error.details) ?? error.code
    try {
      unwrapRpcResultValue(
        { ok: false, error: { code, message: error.message, details: error.details } },
        'alpha stream',
      )
    } catch (cause) {
      if (cause instanceof AppError) return cause
    }
  }
  return new AppError({
    code: 'BACKEND_UNREACHABLE',
    message: 'The alpha DSH stream failed.',
    retryable: true,
    context: {
      rpcCode:
        typeof error.code === 'string'
          ? (normalizeErrorCode?.(error.code, isPlainRecord(error.details) ? error.details : {}) ??
            error.code)
          : 'internal',
    },
  })
}

function textOfSocketData(event: unknown): string {
  const data = asRecord(event)?.data ?? event
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  throw new Error('alpha DSH stream message is not text')
}

function socketError(event: unknown): Error {
  const error = asRecord(event)?.error
  return error instanceof Error ? error : new Error('The alpha DSH WebSocket failed.')
}
