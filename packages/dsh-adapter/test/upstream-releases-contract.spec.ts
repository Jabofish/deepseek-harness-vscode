import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Alpha222VersionAdapter } from '../src/versions/alpha222/adapter.js'
import { Rc214VersionAdapter } from '../src/versions/rc214/adapter.js'
import {
  candidate,
  endpoint,
  transportOptions,
  wrappedResponse,
  bodyText,
} from './support/contract-harness.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import { namedBlank } from './fixtures/rc214-contract.js'

describe.each([
  { AdapterBase: Rc214VersionAdapter, version: '0.2.1-rc.4', protocol: 'rc214' },
  { AdapterBase: Alpha222VersionAdapter, version: '0.2.2-alpha.2', protocol: 'alpha222' },
])('published upstream $version', ({ AdapterBase, version: release, protocol }) => {
  it('admits the release independently, rejects adjacent versions and closes every probe transport', async () => {
    const fixture = new ProbeFixtureTransport()
    class Adapter extends AdapterBase {
      public override createTransport(): DshTransport {
        return fixture
      }
    }
    const adapter = new Adapter(transportOptions(globalThis.fetch))
    expect(await adapter.probe(candidate(release))).toMatchObject({
      adapterId: `dsh-${release}`,
      protocolVersion: protocol,
      blankSessionReuse: true,
    })
    expect(fixture.closeCalls).toBe(1)
    for (const version of [
      '0.2.1-rc.3',
      release === '0.2.1-rc.4' ? '0.2.2-alpha.2' : '0.2.1-rc.4',
      `${release}+unverified`,
    ])
      expect(await adapter.probe(candidate(version))).toBeUndefined()
    expect(await adapter.probeCompatibility()).toBeUndefined()
    expect(fixture.closeCalls).toBe(1)
  })

  it.each(['malformed', 'business-error', 'protocol-error', 'timeout'] as const)(
    'rejects %s probe replies and releases the transport',
    async (mode) => {
      const fixture = new ProbeFixtureTransport(mode)
      class Adapter extends AdapterBase {
        public override createTransport(): DshTransport {
          return fixture
        }
      }
      const adapter = new Adapter(transportOptions(globalThis.fetch))
      expect(await adapter.probe(candidate(release))).toBeUndefined()
      expect(fixture.closeCalls).toBe(1)
    },
  )

  it('propagates cancellation and closes the probe transport', async () => {
    const fixture = new ProbeFixtureTransport()
    class Adapter extends AdapterBase {
      public override createTransport(): DshTransport {
        return fixture
      }
    }
    const abort = new AbortController()
    abort.abort()
    await expect(
      new Adapter(transportOptions(globalThis.fetch)).probe(candidate(release), abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.closeCalls).toBe(1)
  })

  it('retains the audited named-blank request on the exact release', async () => {
    const requests: unknown[] = []
    const transport = new AdapterBase(
      transportOptions((_input, init) => {
        requests.push(JSON.parse(bodyText(init)))
        return Promise.resolve(wrappedResponse(init, { sessionId: namedBlank.sessionId }))
      }),
    ).createTransport(endpoint)
    try {
      await expect(callRpc(transport, 'session.create', namedBlank)).resolves.toMatchObject({
        sessionId: namedBlank.sessionId,
      })
      expect(requests).toMatchObject([
        { method: 'session/create', payload: { args: { request: namedBlank } } },
      ])
    } finally {
      await transport.close()
    }
  })
})
