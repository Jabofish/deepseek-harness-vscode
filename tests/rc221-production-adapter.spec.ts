import { describe, expect, it } from 'vitest'
import { VersionedBackendFactory } from '../packages/dsh-adapter/src/backend-factory.js'
import { VersionedBackendProbe } from '../packages/dsh-adapter/src/probe.js'
import { createAdapterOptions } from '../apps/extension/src/backend/adapter-options.js'
import { createVersionAdapters } from '../apps/extension/src/backend/version-adapters.js'
import { rc221Task } from '../packages/dsh-adapter/test/fixtures/rc221-contract.js'
import {
  bodyText,
  candidate,
  wrappedResponse,
} from '../packages/dsh-adapter/test/support/contract-harness.js'
import { FakeWebSocket } from '../packages/dsh-adapter/test/support/fake-web-socket.js'

const exportFileSystem = {
  stat: () => Promise.reject(new Error('unused')),
  rename: () => Promise.reject(new Error('unused')),
  unlink: () => Promise.reject(new Error('unused')),
  writeFile: () => Promise.reject(new Error('unused')),
}

describe('rc221 production Adapter assembly', () => {
  it.each(['create', 'edit', 'run'] as const)(
    'selects rc221 through the production registry and never replays Schedule %s after a lost receipt',
    async (operation) => {
      const methods: string[] = []
      let catalogReads = 0
      const sockets: FakeWebSocket[] = []
      class WorkspaceSocket extends FakeWebSocket {
        public constructor(...args: ConstructorParameters<typeof FakeWebSocket>) {
          super(...args)
          sockets.push(this)
          queueMicrotask(() => this.open())
        }
        public override send(data: string): void {
          super.send(data)
          const frame = JSON.parse(data) as { type: string; streamId: string; endpoint: string }
          if (frame.type !== 'open') return
          methods.push(frame.endpoint)
          expect(frame.endpoint).toBe('workspace/follow')
          queueMicrotask(() =>
            this.message({
              type: 'item',
              streamId: frame.streamId,
              value: { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } },
            }),
          )
        }
      }
      const adapters = createVersionAdapters(
        createAdapterOptions({
          requestTimeoutMs: () => 1_000,
          fetch: (_input, init) => {
            const request = JSON.parse(bodyText(init)) as { method: string }
            methods.push(request.method)
            if (request.method === 'session/list')
              return Promise.resolve(wrappedResponse(init, { items: [] }))
            if (request.method === 'schedule/catalog' && ++catalogReads > 1)
              return Promise.resolve(wrappedResponse(init, [rc221Task]))
            return Promise.reject(new TypeError('Fixture connection lost after dispatch.'))
          },
          samePath: (left, right) => left === right,
          exportFileSystem,
          authCookie: () => undefined,
          webSocket: WorkspaceSocket,
        }),
      )
      const connected = await new VersionedBackendProbe(adapters).probe(candidate('0.2.2-rc.1'))
      expect(connected?.capabilities).toMatchObject({
        dshVersion: '0.2.2-rc.1',
        adapterId: 'dsh-0.2.2-rc.1',
        protocolVersion: 'rc221',
        compatibilityMode: 'exact',
      })
      if (connected === undefined) throw new Error('The production registry did not select rc221.')
      const backend = await new VersionedBackendFactory(adapters).connect(connected)
      try {
        const schedules = backend.schedules
        if (schedules?.create === undefined || schedules.run === undefined)
          throw new Error('The selected backend must expose native Schedule management.')
        expect(schedules.management).toBe('host')
        // Prove production retry settings are active for reads, then retain
        // exactly one write attempt when its response could have been lost.
        expect(await schedules.catalog()).toMatchObject([{ id: rc221Task.id }])
        expect(catalogReads).toBe(2)
        const write =
          operation === 'create'
            ? schedules.create({
                title: 'Review',
                prompt: 'Review fixture',
                timing: { kind: 'after', seconds: 300 },
                workingDirectory: '/fixture/workspace',
                targetMode: 'new_once',
              })
            : operation === 'edit'
              ? schedules.delete(undefined, rc221Task.id, undefined, rc221Task.updatedAt)
              : schedules.run(rc221Task.id)
        await expect(write).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
        expect(methods).toEqual([
          'session/list',
          'workspace/follow',
          'schedule/catalog',
          'schedule/catalog',
          `schedule/${operation}`,
        ])
      } finally {
        await backend.close()
        expect(sockets).toHaveLength(1)
        expect(sockets[0]?.closeCalls).toBe(1)
      }
    },
  )
})
