import { describe, expect, it, vi } from 'vitest'

import { VersionedBackendProbe } from '../src/probe.js'
import { Rc153VersionAdapter, type Rc153AdapterOptions } from '../src/versions/rc153/adapter.js'
import { candidate, wrappedResponse as response } from './support/contract-harness.js'

function options(fetch: typeof globalThis.fetch): Rc153AdapterOptions {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  }
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}

function observeTransportClose(adapter: Rc153VersionAdapter): ReturnType<typeof vi.fn> {
  const closed = vi.fn()
  const createTransport = adapter.createTransport.bind(adapter)
  vi.spyOn(adapter, 'createTransport').mockImplementation((target) => {
    const transport = createTransport(target)
    const close = transport.close.bind(transport)
    vi.spyOn(transport, 'close').mockImplementation(async () => {
      closed()
      await close()
    })
    return transport
  })
  return closed
}

describe('DSH 0.1.5-rc.3 exact adapter contract', () => {
  it('keeps an independent exact identity while using the verified rc.2 session.list probe wire', async () => {
    const requestPaths: string[] = []
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      requestPaths.push(requestUrl(input).pathname)
      return Promise.resolve(response(init, { items: [] }))
    })
    const adapter = new Rc153VersionAdapter(options(fetch))
    const closed = observeTransportClose(adapter)

    await expect(adapter.probe(candidate('0.1.5-rc.3'))).resolves.toMatchObject({
      protocolVersion: 'rc153',
      dshVersion: '0.1.5-rc.3',
      sessionRestore: false,
    })
    expect(adapter).toMatchObject({
      id: 'dsh-0.1.5-rc.3',
      supportedVersion: '0.1.5-rc.3',
      protocolVersion: 'rc153',
      fallback: false,
    })
    expect(requestPaths).toEqual(['/api/session/list'])
    expect(fetch).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('declines neighboring known releases and exact releases on the compatibility path without network access', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response()))
    const adapter = new Rc153VersionAdapter(options(fetch))

    await expect(adapter.probe(candidate('0.1.5-rc.2'))).resolves.toBeUndefined()
    await expect(adapter.probe(candidate('0.1.5-alpha.2'))).resolves.toBeUndefined()
    await expect(adapter.probeCompatibility(candidate('0.1.5-rc.2'))).resolves.toBeUndefined()
    await expect(new VersionedBackendProbe([adapter]).probe(candidate('0.1.5-rc.4'))).resolves.toBeUndefined()

    expect(fetch).not.toHaveBeenCalled()
    expect(adapter.fallback).toBe(false)
  })

  it('declines malformed session.list values and closes its transport', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: 'malformed' })),
    )
    const adapter = new Rc153VersionAdapter(options(fetch))
    const closed = observeTransportClose(adapter)

    await expect(adapter.probe(candidate('0.1.5-rc.3'))).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('declines transport failures and closes its transport', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new TypeError('connection refused')),
    )
    const adapter = new Rc153VersionAdapter(options(fetch))
    const closed = observeTransportClose(adapter)

    await expect(adapter.probe(candidate('0.1.5-rc.3'))).resolves.toBeUndefined()

    expect(fetch).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('propagates probe cancellation and still closes its transport', async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = (): void => reject(new DOMException('Request aborted', 'AbortError'))
          if (init?.signal?.aborted === true) abort()
          else init?.signal?.addEventListener('abort', abort, { once: true })
        }),
    )
    const adapter = new Rc153VersionAdapter(options(fetch))
    const closed = observeTransportClose(adapter)
    const controller = new AbortController()
    const probing = adapter.probe(candidate('0.1.5-rc.3'), controller.signal)

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    controller.abort()

    await expect(probing).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(closed).toHaveBeenCalledOnce()
  })
})
