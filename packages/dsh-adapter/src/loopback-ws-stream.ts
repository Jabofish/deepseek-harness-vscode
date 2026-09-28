import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { RpcMessage } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { AppError } from '@dsh-vscode/domain'

import { record } from './loopback-rpc-envelope.js'
import { cancelled } from './transport-errors.js'

export type LoopbackFrameChannel = 'mux' | 'host'

/**
 * Version adapters can replace only the payload parser while retaining the
 * common WebSocket carrier. The parser must validate a complete frame and
 * return the value that the stream controller will receive.
 */
export interface LoopbackFrameParser {
  parse(value: unknown, channel: LoopbackFrameChannel): unknown
}

type WebSocketItem =
  | { readonly kind: 'frame'; readonly value: unknown }
  | { readonly kind: 'end' }
  | { readonly kind: 'error'; readonly error: Error }

class WebSocketQueue {
  private readonly values: (WebSocketItem | undefined)[] = []
  private head = 0

  public constructor(private readonly capacity: number) {}

  public get length(): number {
    return this.values.length - this.head
  }

  public push(value: WebSocketItem): boolean {
    if (this.length >= this.capacity) return false
    this.values.push(value)
    return true
  }

  public shift(): WebSocketItem {
    const value = this.values[this.head]
    this.values[this.head] = undefined
    this.head += 1
    if (this.head > 32 && this.head * 2 > this.values.length) {
      this.values.splice(0, this.head)
      this.head = 0
    }
    return value as WebSocketItem
  }

  public clear(): void {
    this.values.length = 0
    this.head = 0
  }
}

export const MUX_FRAME_TYPES = frameTypes(muxFrameSchema)
export const HOST_FRAME_TYPES = frameTypes(hostFrameSchema)

/**
 * The pinned package exports these schemas through a broad ZodType cast, but
 * the concrete Zod discriminated union retains its public `options` array at
 * runtime. Derive the allowlist from that source rather than copying tags.
 */
function frameTypes(schema: { parse(value: unknown): unknown }): ReadonlySet<string> {
  const options = (schema as unknown as { readonly options?: unknown }).options
  if (!Array.isArray(options)) throw new Error('Pinned DSH frame schema has no discriminated options.')
  return new Set(
    options.flatMap((entry) => {
      const option = record(entry)
      const shape = record(option?.shape)
      const type = record(shape?.type)
      const value = type?.value
      return typeof value === 'string' ? [value] : []
    }),
  )
}

/**
 * Keep the pinned schema strict for known frames, but leave a future frame
 * type available to the adapter's safe `unknown` projection. A malformed
 * known frame still fails closed and triggers the normal stream recovery.
 */
function parseFramePayload(
  schema: { parse(value: unknown): unknown },
  value: unknown,
  knownFrameTypes: ReadonlySet<string>,
): unknown {
  try {
    return schema.parse(value)
  } catch (error) {
    const frame = record(value)
    if (frame !== undefined && typeof frame.type === 'string' && !knownFrameTypes.has(frame.type))
      return value
    throw error
  }
}

/**
 * DSH exposes event paths as read-only WebSocket downlinks. A normal fetch
 * is intentionally rejected by DSH with HTTP 426, so keep the upgrade and
 * frame decoding here instead of leaking a transport detail upward.
 */
