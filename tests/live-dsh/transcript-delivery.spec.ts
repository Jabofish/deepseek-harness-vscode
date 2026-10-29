import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { startManagedRuntime, canConnect } from './harness.js'
import { AlphaLoopbackApiClient } from '../../packages/dsh-adapter/src/versions/alpha/transport.js'
import { unwrapRpcResultValue } from '../../packages/dsh-adapter/src/versions/rc6/rpc.js'
import { TranscriptWindowService } from '../../apps/extension/src/view/transcript-window.js'
import type { BackendEvent } from '../../packages/domain/src/events.js'

const version = process.env.DSH_LIVE_RUNTIME_VERSION
const enabled = process.env.DSH_LIVE_SMOKE === '1' && version === '0.2.1-alpha.2'
const answer = 'Native delivery recovery fixture answer'

/** Test producer using Session.append at the pinned alpha212 commit
 * d743267388641bc76f17c45ce8b4c231aed1d32c, core/session/types.ts and
 * core/agent-loop/agent.ts. Real persistence, Remote and Adapter; no model call. */
function producer(moduleUrl: (name: string) => string): string {
  return `
import { TypertRemoteService } from ${moduleUrl('@deepseek-ai/dsh-typert-protocol')}
import { createAssistantMessage } from ${moduleUrl('@deepseek-ai/dsh-llm')}
import { z } from ${moduleUrl('zod')}
export const inject = ['typert', 'agents']
export function apply(ctx) {
  class Probe extends TypertRemoteService {
    constructor(ctx) { super(ctx, 'deliveryProbe') }
    async seed(request) {
      const agent = ctx.agents.get(request.sessionId) ?? (await ctx.agents.resume({resumeSessionId:request.sessionId})).agent
      const session = agent.session
      session.append('turn/start', {turn:1})
      session.append('step/start', {turn:1,step:1})
      session.append('request/header', {header:{config:{provider:'fixture',model:'fixture'}},reason:'initial'})
      session.append('assistant/message', {turn:1,step:1,message:createAssistantMessage({source:{provider:'fixture',model:'fixture'},content:[{type:'text',text:${JSON.stringify(answer)}}]}),stream:[]}, {surfaceOp:'append'})
      session.append('step/end', {turn:1,step:1})
      session.append('turn/end', {turn:1,reason:{kind:'completed'}})
      return {seeded:true}
    }
  }
  new Probe(ctx)
  ctx.typert.register({package:'delivery-live-probe',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:[{
    id:'delivery-live-probe#seed',service:'deliveryProbe',namespace:'deliveryProbe',method:'seed',invocation:{kind:'direct'},
    parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'strict',typeSymbol:'Request',create:()=>z.object({sessionId:z.string()})}}],
    result:{mode:'strict',typeSymbol:'Result',create:()=>z.object({seeded:z.boolean()})}
  }]})
}
`
}

