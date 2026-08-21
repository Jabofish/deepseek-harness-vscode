import { describe, expect, it } from 'vitest'
import { normalizeLoopbackUrl, VsCodeConfigurationSource } from './configuration-source.js'

describe('DSH connection configuration', () => {
  it('reads custom mode and normalizes a loopback endpoint', () => {
    const source = new VsCodeConfigurationSource({
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) =>
          ({
            'connection.mode': 'custom',
            'connection.serverUrl': 'http://localhost:4310/',
          })[key] ?? fallback,
      }),
      onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    } as never)

    expect(source.read().connection).toMatchObject({
      mode: 'custom',
      serverUrl: 'http://localhost:4310',
    })
  })

  it('rejects non-loopback or non-http endpoints', () => {
    expect(() => normalizeLoopbackUrl('https://127.0.0.1:4310')).toThrowError(
      'Invalid DSH setting connection.serverUrl',
    )
    expect(() => normalizeLoopbackUrl('http://192.168.1.10:4310')).toThrowError(
      'Invalid DSH setting connection.serverUrl',
    )
    expect(() => normalizeLoopbackUrl('http://127.0.0.1:4310/v1')).toThrowError(
      'Invalid DSH setting connection.serverUrl',
    )
  })
})
