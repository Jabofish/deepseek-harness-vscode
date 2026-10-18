import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate } from '@dsh-vscode/domain'
import { CompositeInstanceDiscovery } from './instance-discovery.js'
import { isDiscoveryCancellation } from './provider.js'

const candidate: BackendCandidate = {
  endpoint: { host: '127.0.0.1', port: 3939, baseUrl: 'http://127.0.0.1:3939' },
  source: 'default-port',
  confidence: 10,
}

describe('CompositeInstanceDiscovery cancellation', () => {
  it('recognizes abort errors from platform process APIs', () => {
    const controller = new AbortController()

    expect(isDiscoveryCancellation({ code: 'ABORT_ERR' })).toBe(true)
    expect(isDiscoveryCancellation({ name: 'AbortError' })).toBe(true)
    expect(isDiscoveryCancellation(new Error('unrelated'))).toBe(false)

    controller.abort()
    expect(isDiscoveryCancellation(new Error('wrapped abort'), controller.signal)).toBe(true)
  })

  it('does not convert cancellation during provider fan-out into an empty result', async () => {
    const controller = new AbortController()
    let release: (() => void) | undefined
    const pending = new Promise<readonly BackendCandidate[]>((resolve) => {
      release = () => resolve([candidate])
    })
    const provider = { id: 'slow', discover: vi.fn(() => pending) }
    const discovery = new CompositeInstanceDiscovery([provider])

    const operation = discovery.discover(controller.signal)
    controller.abort()
    release?.()

    await expect(operation).rejects.toBeDefined()
  })
})

