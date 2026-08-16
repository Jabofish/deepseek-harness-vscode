import type { BackendEndpoint } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport, RetryPolicy } from './contracts.js'

export interface LoopbackApiClientOptions {
  readonly endpoint: BackendEndpoint
  readonly requestTimeoutMs: number
  readonly retryPolicy: RetryPolicy
  readonly fetch: typeof globalThis.fetch
}

export class LoopbackApiClient implements DshTransport {
  public constructor(private readonly options: LoopbackApiClientOptions) {}

  public request<TResponse>(method: string, params: unknown, signal?: AbortSignal): Promise<TResponse> {
    return unimplemented<Promise<TResponse>>('typed loopback RPC request', [
      'use the official apiproxy rc6 request envelope and endpoint routes',
      'compose caller cancellation with a configured timeout',
      'retry only idempotent transient failures with bounded exponential backoff and jitter',
      'validate every response before mapping into domain types',
      'redact Authorization, API keys, request bodies, and credential fields from diagnostics',
      'never connect to a non-loopback host',
      `method ${method}; endpoint ${this.options.endpoint.baseUrl}; params type ${typeof params}; signal present ${String(signal !== undefined)}`,
    ])
  }

  public openEventStream(signal?: AbortSignal): AsyncIterable<unknown> {
    return unimplemented<AsyncIterable<unknown>>('DSH mux and host event transport', [
      'open the rc6 event stream using the upstream client connection contract',
      'parse frames incrementally and apply backpressure',
      'resume or reconnect with bounded backoff after transient disconnects',
      'surface a terminal connection.lost event after recovery is exhausted',
      'dispose sockets, timers, and readers on cancellation',
      `endpoint ${this.options.endpoint.baseUrl}; signal present ${String(signal !== undefined)}`,
    ])
  }

  public close(): Promise<void> {
    return unimplemented<Promise<void>>('loopback API client disposal', [
      'abort all active requests and streams',
      'wait for readers and timers to settle',
      'be idempotent',
    ])
  }
}
