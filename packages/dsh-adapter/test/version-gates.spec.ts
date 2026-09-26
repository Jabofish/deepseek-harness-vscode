import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate } from '@dsh-vscode/domain'

import { Alpha2VersionAdapter } from '../src/versions/alpha2/adapter.js'
import { Alpha3VersionAdapter } from '../src/versions/alpha3/adapter.js'
import { Alpha4VersionAdapter } from '../src/versions/alpha4/adapter.js'
import { Alpha5VersionAdapter } from '../src/versions/alpha5/adapter.js'
import { FakeWebSocket } from './support/fake-web-socket.js'
import { candidate, rpcResponse, transportOptions } from './support/contract-harness.js'

/**
 * The version gate is one shared probe mechanism; each exact-only alpha adapter
 * differs only in the identity it reports and the neighbors it declines. The
 * identity table below is the single statement of that mapping — add a row per
 * new exact-only version instead of copying the gate case into its contract
 * spec. Version adapters with extra gate behavior (compatibility fallback,
 * capability-specific declines) keep their own cases in their contract spec.
 */
const EXACT_GATES: readonly {
  readonly name: string
  readonly dshVersion: string
  readonly declines: readonly string[]
  readonly identity: Record<string, unknown>
  readonly build: (fetch: typeof globalThis.fetch) => {
    probe(c: BackendCandidate): Promise<unknown>
  }
}[] = [
  {
    name: 'alpha.2',
    dshVersion: '0.1.2-alpha.2',
    declines: ['0.1.2-alpha.1'],
    identity: { protocolVersion: 'alpha2', dshVersion: '0.1.2-alpha.2', subagentImagePrompts: false },
    build: (fetch) => new Alpha2VersionAdapter({ ...transportOptions(fetch), webSocket: FakeWebSocket }),
  },
  {
    name: 'alpha.3',
    dshVersion: '0.1.2-alpha.3',
    declines: ['0.1.2-alpha.2'],
    identity: { protocolVersion: 'alpha3', dshVersion: '0.1.2-alpha.3', subagentImagePrompts: true },
    build: (fetch) => new Alpha3VersionAdapter(transportOptions(fetch)),
  },
  {
    name: 'alpha.4',
    dshVersion: '0.1.2-alpha.4',
    declines: ['0.1.2-alpha.3'],
    identity: { protocolVersion: 'alpha4', dshVersion: '0.1.2-alpha.4' },
    build: (fetch) => new Alpha4VersionAdapter(transportOptions(fetch)),
  },
  {
    name: 'alpha.5',
    dshVersion: '0.1.2-alpha.5',
    declines: ['0.1.2-alpha.4'],
    identity: { protocolVersion: 'alpha5', dshVersion: '0.1.2-alpha.5', subagentImagePrompts: true },
    build: (fetch) => new Alpha5VersionAdapter(transportOptions(fetch)),
  },
]

describe('DSH exact-only version gates', () => {
  it('selects only the exact runtime and keeps each pinned protocol identity', async () => {
    for (const gate of EXACT_GATES) {
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(rpcResponse(init, { ok: true, value: { items: [] } })),
      )
      const adapter = gate.build(fetch)

      await expect(adapter.probe(candidate(gate.dshVersion)), gate.name).resolves.toMatchObject(gate.identity)
      for (const declined of gate.declines) {
        await expect(
          adapter.probe(candidate(declined)),
          `${gate.name} declines ${declined}`,
        ).resolves.toBeUndefined()
      }
      expect(fetch, gate.name).toHaveBeenCalledOnce()
    }
  })
})