describe('CompositeInstanceDiscovery phases', () => {
  it('completes a fast pass without rereading sources and binds fresh process identity', async () => {
    const fast = {
      id: 'known',
      discover: vi.fn(() => Promise.resolve([{ ...candidate, source: 'known' as const }])),
    }
    const processCandidate: BackendCandidate = {
      ...candidate,
      source: 'process-scan',
      runtimeVersion: '0.2.1-rc.2',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25140,
      commandLine: '/opt/node_modules/@deepseek-ai/dsh/lib/bin.js web',
    }
    const fallback = {
      id: 'process',
      phase: 'fallback' as const,
      discover: vi.fn(() => Promise.resolve([processCandidate])),
    }
    const discovery = new CompositeInstanceDiscovery([fast, fallback])
    const first = await discovery.discoverFast()
    expect(first[0]).not.toHaveProperty('runtimeVersion')
    await expect(discovery.discoverRemaining(first)).resolves.toMatchObject([
      {
        source: 'known',
        runtimeVersion: '0.2.1-rc.2',
        runtimeVersionEvidence: 'process-manifest',
        pid: 25140,
      },
    ])
    expect(fast.discover).toHaveBeenCalledOnce()
    expect(fallback.discover).toHaveBeenCalledOnce()

    fast.discover.mockResolvedValueOnce([])
    expect(await discovery.discoverFast()).toEqual([])
    expect(fast.discover).toHaveBeenCalledTimes(2)
  })

  it('does not reuse fast candidates after cancellation or let them bypass the loopback allow-list', async () => {
    const discovery = new CompositeInstanceDiscovery([])
    const remote = {
      ...candidate,
      endpoint: { host: 'example.test', port: 3939, baseUrl: 'http://example.test:3939' },
    }
    await expect(discovery.discoverRemaining([remote])).resolves.toEqual([])
    const controller = new AbortController()
    controller.abort()
    await expect(discovery.discoverRemaining([candidate], controller.signal)).rejects.toBeDefined()
  })

  it('keeps slow process providers out of the fast pass', async () => {
    const fastCandidate: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3940, baseUrl: 'http://127.0.0.1:3940' },
      source: 'known',
      confidence: 90,
    }
    const fallbackCandidate: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3941, baseUrl: 'http://127.0.0.1:3941' },
      source: 'process-scan',
      confidence: 70,
    }
    const fast = { id: 'known', discover: vi.fn(() => Promise.resolve([fastCandidate])) }
    const fallback = {
      id: 'process',
      phase: 'fallback' as const,
      discover: vi.fn(() => Promise.resolve([fallbackCandidate])),
    }
    const discovery = new CompositeInstanceDiscovery([fast, fallback])

    await expect(discovery.discoverFast()).resolves.toEqual([fastCandidate])
    expect(fast.discover).toHaveBeenCalledTimes(1)
    expect(fallback.discover).not.toHaveBeenCalled()

    await expect(discovery.discover()).resolves.toEqual([fastCandidate, fallbackCandidate])
    expect(fast.discover).toHaveBeenCalledTimes(2)
    expect(fallback.discover).toHaveBeenCalledTimes(1)
  })

  it('keeps configured, known, and default sources fast while companion waits for full discovery', async () => {
    const configuredCandidate: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3945, baseUrl: 'http://127.0.0.1:3945' },
      source: 'configured',
      confidence: 100,
    }
    const knownCandidate: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3946, baseUrl: 'http://127.0.0.1:3946' },
      source: 'known',
      confidence: 90,
    }
    const defaultCandidate: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3947, baseUrl: 'http://127.0.0.1:3947' },
      source: 'default-port',
      confidence: 80,
    }
    const companionCandidate: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3948, baseUrl: 'http://127.0.0.1:3948' },
      source: 'companion',
      confidence: 60,
    }
    const configured = { id: 'configured', discover: vi.fn(() => Promise.resolve([configuredCandidate])) }
    const known = { id: 'known', discover: vi.fn(() => Promise.resolve([knownCandidate])) }
    const defaultPort = { id: 'default-port', discover: vi.fn(() => Promise.resolve([defaultCandidate])) }
    const companion = {
      id: 'companion',
      phase: 'fallback' as const,
      discover: vi.fn(() => Promise.resolve([companionCandidate])),
    }
    const discovery = new CompositeInstanceDiscovery([configured, known, defaultPort, companion])

    await expect(discovery.discoverFast()).resolves.toEqual([
      configuredCandidate,
      knownCandidate,
      defaultCandidate,
    ])
    expect(companion.discover).not.toHaveBeenCalled()

    await expect(discovery.discover()).resolves.toEqual([
      configuredCandidate,
      knownCandidate,
      companionCandidate,
      defaultCandidate,
    ])
    expect(configured.discover).toHaveBeenCalledTimes(2)
    expect(known.discover).toHaveBeenCalledTimes(2)
    expect(defaultPort.discover).toHaveBeenCalledTimes(2)
    expect(companion.discover).toHaveBeenCalledTimes(1)
  })

  it('keeps the preferred endpoint source and merges a same-endpoint process version identity', async () => {
    const configured: BackendCandidate = {
      endpoint: { host: '127.0.0.1', port: 3942, baseUrl: 'http://127.0.0.1:3942' },
      source: 'configured',
      confidence: 100,
    }
    const processCandidate: BackendCandidate & { runtimeVersionEvidence: 'process-manifest' } = {
      ...configured,
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25140,
      commandLine: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 70,
    }
    const discovery = new CompositeInstanceDiscovery([
      { id: 'configured', discover: vi.fn(() => Promise.resolve([configured])) },
      { id: 'process', discover: vi.fn(() => Promise.resolve([processCandidate])) },
    ])

    await expect(discovery.discover()).resolves.toEqual([
      {
        ...configured,
        runtimeVersion: '0.1.7-rc.1',
        runtimeVersionEvidence: 'process-manifest',
        pid: 25140,
        commandLine: processCandidate.commandLine,
      },
    ])
  })

  it('preserves verified process identity on a companion winner and discards its raw identity hints', async () => {
    const endpoint = { host: '127.0.0.1' as const, port: 3944, baseUrl: 'http://127.0.0.1:3944' }
    const companion: BackendCandidate = {
      endpoint,
      source: 'companion',
      runtimeVersion: '0.1.7-alpha.2',
      pid: 25200,
      confidence: 60,
    }
    const processCandidate: BackendCandidate & { runtimeVersionEvidence: 'process-manifest' } = {
      endpoint,
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25150,
      commandLine: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web',
      confidence: 70,
    }
    const discovery = new CompositeInstanceDiscovery([
      { id: 'companion', discover: vi.fn(() => Promise.resolve([companion])) },
      { id: 'process', discover: vi.fn(() => Promise.resolve([processCandidate])) },
    ])

    await expect(discovery.discover()).resolves.toEqual([
      {
        endpoint,
        source: 'companion',
        confidence: 60,
        runtimeVersion: '0.1.7-rc.1',
        runtimeVersionEvidence: 'process-manifest',
        pid: 25150,
        commandLine: processCandidate.commandLine,
      },
    ])
  })

  it('uses only unique verified process-manifest identity and ignores companion PID/version', async () => {
    const endpoint = { host: '127.0.0.1' as const, port: 3943, baseUrl: 'http://127.0.0.1:3943' }
    type ManifestCandidate = BackendCandidate & {
      readonly runtimeVersionEvidence: 'process-manifest'
    }
    const liveProcess: ManifestCandidate = {
      endpoint,
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25140,
      commandLine: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 70,
    }
    const staleCompanion: BackendCandidate = {
      endpoint,
      source: 'companion',
      runtimeVersion: '0.1.7-alpha.2',
      pid: 25200,
      confidence: 60,
    }
    const ambiguousProcess: ManifestCandidate = {
      ...liveProcess,
      pid: 25141,
    }
    const unverifiedProcess: BackendCandidate = {
      endpoint,
      source: 'process-scan',
      runtimeVersion: '0.1.7-rc.1',
      pid: 25140,
      commandLine: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 70,
    }
    const malformedProcess: ManifestCandidate = {
      ...liveProcess,
      runtimeVersion: '0.1.7-rc.01',
    }
    const missingManifestVersion: ManifestCandidate = {
      endpoint,
      source: 'process-scan',
      runtimeVersionEvidence: 'process-manifest',
      pid: 25140,
      commandLine: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web',
      confidence: 70,
    }
    const cases: readonly (readonly [
      string,
      readonly BackendCandidate[],
      string | undefined,
      number | undefined,
    ])[] = [
      [
        'stale companion metadata beside a verified process',
        [staleCompanion, liveProcess],
        '0.1.7-rc.1',
        25140,
      ],
      ['companion-only identity', [staleCompanion], undefined, undefined],
      ['process version without manifest evidence', [unverifiedProcess], undefined, undefined],
      ['ambiguous process PIDs', [liveProcess, ambiguousProcess], undefined, undefined],
      ['malformed process version', [malformedProcess], undefined, undefined],
      ['missing process manifest version', [liveProcess, missingManifestVersion], undefined, undefined],
    ]

    for (const [label, candidates, expectedVersion, expectedPid] of cases) {
      const discovery = new CompositeInstanceDiscovery([
        { id: label, discover: vi.fn(() => Promise.resolve(candidates)) },
      ])
      const [resolved] = await discovery.discover()
      expect(resolved?.runtimeVersion, label).toBe(expectedVersion)
      if (expectedVersion === undefined) expect(resolved).not.toHaveProperty('runtimeVersionEvidence')
      else expect(resolved).toMatchObject({ runtimeVersionEvidence: 'process-manifest' })
      expect(resolved?.pid, label).toBe(expectedPid)
    }
  })
})

