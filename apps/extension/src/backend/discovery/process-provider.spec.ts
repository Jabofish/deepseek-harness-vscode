import { describe, expect, it, vi } from 'vitest'

import { parseDshProcessCandidates, resolveDshProcessRuntimeVersions } from './process-provider.js'
import { runWindowsProcessListing } from './windows-process-provider.js'

describe('OS process discovery parsing', () => {
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

  it('understands Windows netstat and WMIC-shaped output', () => {
    const candidates = parseDshProcessCandidates(
      'Node,Machine,"node.exe C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 0",25140',
      '  TCP    127.0.0.1:12982    0.0.0.0:0    LISTENING    25140',
    )
    expect(candidates[0]).toMatchObject({ endpoint: { port: 12982 }, pid: 25140 })
  })

  it('accepts the parser-compatible CIM fallback output', () => {
    const candidates = parseDshProcessCandidates(
      'node.exe C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 0,25140',
      '  TCP    127.0.0.1:12982    0.0.0.0:0    LISTENING    25140',
    )
    expect(candidates[0]).toMatchObject({ endpoint: { port: 12982 }, pid: 25140 })
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
    expect(readManifest).toHaveBeenCalledTimes(1)
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
    expect(readManifest).toHaveBeenCalledTimes(1)
  })

  it('parses WMIC CommandLine,ProcessId CSV without assuming a Machine column', async () => {
    const [candidate] = parseDshProcessCandidates(
      'Node,"""C:\\Program Files\\node.exe"" ""C:\\npm,cache\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"" --profile web --port 0",25140',
      '  TCP    127.0.0.1:12982    0.0.0.0:0    LISTENING    25140',
    )
    const readManifest = vi.fn((filePath: string) => {
      expect(filePath).toBe('C:\\npm,cache\\node_modules\\@deepseek-ai\\dsh\\package.json')
      return Promise.resolve(JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' }))
    })

    const [resolved] = await resolveDshProcessRuntimeVersions([candidate!], readManifest)

    expect(resolved).toMatchObject({
      runtimeVersion: '0.1.7-rc.1',
      runtimeVersionEvidence: 'process-manifest',
    })
    expect(readManifest).toHaveBeenCalledTimes(1)
  })

  it('recognizes the exact CLI web profile shorthand on Linux and Windows', () => {
    const linux = parseDshProcessCandidates(
      '25140 node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0',
      'LISTEN 0 128 127.0.0.1:12982 0.0.0.0:* users:(("node",pid=25140,fd=18))',
    )
    const windows = parseDshProcessCandidates(
      'Node,"""C:\\Program Files\\node.exe"" ""C:\\npm cache\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"" web --port 0",25141',
      '  TCP    127.0.0.1:12983    0.0.0.0:0    LISTENING    25141',
    )

    expect(linux).toMatchObject([{ endpoint: { port: 12982 }, pid: 25140 }])
    expect(windows).toMatchObject([{ endpoint: { port: 12983 }, pid: 25141 }])
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

  it('uses escaped CIM CSV in the Windows fallback and parses quoted command lines', async () => {
    const cimOutput = [
      '"CommandLine","ProcessId"',
      '"""C:\\Program Files\\node.exe"" ""C:\\npm,cache\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"" --profile web --port 0","25140"',
    ].join('\n')
    const runCommand = vi
      .fn<(executable: string, args: readonly string[], signal?: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error('wmic is not installed'))
      .mockResolvedValueOnce(cimOutput)

    await expect(runWindowsProcessListing(runCommand)).resolves.toBe(cimOutput)
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      'wmic.exe',
      ['process', 'get', 'CommandLine,ProcessId', '/format:csv'],
      undefined,
    )
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'powershell.exe',
      expect.arrayContaining([
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        expect.stringContaining('ConvertTo-Csv'),
      ]),
      undefined,
    )

    const [candidate] = parseDshProcessCandidates(
      cimOutput,
      '  TCP    127.0.0.1:12982    0.0.0.0:0    LISTENING    25140',
    )
    expect(candidate?.commandLine).toBe(
      '"C:\\Program Files\\node.exe" "C:\\npm,cache\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile web --port 0',
    )
    const readManifest = vi.fn((manifestPath: string) => {
      expect(manifestPath).toBe('C:\\npm,cache\\node_modules\\@deepseek-ai\\dsh\\package.json')
      return Promise.resolve(JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' }))
    })
    const [resolved] = await resolveDshProcessRuntimeVersions([candidate!], readManifest)
    expect(resolved?.runtimeVersion).toBe('0.1.7-rc.1')
    expect(readManifest).toHaveBeenCalledTimes(1)
  })
})
