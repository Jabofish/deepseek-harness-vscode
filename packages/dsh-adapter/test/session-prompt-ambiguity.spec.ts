import { createServer } from 'node:http'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { LoopbackApiClient } from '../src/loopback-api-client.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'

const input = { sessionId: 'session-1', text: 'A test task', attachments: [] }

function pendingPrompt(): {
  readonly repository: Rc6SessionRepository
  readonly request: Mock<() => Promise<unknown>>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const response = new Promise<unknown>((done, fail) => {
    resolve = done
    reject = fail
  })
  const request = vi.fn(async () => response)
  const transport: DshTransport = {
    request: request as DshTransport['request'],
    remoteRequest: <T>() => Promise.reject<T>(new Error('Unexpected Remote')),
    openEventStream: async function* () {},
    close: async () => {},
  }
  return { repository: new Rc6SessionRepository(transport), request, resolve, reject }
}

describe('Queued prompt delivery with an unknown outcome', () => {
  it('shares a malformed receipt failure with concurrent callers instead of dispatching again', async () => {
    const { repository, request, resolve } = pendingPrompt()
    const results = Promise.allSettled([
      repository.enqueuePrompt(input, 'queue'),
      repository.enqueuePrompt(input, 'queue'),
    ])
    resolve({ rpcId: 'rpc-1', result: { ok: true, value: {} } })
    const settled = await results
    for (const result of settled) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected')
        expect(result.reason as unknown).toMatchObject({ code: 'PROTOCOL_ERROR' })
    }
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not resend when a concurrent waiter reaches its deadline before the first request ends', async () => {
    vi.useFakeTimers()
    const { repository, request, reject } = pendingPrompt()
    const first = repository.enqueuePrompt(input, 'queue').catch((error: unknown) => error)
    const second = repository.enqueuePrompt(input, 'queue').catch((error: unknown) => error)
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(request).toHaveBeenCalledTimes(1)
      expect(await second).toMatchObject({ code: 'BACKEND_UNREACHABLE' })
    } finally {
      reject(new TypeError('Response lost'))
      await Promise.all([first, second])
      vi.useRealTimers()
    }
  })

  it('lets a waiter cancel without clearing the original request or sending a replacement', async () => {
    const { repository, request, reject } = pendingPrompt()
    const first = repository.enqueuePrompt(input, 'queue').catch((error: unknown) => error)
    const controller = new AbortController()
    const cancelled = repository
      .enqueuePrompt(input, 'queue', controller.signal)
      .catch((error: unknown) => error)
    controller.abort()
    expect(await cancelled).toMatchObject({ code: 'REQUEST_CANCELLED' })
    const third = repository.enqueuePrompt(input, 'queue').catch((error: unknown) => error)
    const loss = new TypeError('Response lost')
    reject(loss)
    expect(await first).toBe(loss)
    expect(await third).toBe(loss)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('real HTTP commits only one queued prompt when its response is lost and a duplicate is waiting', async () => {
    const ledger: { method: string; payload: unknown }[] = []
    let releaseFirst!: () => void
    let firstReceived!: () => void
    const received = new Promise<void>((resolve) => {
      firstReceived = resolve
    })
    const server = createServer((req) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        // The test server commits before dropping the response. This measures
        // actual received HTTP writes, rather than calls to a mock fetch.
        ledger.push(JSON.parse(Buffer.concat(chunks).toString()) as { method: string; payload: unknown })
        if (ledger.length === 1) {
          releaseFirst = () => req.socket.destroy()
          firstReceived()
        } else req.socket.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing test server address')
    const client = new LoopbackApiClient({
      endpoint: { host: '127.0.0.1', port: address.port, baseUrl: `http://127.0.0.1:${address.port}` },
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 3, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: globalThis.fetch,
    })
    try {
      const repository = new Rc6SessionRepository(client)
      const first = repository.enqueuePrompt(input, 'queue').catch((error: unknown) => error)
      await received
      const second = repository.enqueuePrompt(input, 'queue').catch((error: unknown) => error)
      releaseFirst()
      expect(await first).toMatchObject({ code: 'BACKEND_UNREACHABLE' })
      expect(await second).toMatchObject({ code: 'BACKEND_UNREACHABLE' })
      expect(ledger).toHaveLength(1)
      expect(ledger[0]).toMatchObject({ method: 'session.prompt', payload: { sessionId: input.sessionId } })
    } finally {
      await client.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
