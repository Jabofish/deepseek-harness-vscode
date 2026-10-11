import { describe, expect, it, vi, type Mock } from 'vitest'
import { Alpha211InspectorRepository } from '../src/versions/alpha211/inspector-repository.js'
import { endpoint } from './support/contract-harness.js'

// Pinned 5badb150: experimental/inspector/shared/web.ts + worker/bridge/endpoint.ts.
const socket = 'ws://127.0.0.1:3456/devtools/page/target-1'
const frontendUrl =
  'devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:3456/devtools/page/target-1&panel=elements&noJavaScriptCompletion=true'
const target = {
  id: 'target-1',
  type: 'page',
  title: 'DeepSeek Harness Host',
  url: 'dsh://host',
  webSocketDebuggerUrl: socket,
  devtoolsFrontendUrl: frontendUrl,
}
const version = {
  Browser: 'dsh-experimental-inspector/0',
  'Protocol-Version': '1.3',
  webSocketDebuggerUrl: socket,
}
function fixture(
  bootstrap: unknown = { endpoint: 'ws://127.0.0.1:3456/ingest', protocol: 'PRIVATE_INGEST_TOKEN' },
  worker: unknown = [target],
): { fetch: Mock<typeof globalThis.fetch>; repository: Alpha211InspectorRepository } {
  const fetch = vi.fn<typeof globalThis.fetch>((url) => {
    const address = url instanceof Request ? url.url : url.toString()
    return Promise.resolve(
      address.endsWith('/bootstrap')
        ? Response.json(bootstrap)
        : address.endsWith('/json/version')
          ? Response.json(version)
          : Response.json(worker),
    )
  })
  const repository = new Alpha211InspectorRepository({
    endpoint,
    fetch,
    requestTimeoutMs: 100,
    authCookie: () => 'PRIVATE_COOKIE',
  })
  return { fetch, repository }
}
describe('alpha211 optional Inspector discovery', () => {
  it('never interprets a remote or forwarded worker announcement as local', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    for (const options of [
      { endpoint: { host: 'remote.example', port: 443, baseUrl: 'https://remote.example:443' } },
      { endpoint, allowWorkerDiscovery: () => false },
    ]) {
      const repository = new Alpha211InspectorRepository({ ...options, fetch, requestTimeoutMs: 100 })
      await expect(repository.discover()).resolves.toEqual({ available: false })
      await repository.close()
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it('preserves an explicitly announced default port in verified debugger wire strings', async () => {
    const f = fixture()
    const atDefault = (value: string): string => value.replace(':3456', ':80')
    f.fetch.mockResolvedValueOnce(Response.json({ endpoint: 'ws://127.0.0.1:80/ingest' }))
    f.fetch.mockResolvedValueOnce(Response.json({ ...version, webSocketDebuggerUrl: atDefault(socket) }))
    f.fetch.mockResolvedValueOnce(
      Response.json([
        { ...target, webSocketDebuggerUrl: atDefault(socket), devtoolsFrontendUrl: atDefault(frontendUrl) },
      ]),
    )
    await expect(f.repository.discover()).resolves.toEqual({
      available: true,
      frontendUrl: atDefault(frontendUrl),
    })
    await f.repository.close()
  })
  it('validates official identity and paths; credentials stay on the authenticated main route', async () => {
    const f = fixture()
    await expect(f.repository.discover()).resolves.toEqual({ available: true, frontendUrl })
    expect(f.fetch.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString()))).toEqual([
      `${endpoint.baseUrl}/api/experimental-inspector/bootstrap`,
      'http://127.0.0.1:3456/json/version',
      'http://127.0.0.1:3456/json/list',
    ])
    expect(f.fetch.mock.calls[0]?.[1]?.headers).toEqual({ Cookie: 'PRIVATE_COOKIE' })
    expect(
      f.fetch.mock.calls.slice(1).every(([, options]) => JSON.stringify(options?.headers) === '{}'),
    ).toBe(true)
    expect(f.fetch.mock.calls.every(([, options]) => options?.redirect === 'error')).toBe(true)
    await f.repository.close()
    await expect(f.repository.discover()).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
  })
  it('releases an absent/unauthorized response and distinguishes optional absence from denial', async () => {
    for (const status of [404, 403]) {
      const f = fixture()
      const release = vi.fn()
      f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: release }), { status }))
      if (status === 404) await expect(f.repository.discover()).resolves.toEqual({ available: false })
      else await expect(f.repository.discover()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(release).toHaveBeenCalledTimes(1)
      expect(f.fetch).toHaveBeenCalledTimes(1)
    }
  })
  it.each([
    'not a URL',
    'ws://2130706433:3456/ingest',
    'ws://remote.example/ingest',
    'ws://localhost:3456/ingest',
    'http://127.0.0.1:3456/ingest',
    'ws://127.0.0.1:3456/other',
    'ws://user:secret@127.0.0.1:3456/ingest',
    'ws://127.0.0.1:3456/ingest?token=x',
  ])('refuses unverified bootstrap target %s before worker requests', async (url) => {
    const f = fixture({ endpoint: url })
    await expect(f.repository.discover()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { worker: [{ ...target, webSocketDebuggerUrl: 'ws://remote.example/evil' }] },
    { worker: [{ ...target, devtoolsFrontendUrl: 'https://evil.example' }] },
    { worker: [{ ...target, id: '../evil' }] },
    { worker: [target, target] },
  ])('refuses a mismatched worker target', async ({ worker }) => {
    await expect(fixture(undefined, worker).repository.discover()).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
  it('rejects malformed identity, JSON, UTF-8 and oversized streamed bodies', async () => {
    for (const response of [
      Response.json({ Browser: 'other', 'Protocol-Version': '1.3' }),
      new Response('not JSON'),
      new Response(new Uint8Array([0xff])),
      new Response('x'.repeat(32769)),
    ]) {
      const f = fixture()
      f.fetch.mockResolvedValueOnce(response)
      await expect(f.repository.discover()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    }
  })
  it('cancels and bounds discovery without reading diagnostic bodies', async () => {
    for (const mode of ['caller', 'timeout', 'close'] as const) {
      const f = fixture()
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      f.fetch.mockImplementationOnce(async (_url, options) => {
        entered()
        return await new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new DOMException(
                  'cancelled',
                  options.signal?.reason instanceof Error ? options.signal.reason.name : 'AbortError',
                ),
              ),
            { once: true },
          ),
        )
      })
      const controller = new AbortController()
      const result = expect(f.repository.discover(controller.signal)).rejects.toMatchObject({
        code: mode === 'timeout' ? 'BACKEND_UNREACHABLE' : 'REQUEST_CANCELLED',
      })
      await started
      if (mode === 'caller') controller.abort()
      if (mode === 'close') await f.repository.close()
      await result
      expect(f.fetch).toHaveBeenCalledTimes(1)
    }
  })
})
