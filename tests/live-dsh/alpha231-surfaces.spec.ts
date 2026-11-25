import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import { AlphaLoopbackApiClient } from '../../packages/dsh-adapter/src/versions/alpha/transport.js'
import { unwrapRpcResultValue } from '../../packages/dsh-adapter/src/versions/rc6/rpc.js'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime, runtimePackageRoot } from './harness.js'

const version = process.env.DSH_LIVE_RUNTIME_VERSION ?? ''
const enabled = process.env.DSH_LIVE_SMOKE === '1' && ['0.2.3-alpha.1', '0.2.3-alpha.2'].includes(version)

/** Use the pinned Host directory service to write the new event without running a model. */
function directoryProbe(moduleUrl: (name: string) => string): string {
  return `
import { TypertRemoteService } from ${moduleUrl('@deepseek-ai/dsh-typert-protocol')}
import { z } from ${moduleUrl('zod')}
export const inject = ['typert', 'agents', 'workingDirectory']
export function apply(ctx) {
  class Probe extends TypertRemoteService {
    constructor(ctx) { super(ctx, 'directoryProbe') }
    async move(request, signal) {
      const agent = ctx.agents.get(request.sessionId) ?? (await ctx.agents.resume({ resumeSessionId: request.sessionId })).agent
      const legacy = agent.session.append('working-directory/change', { cwd: request.legacy }).seq
      await ctx.workingDirectory.set(agent, request.target, signal)
      const current = agent.session.ownEvents().findLast(event => event.type === 'workspace-root/change')?.seq
      return { legacy, current }
    }
  }
  new Probe(ctx)
  ctx.typert.register({ package: 'directory-live-probe', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{
    id: 'directory-live-probe#move', service: 'directoryProbe', namespace: 'directoryProbe', method: 'move', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'Request', create: () => z.strictObject({ sessionId: z.string(), legacy: z.string(), target: z.string() }) } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'Result', create: () => z.strictObject({ legacy: z.number().int(), current: z.number().int() }) }
  }] })
}
`
}

describe.skipIf(!enabled)('native Host working directory', () => {
  it(
    'follows and rereads Host moves while ignoring old model directory records',
    async () => {
      const executable = process.env.DSH_LIVE_RUNTIME
      if (executable === undefined) throw new Error('Select the exact DSH 0.2.3 Alpha CLI entry.')
      const runtimeRequire = createRequire(path.join(runtimePackageRoot(executable), 'package.json'))
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-alpha231-'))
      let runtime: Awaited<ReturnType<typeof startManagedRuntime>> | undefined
      let transport: AlphaLoopbackApiClient | undefined
      let unsubscribe: (() => void) | undefined
      try {
        const plugin = path.join(home, 'directory-probe.mjs')
        const patchFile = path.join(home, 'directory.patch.yml')
        await writeFile(
          plugin,
          directoryProbe((name) => JSON.stringify(pathToFileURL(runtimeRequire.resolve(name)).href)),
        )
        await writeFile(
          patchFile,
          `- insert:\n    - id: directory-live-probe\n      name: ${JSON.stringify(plugin.replaceAll('\\', '/'))}\n`,
        )
        runtime = await startManagedRuntime({ dshHome: home, patchFile, removeDshHomeOnStop: true })
        const { backend } = runtime
        const cwd = runtime.snapshot.workspace
        const legacy = path.join(cwd, 'legacy')
        const target = path.join(cwd, 'new-root')
        await Promise.all([mkdir(legacy), mkdir(target)])
        const root = await realpath(target)
        const workspace = await backend.workspaces.create({ name: 'Directory fixture', path: cwd })
        const session = await backend.sessions.create({
          workspaceId: workspace.id,
          configuration: {
            preset: '',
            toolMode: 'native',
            permissionPreset: '',
            planMode: false,
            model: { providerId: '', modelId: '' },
          },
        })
        const events: BackendEvent[] = []
        unsubscribe = backend.events.subscribe((event) => events.push(event))
        backend.events.watchSession?.(session.id)
        await vi.waitFor(
          () =>
            expect(events).toContainEqual(
              expect.objectContaining({ type: 'session.subscribed', sessionId: session.id }),
            ),
          { timeout: 15_000 },
        )
        if (runtime.launchUrl === undefined) throw new Error('Missing isolated runtime login URL.')
        const login = await fetch(runtime.launchUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .find((value) => value?.includes('='))
        if (cookie === undefined) throw new Error('The isolated login returned no credential.')
        transport = new AlphaLoopbackApiClient({
          endpoint: backend.connection.endpoint,
          fetch: globalThis.fetch,
          authCookie: () => cookie,
          requestTimeoutMs: 10_000,
          retryPolicy: { maximumAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
        })
        const receipt = unwrapRpcResultValue<{ legacy: number; current: number }>(
          await transport.remoteRequest('directoryProbe/move', {
            request: { sessionId: session.id, legacy, target },
          }),
          'native directory move',
        )
        const projection = {
          type: 'session.projection',
          sessionId: session.id,
          key: 'workingDirectory',
          value: root,
          sequence: receipt.current,
        }
        await vi.waitFor(() => expect(events).toContainEqual(projection), { timeout: 10_000 })
        expect(events).not.toContainEqual(
          expect.objectContaining({
            type: 'session.projection',
            key: 'workingDirectory',
            sequence: receipt.legacy,
          }),
        )
        const history = await backend.sessions.history(session.id)
        expect(history.events.find(({ sequence }) => sequence === receipt.current)?.event).toEqual(projection)
        expect(history.events.find(({ sequence }) => sequence === receipt.legacy)?.event.type).not.toBe(
          'session.projection',
        )
      } finally {
        unsubscribe?.()
        try {
          await transport?.close()
        } finally {
          if (runtime !== undefined) {
            await runtime.stop()
            expect(await canConnect(runtime.snapshot.port)).toBe(false)
          }
        }
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
