import { describe, expect, it, vi } from 'vitest'

import {
  parseDshProcessCandidates,
  resolveDshProcessRuntimeVersions,
  resolveEndpointProcesses,
} from './process-provider.js'
import { runWindowsProcessListing } from './windows-process-provider.js'

describe('OS process discovery parsing', () => {
  it('queries only listener PIDs for preferred endpoints and rejects unrelated services', async () => {
    const endpoint = { host: '127.0.0.1', port: 4310, baseUrl: 'http://127.0.0.1:4310' }
    const read = vi.fn(() =>
      Promise.resolve('25140 node /opt/node_modules/@deepseek-ai/dsh/lib/bin.js web\n25141 node other.js'),
    )
    const listeners =
      'TCP 127.0.0.1:4310 0.0.0.0:0 LISTENING 25140\nTCP 127.0.0.1:4311 0.0.0.0:0 LISTENING 25141'
    await expect(resolveEndpointProcesses([endpoint], listeners, read)).resolves.toMatchObject([
      { pid: 25140, source: 'process-scan', endpoint: { port: 4310 } },
    ])
    expect(read).toHaveBeenCalledWith([25140])
    await expect(
      resolveEndpointProcesses(
        [{ ...endpoint, port: 4312, baseUrl: 'http://127.0.0.1:4312' }],
        listeners,
        read,
      ),
    ).resolves.toEqual([])
    expect(read).toHaveBeenCalledOnce()
    await expect(
      resolveEndpointProcesses([endpoint], listeners, read, AbortSignal.abort()),
    ).rejects.toBeDefined()
    expect(read).toHaveBeenCalledOnce()
  })

  it('bounds targeted Windows WMI queries to validated listener PIDs', async () => {
    const run = vi.fn().mockResolvedValue('"CommandLine","ProcessId"')
    await runWindowsProcessListing(run, undefined, [25140, 25141])
    expect(run).toHaveBeenCalledWith(
      'wmic.exe',
      [
        'process',
        'where',
        'ProcessId = 25140 OR ProcessId = 25141',
        'get',
        'CommandLine,ProcessId',
        '/format:csv',
      ],
      undefined,
    )
    await runWindowsProcessListing(run, undefined, [NaN, -1, 0])
    expect(run).toHaveBeenCalledOnce()
  })
  it('returns only loopback listeners owned by a web-profile DSH process', () => {
    const candidates = parseDshProcessCandidates(
      '25140 node /opt/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 0\n25141 node other.js --profile web',
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))\nLISTEN 0 128 0.0.0.0:12983 0.0.0.0:* users:(("node",pid=25140,fd=19))',
    )
    expect(candidates).toMatchObject([
      {
        endpoint: { host: '127.0.0.1', port: 12982 },
        pid: 25140,
        source: 'process-scan',
      },
    ])
  })

  it('requires a TCP LISTEN state on Linux, macOS, and Windows listener output', () => {
    const processOutput = '25140 node /opt/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 0'
    const listeners = [
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))',
      'node 25140 user 18u IPv4 0x123 0t0 TCP 127.0.0.1:12983 (LISTEN)',
      '  TCP    127.0.0.1:12984    0.0.0.0:0    LISTENING    25140',
    ]

    expect(
      listeners.map((listener) => parseDshProcessCandidates(processOutput, listener)[0]?.endpoint.port),
    ).toEqual([12982, 12983, 12984])

    const nonListeners = [
      '  TCP    127.0.0.1:12985    192.0.2.5:80    ESTABLISHED    25140',
      '  TCP    127.0.0.1:12986    0.0.0.0:0    TIME_WAIT    25140',
      '  UDP    127.0.0.1:12987    *:*    25140',
    ]
    for (const listener of nonListeners)
      expect(parseDshProcessCandidates(processOutput, listener)).toEqual([])
  })

  it('reads an exact package version only from the listener process DSH CLI package', async () => {
    const [candidate] = parseDshProcessCandidates(
      '25140 node "/opt/dsh install/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web --port 0',
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))',
    )
    const readManifest = vi.fn((filePath: string) => {
      expect(filePath).toBe('/opt/dsh install/node_modules/@deepseek-ai/dsh/package.json')
      return Promise.resolve(JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' }))
    })

    const [resolved] = await resolveDshProcessRuntimeVersions([candidate!], readManifest)
    expect(resolved).toMatchObject({
      source: 'process-scan',
      pid: 25140,
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
    })
  })

  it('resolves the exact upstream CLI package from a Windows process command line with spaces', async () => {
    const [candidate] = parseDshProcessCandidates(
      'Node,Machine,"""C:\\Program Files\\node.exe"" ""C:\\npm cache\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"" --profile web --port 0",25140',
      '  TCP    127.0.0.1:12982    0.0.0.0:0    LISTENING    25140',
    )
    const readManifest = vi.fn((filePath: string) => {
      expect(filePath).toBe('C:\\npm cache\\node_modules\\@deepseek-ai\\dsh\\package.json')
      return Promise.resolve(JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' }))
    })

    const [resolved] = await resolveDshProcessRuntimeVersions([candidate!], readManifest)

    expect(resolved).toMatchObject({
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
    })
  })

  it.each([
    ['wrong package', JSON.stringify({ name: '@deepseek-ai/other', version: '0.1.7-rc.1' })],
    ['missing version', JSON.stringify({ name: '@deepseek-ai/dsh' })],
    ['malformed version', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1 trailing' })],
    ['invalid manifest', '{'],
  ])('does not attach a version from a %s manifest', async (_label, manifest) => {
    const [candidate] = parseDshProcessCandidates(
      '25140 node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 0',
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))',
    )

    const [resolved] = await resolveDshProcessRuntimeVersions([candidate!], () => Promise.resolve(manifest))
    expect(resolved?.runtimeVersion).toBeUndefined()
  })

  it('does not read arbitrary paths or guess when the command line is ambiguous', async () => {
    const relative = parseDshProcessCandidates(
      '25140 node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 0',
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))',
    )
    const ambiguous = parseDshProcessCandidates(
      '25140 /one/node_modules/@deepseek-ai/dsh/lib/bin.js /two/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 0',
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))',
    )
    const optionValue = parseDshProcessCandidates(
      '25140 node --require /ignored/node_modules/@deepseek-ai/dsh/lib/bin.js app.js --profile web',
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))',
    )
    const readManifest = vi.fn(() =>
      Promise.resolve(JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' })),
    )

    const resolved = await resolveDshProcessRuntimeVersions(
      [...relative, ...ambiguous, ...optionValue],
      readManifest,
    )
    expect(resolved).toEqual([])
    expect(readManifest).not.toHaveBeenCalled()
  })
})
