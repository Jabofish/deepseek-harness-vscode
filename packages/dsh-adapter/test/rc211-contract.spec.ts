import { describe, expect, it } from 'vitest'
import {
  Alpha212VersionAdapter,
  Alpha213VersionAdapter,
  Alpha214VersionAdapter,
  Alpha215VersionAdapter,
  Rc211VersionAdapter,
  Rc212VersionAdapter,
  Rc213VersionAdapter,
} from '../src/index.js'
import { candidate, transportOptions } from './support/contract-harness.js'
import type { DshTransport } from '../src/contracts.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'

// Pinned upstream Session/Workspace/Gateway contracts:
// alpha.3 2fbf4359b82fb94c03dcce0b831660d87f12ea5c,
// alpha.4 86a402200d95fecef4529d969836f1fe13c6cb0d,
// alpha.5 1517a4dbca0a2789ff1d41ba439600f8547d23fa,
// rc.1    1600d8a1e140dcde43a1a0941940a0480712c011,
// rc.2    687f282e8625c6b8d11ff58211a90524be2e4317,
// rc.3    1f81c047fc48fa190a683e469daa699857e9afe8.
const releases = [
  [Alpha213VersionAdapter, '0.2.1-alpha.3', 'alpha213'],
  [Alpha214VersionAdapter, '0.2.1-alpha.4', 'alpha214'],
  [Alpha215VersionAdapter, '0.2.1-alpha.5', 'alpha215'],
  [Rc211VersionAdapter, '0.2.1-rc.1', 'rc211'],
  [Rc212VersionAdapter, '0.2.1-rc.2', 'rc212'],
  [Rc213VersionAdapter, '0.2.1-rc.3', 'rc213'],
] as const

describe('0.2.1 published release admission', () => {
  it.each(releases)('admits only its exact identity (%s)', async (Adapter, version, protocol) => {
    const fixture = new ProbeFixtureTransport()
    const Base: typeof Alpha212VersionAdapter = Adapter
    class FixtureAdapter extends Base {
      public override createTransport(): DshTransport {
        return fixture
      }
    }
    const adapter = new FixtureAdapter(transportOptions(globalThis.fetch))
    expect(await adapter.probe(candidate(version))).toMatchObject({
      dshVersion: version,
      protocolVersion: protocol,
      adapterId: `dsh-${version}`,
      ...(protocol === 'rc213' ? { blankSessionReuse: true } : {}),
    })
    expect(adapter.fallback).toBe(false)
    const count = fixture.methods.length
    for (const other of [
      ...releases.map(([, release]) => release).filter((release) => release !== version),
      '0.2.1-alpha.2',
      '0.2.1-alpha.6',
      '0.2.1-rc.4',
      'unknown',
      `dsh ${version}`,
    ])
      expect(await adapter.probe(candidate(other))).toBeUndefined()
    expect(await adapter.probeCompatibility()).toBeUndefined()
    expect(fixture.methods.length).toBe(count)
    await fixture.close()
    expect(new Alpha212VersionAdapter(transportOptions(globalThis.fetch)).supportedVersion).toBe(
      '0.2.1-alpha.2',
    )
  })
})
