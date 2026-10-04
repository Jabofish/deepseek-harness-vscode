import type { DshTransport } from '../../src/contracts.js'

/** Common exact Session V4 / pinned Workspace probe, including rejection and cleanup. */
export class ProbeFixtureTransport implements DshTransport {
  public readonly methods: string[] = []
  public closeCalls = 0

  public constructor(
    private readonly responseMode:
      'valid' | 'malformed' | 'business-error' | 'protocol-error' | 'timeout' = 'valid',
  ) {}

  public request<TResponse>(method: string, _params: unknown, signal?: AbortSignal): Promise<TResponse> {
    this.methods.push(method)
    if (signal?.aborted) return Promise.reject<TResponse>(new DOMException('Cancelled', 'AbortError'))
    if (this.responseMode === 'timeout')
      return Promise.reject<TResponse>(new DOMException('Timed out', 'TimeoutError'))
    if (this.responseMode === 'protocol-error') return Promise.resolve(undefined as TResponse)
    if (this.responseMode === 'business-error')
      return Promise.resolve({
        rpcId: 'fixture',
        result: { ok: false, error: { code: 'session-not-found', message: 'No session' } },
      } as TResponse)
    const value =
      method === 'session.list'
        ? this.responseMode === 'malformed'
          ? { items: 'not-an-array' }
          : { items: [{ sessionId: 's-1', agentAvailable: true }] }
        : method === 'workspace.list'
          ? { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
          : undefined
    return Promise.resolve({ rpcId: 'fixture', result: { ok: true, value } } as TResponse)
  }

  public remoteRequest<TResponse>(): Promise<TResponse> {
    return Promise.reject<TResponse>(new Error('the exact probe fixture issues no Remote calls'))
  }

  public async *openEventStream(): AsyncIterable<unknown> {
    /* This probe fixture does not subscribe to the runtime event stream. */
  }

  public close(): Promise<void> {
    this.closeCalls += 1
    return Promise.resolve()
  }
}
