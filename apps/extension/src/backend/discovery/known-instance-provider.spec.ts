import type * as vscode from 'vscode'
import { describe, expect, it } from 'vitest'

import { KnownInstanceDiscoveryProvider } from './known-instance-provider.js'

function state(value: unknown): vscode.Memento {
  return {
    get: <T>(_key: string) => value as T,
  } as vscode.Memento
}

describe('known instance discovery', () => {
  it('reconstructs a loopback endpoint from the port-only state', async () => {
    await expect(new KnownInstanceDiscoveryProvider(state({ port: 3921 })).discover()).resolves.toEqual([
      {
        endpoint: { host: '127.0.0.1', port: 3921, baseUrl: 'http://127.0.0.1:3921' },
        source: 'known',
        confidence: 90,
      },
    ])
  })

  it('accepts the legacy endpoint shape for one-way migration', async () => {
    await expect(
      new KnownInstanceDiscoveryProvider(
        state({ endpoint: { host: 'localhost', port: 3922, baseUrl: 'http://localhost:3922' } }),
      ).discover(),
    ).resolves.toMatchObject([{ endpoint: { host: '127.0.0.1', port: 3922 } }])
  })

  it('ignores malformed or non-loopback state', async () => {
    await expect(new KnownInstanceDiscoveryProvider(state({ port: 0 })).discover()).resolves.toEqual([])
    await expect(
      new KnownInstanceDiscoveryProvider(
        state({ endpoint: { host: '192.168.1.10', port: 3922, baseUrl: 'http://192.168.1.10:3922' } }),
      ).discover(),
    ).resolves.toEqual([])
  })
})