export async function* readLoopbackWebSocket(options: {
  path: string
  signal: AbortSignal
  frameSchema: { parse(value: unknown): unknown }
  knownFrameTypes: ReadonlySet<string>
  channel: LoopbackFrameChannel
  baseUrl: string
  webSocket?: typeof globalThis.WebSocket | undefined
  frameParser?: LoopbackFrameParser | undefined
  onEnvelope: (message: RpcMessage) => void
}): AsyncGenerator<unknown> {
  const { signal } = options
  if (signal.aborted) return
  const WebSocketConstructor = options.webSocket ?? globalThis.WebSocket
  if (typeof WebSocketConstructor !== 'function')
    throw new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'The Extension Host does not provide WebSocket transport.',
      retryable: true,
    })

  const target = new URL(options.path, options.baseUrl)
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocketConstructor(target.toString())
  const inbox = new WebSocketQueue(256)
  let wake: (() => void) | undefined
  let resolveOpen: (() => void) | undefined
  let rejectOpen: ((error: unknown) => void) | undefined
  let openSettled = false
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  const enqueue = (item: WebSocketItem): void => {
    if (!inbox.push(item)) {
      inbox.clear()
      inbox.push({
        kind: 'error',
        error: new AppError({
          code: 'PROTOCOL_ERROR',
          message: 'The DSH event stream exceeded its receive queue limit.',
          retryable: true,
        }),
      })
      try {
        socket.close()
      } catch {
        /* close is best effort after overflow */
      }
    }
    wake?.()
    wake = undefined
  }
  const handleOpen = (): void => {
    if (openSettled) return
    openSettled = true
    resolveOpen?.()
  }
  const handleMessage = (event: MessageEvent): void => {
    if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) {
      const error = new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'The DSH event stream returned an invalid frame.',
        retryable: true,
      })
      if (!openSettled) {
        openSettled = true
        rejectOpen?.(error)
      } else enqueue({ kind: 'error', error })
      return
    }
    try {
      const full = serverRequestSchema.parse(JSON.parse(event.data))
      const frame =
        options.frameParser?.parse(full.payload, options.channel) ??
        parseFramePayload(options.frameSchema, full.payload, options.knownFrameTypes)
      options.onEnvelope(full)
      enqueue({ kind: 'frame', value: { rpcId: full.rpcId, payload: frame } })
    } catch {
      const error = new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'The DSH event stream returned a malformed frame.',
        retryable: true,
      })
      if (!openSettled) {
        openSettled = true
        rejectOpen?.(error)
      } else enqueue({ kind: 'error', error })
    }
  }
  const handleError = (): void => {
    const error = new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'The DSH event stream transport failed.',
      retryable: true,
    })
    if (!openSettled) {
      openSettled = true
      rejectOpen?.(error)
    } else if (!signal.aborted) enqueue({ kind: 'error', error })
  }
  const handleClose = (): void => {
    if (!openSettled) {
      openSettled = true
      rejectOpen?.(
        new AppError({
          code: 'BACKEND_UNREACHABLE',
          message: 'The DSH event stream closed before it became ready.',
          retryable: true,
        }),
      )
    } else enqueue({ kind: 'end' })
  }
  const handleAbort = (): void => {
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close()
    } finally {
      enqueue({ kind: 'end' })
    }
  }

  socket.addEventListener('open', handleOpen)
  socket.addEventListener('message', handleMessage)
  socket.addEventListener('error', handleError)
  socket.addEventListener('close', handleClose, { once: true })
  signal.addEventListener('abort', handleAbort, { once: true })
  if (socket.readyState === 1) handleOpen()
  if (signal.aborted) handleAbort()
  try {
    try {
      await withTimeout(opened, 5_000, signal)
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
    while (true) {
      while (inbox.length > 0) {
        const item = inbox.shift()
        if (item.kind === 'end') return
        if (item.kind === 'error') throw item.error
        if (signal.aborted) return
        yield item.value
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    signal.removeEventListener('abort', handleAbort)
    socket.removeEventListener('open', handleOpen)
    socket.removeEventListener('message', handleMessage)
    socket.removeEventListener('error', handleError)
    socket.removeEventListener('close', handleClose)
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close()
    } catch {
      /* disposal is best effort after an aborted or failed handshake */
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new AppError({
            code: 'BACKEND_UNREACHABLE',
            message: 'The DSH event stream did not become ready.',
            retryable: true,
          }),
        ),
      timeoutMs,
    )
    const onAbort = (): void => finish(undefined, cancelled(signal?.reason))
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (value: T | undefined, error?: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve(value as T)
      else
        reject(error instanceof Error ? error : new Error('The DSH transport returned an unspecified error.'))
    }
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(value),
      (error) => finish(undefined, error),
    )
  })
}