describe('CompositeInstanceDiscovery canonical endpoint allow-list', () => {
  it('keeps only validated loopback endpoints and drops remote or malformed ones', async () => {
    const reachable: readonly BackendCandidate['endpoint'][] = [
      { host: '127.0.0.1', port: 3960, baseUrl: 'http://127.0.0.1:3960' },
      { host: 'localhost', port: 3961, baseUrl: 'http://localhost:3961' },
      { host: 'dsh.home.arpa', port: 3962, baseUrl: 'http://dsh.home.arpa:3962' },
      { host: '[::1]', port: 3963, baseUrl: 'http://[::1]:3963' },
    ]
    // A canonical host alone is not enough: the baseUrl must describe the same
    // endpoint, and port 0 is not connectable.
    const malformed: readonly BackendCandidate['endpoint'][] = [
      { host: 'localhost', port: 3964, baseUrl: 'http://127.0.0.1:3964' },
      { host: 'localhost', port: 0, baseUrl: 'http://localhost:0' },
    ]
    const candidates = [...reachable, ...malformed].map((endpoint) => ({
      endpoint,
      source: 'known' as const,
      confidence: 50,
    }))
    const discovery = new CompositeInstanceDiscovery([
      { id: 'mixed', discover: vi.fn(() => Promise.resolve(candidates)) },
    ])

    const resolved = await discovery.discover()

    expect(resolved.map((entry) => entry.endpoint.baseUrl)).toEqual(
      reachable.slice(0, 2).map((endpoint) => endpoint.baseUrl),
    )
  })
})