describe.skipIf(!enabled)('native alpha212 transcript delivery recovery', () => {
  it('recovers the persisted reply after the renderer refuses the initial burst and invalidation', async () => {
    const executable = process.env.DSH_LIVE_RUNTIME
    if (executable === undefined) throw new Error('Select an exact package-local alpha212 CLI.')
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-delivery-'))
    const resolvedHome = path.resolve(home)
    if (
      path.dirname(resolvedHome) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolvedHome).startsWith('dsh-live-delivery-')
    )
      throw new Error('Unexpected disposable home path')
    let runtime: Awaited<ReturnType<typeof startManagedRuntime>> | undefined
    let transport: AlphaLoopbackApiClient | undefined
    let unsubscribe: (() => void) | undefined
    let host: TranscriptWindowService | undefined
    try {
      const requireRuntime = createRequire(path.join(path.dirname(path.dirname(executable)), 'package.json'))
      const plugin = path.join(home, 'delivery-probe.mjs')
      const patchFile = path.join(home, 'delivery.patch.yml')
      await writeFile(
        plugin,
        producer((name) => JSON.stringify(pathToFileURL(requireRuntime.resolve(name)).href)),
      )
      await writeFile(
        patchFile,
        `- insert:\n    - id: delivery-live-probe\n      name: ${JSON.stringify(plugin.replaceAll('\\', '/'))}\n`,
      )
      runtime = await startManagedRuntime({ dshHome: home, patchFile })
      const { backend } = runtime
      await vi.waitFor(
        async () =>
          expect(
            (await backend.plugins.inventory()).entries.find(
              (entry) =>
                entry.entryId === 'delivery-live-probe' || entry.moduleName.endsWith('/delivery-probe.mjs'),
            )?.fiberPhase,
          ).toBe('active'),
        { timeout: 10_000 },
      )
      const workspace = await backend.workspaces.create({
        name: 'Delivery fixture',
        path: runtime.snapshot.workspace,
      })
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
      if (runtime.launchUrl === undefined) throw new Error('Missing test-owned login URL')
      const login = await fetch(runtime.launchUrl, { redirect: 'manual' })
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .find((value) => value?.includes('='))
      if (cookie === undefined) throw new Error('Missing test-owned authentication cookie')
      transport = new AlphaLoopbackApiClient({
        endpoint: backend.connection.endpoint,
        fetch: globalThis.fetch,
        authCookie: () => cookie,
        requestTimeoutMs: 10_000,
        retryPolicy: { maximumAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
      })
      const events: BackendEvent[] = []
      let available = false
      let delivered = false
      let invalidations = 0
      const reports: { attempt: number; retrying: boolean }[] = []
      host = new TranscriptWindowService({
        read: (sessionId, before, signal) => backend.sessions.history(sessionId, before, signal),
        consumerDriven: true,
        publicValue: (value) => value,
        post: (window) => {
          if (!available) return Promise.resolve(false)
          delivered ||= window.nodes.some(
            (node) => node.kind === 'assistant-message' && node.markdown === answer,
          )
          host!.acknowledge(window.sessionId, window.revision)
          return Promise.resolve(true)
        },
        invalidate: () => {
          invalidations++
        }, // Same unavailable renderer drops the recovery notification.
        report: (report) => reports.push(report),
      })
      unsubscribe = backend.events.subscribe((event) => {
        events.push(event)
        host!.accept(event)
      })
      const page = await backend.sessions.history(session.id)
      const initial = host.installPage(session.id, page, host.begin(session.id))
      host.acknowledge(session.id, initial.revision)
      backend.events.watchSession?.(session.id)
      await vi.waitFor(() => expect(events.some((event) => event.type === 'session.subscribed')).toBe(true), {
        timeout: 10_000,
      })
      expect(
        unwrapRpcResultValue(
          await transport.remoteRequest('deliveryProbe/seed', { request: { sessionId: session.id } }),
          'delivery fixture',
        ),
      ).toEqual({ seeded: true })
      await vi.waitFor(
        () =>
          expect(
            events.some((event) => event.type === 'message.completed' && event.markdown === answer),
          ).toBe(true),
        { timeout: 15_000 },
      )
      await vi.waitFor(() => expect(reports.some((report) => !report.retrying)).toBe(true), {
        timeout: 10_000,
      })
      expect(invalidations).toBe(1)
      const persisted = await backend.sessions.history(session.id)
      expect(
        persisted.events.some(({ event }) => event.type === 'message.completed' && event.markdown === answer),
      ).toBe(true)
      // Outlast the initial 4.25-second recovery chain while also losing its
      // invalidation. The retained answer must still reach a healthy renderer.
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      available = true
      await vi.waitFor(() => expect(delivered).toBe(true), { timeout: 15_000 })
      console.info(
        `[dsh-live-delivery] ${version}: native append/persistence -> Adapter event -> Host retained reply -> recovered delivery passed; no model call`,
      )
    } finally {
      unsubscribe?.()
      host?.dispose()
      await transport?.close()
      if (runtime !== undefined) {
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
      }
      await rm(resolvedHome, { recursive: true, force: true })
    }
  }, 120_000)
})
