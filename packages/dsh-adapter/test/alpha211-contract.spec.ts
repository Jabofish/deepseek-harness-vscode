import { describe, expect, it } from 'vitest'
import type { BackendEndpoint } from '@dsh-vscode/domain'

import { VersionedBackendFactory } from '../src/backend-factory.js'
import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Alpha211VersionAdapter } from '../src/versions/alpha211/adapter.js'
import { Alpha211ScheduleRepository } from '../src/versions/alpha211/schedule-repository.js'
import { Alpha211AccountLifecycleRepository } from '../src/versions/alpha211/account-repository.js'
import { Alpha211PluginBundleRepository } from '../src/versions/alpha211/plugin-manager-repository.js'
import { Rc202VersionAdapter } from '../src/versions/rc202/adapter.js'
import { Rc202UserQuestionRepository } from '../src/versions/rc202/user-question-repository.js'
import { candidate, transportOptions } from './support/contract-harness.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'

/** dsh-v0.2.1-alpha.1 / 5badb15009ae1756c3afe0ae0cef1faafc290ccc:
 * Session/Workspace probe types remain the rc202 contracts, independently audited
 * at packages/api/{session,workspace}-controller/src/{types.ts,index.ts}.
 */
const version = '0.2.1-alpha.1'
const options = transportOptions(globalThis.fetch)

class FixtureAdapter extends Alpha211VersionAdapter {
  public constructor(private readonly fixture: DshTransport) {
    super(options)
  }

  public override createTransport(_endpoint: BackendEndpoint): DshTransport {
    return this.fixture
  }
}

describe('DSH 0.2.1-alpha.1 exact adapter', () => {
  it('selects the new identity and assembles version-local ports plus retained timed questions', async () => {
    const fixture = new ProbeFixtureTransport()
    const adapters = [new FixtureAdapter(fixture), new Rc202VersionAdapter(options)]
    const connected = await new VersionedBackendProbe(adapters).probe(candidate(version))
    expect(connected?.capabilities).toMatchObject({
      dshVersion: version,
      protocolVersion: 'alpha211',
      adapterId: `dsh-${version}`,
      compatibilityMode: 'exact',
    })
    expect(fixture.methods).toEqual(['session.list', 'workspace.list'])
    expect(fixture.closeCalls).toBe(1)
    if (connected === undefined) throw new Error('exact alpha211 probe declined its fixture')
    const backend = await new VersionedBackendFactory(adapters).connect(connected)
    try {
      expect(backend.schedules).toBeInstanceOf(Alpha211ScheduleRepository)
      expect(backend.account).toBeInstanceOf(Alpha211AccountLifecycleRepository)
      expect(backend.pluginBundles).toBeInstanceOf(Alpha211PluginBundleRepository)
      expect(backend.userQuestions).toBeInstanceOf(Rc202UserQuestionRepository)
    } finally {
      await backend.close()
    }
  })

  it.each(['malformed', 'business-error', 'protocol-error', 'timeout'] as const)(
    'declines %s and closes the probe transport',
    async (mode) => {
      const fixture = new ProbeFixtureTransport(mode)
      await expect(new FixtureAdapter(fixture).probe(candidate(version))).resolves.toBeUndefined()
      expect(fixture.closeCalls).toBe(1)
    },
  )

  it('propagates cancellation and releases the owned probe', async () => {
    const fixture = new ProbeFixtureTransport()
    const controller = new AbortController()
    controller.abort()
    await expect(
      new FixtureAdapter(fixture).probe(candidate(version), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.closeCalls).toBe(1)
  })

  it('declines adjacent, malformed and unknown identities without touching the transport', async () => {
    const fixture = new ProbeFixtureTransport()
    const adapter = new FixtureAdapter(fixture)
    for (const label of ['0.2.0-rc.2', '0.2.1-alpha.2', `${version}+unverified`, `DSH ${version}`]) {
      await expect(adapter.probe(candidate(label))).resolves.toBeUndefined()
    }
    await expect(adapter.probeCompatibility()).resolves.toBeUndefined()
    expect(adapter.fallback).toBe(false)
    expect(fixture.methods).toEqual([])
    expect(fixture.closeCalls).toBe(0)
  })
})
