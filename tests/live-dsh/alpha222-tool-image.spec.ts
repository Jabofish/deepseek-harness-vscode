import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { AlphaLoopbackApiClient } from '../../packages/dsh-adapter/src/versions/alpha/transport.js'
import { unwrapRpcResultValue } from '../../packages/dsh-adapter/src/versions/rc6/rpc.js'
import { imageData } from '../../packages/dsh-adapter/test/fixtures/alpha222-contract.js'
import { canConnect, startManagedRuntime } from './harness.js'

const enabled = process.env.DSH_LIVE_SMOKE === '1' && process.env.DSH_LIVE_RUNTIME_VERSION === '0.2.2-alpha.2'

/** Test-only producer: the native store and Session.append own bytes and log authority. */
function probeSource(moduleUrl: (name: string) => string): string {
  return `
import { TypertRemoteService } from ${moduleUrl('@deepseek-ai/dsh-typert-protocol')}
import { createToolResultMessage } from ${moduleUrl('@deepseek-ai/dsh-llm')}
import { z } from ${moduleUrl('zod')}
export const inject = ['typert', 'attachments', 'agents']
export function apply(ctx) {
  class Probe extends TypertRemoteService {
    constructor(ctx) { super(ctx, 'toolImageProbe') }
    async seed(request) {
      const agent = ctx.agents.get(request.sessionId) ?? (await ctx.agents.resume({resumeSessionId:request.sessionId})).agent
      const session = agent.session
      const attachment = await ctx.attachments.saveImage({data:Buffer.from(${JSON.stringify(imageData)},'base64'),mediaType:'image/png',name:'tool-result.png'})
      session.append('request/header',{header:{config:{provider:'fixture',model:'fixture'},tools:[{name:'fixture_image',parameters:{type:'object',properties:{}}}]},reason:'initial'})
      const call = session.append('tool/call',{turn:0,step:0,callId:'fixture-image-call',name:'fixture_image',arguments:'{}'})
      session.append('tool/result',{turn:0,step:0,message:createToolResultMessage({callId:'fixture-image-call',isError:false,content:[{type:'image',attachment}]})},{surfaceOp:'append',sourceEventSeqs:[call.seq]})
      return {attachmentId:attachment.attachmentId}
    }
  }
  new Probe(ctx)
  ctx.typert.register({package:'tool-image-live-probe',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:[{
    id:'tool-image-live-probe#seed',service:'toolImageProbe',namespace:'toolImageProbe',method:'seed',invocation:{kind:'direct'},
    parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'strict',typeSymbol:'Request',create:()=>z.object({sessionId:z.string()})}}],
    result:{mode:'strict',typeSymbol:'Result',create:()=>z.object({attachmentId:z.string()})}
  }]})
}
`
}

describe.skipIf(!enabled)('native alpha222 tool-result image ownership', () => {
  it('reads an image present only in a tool result and refuses the same ID in another session', async () => {
    const executable = process.env.DSH_LIVE_RUNTIME
    if (executable === undefined) throw new Error('Select the exact alpha222 CLI entry for this probe.')
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-tool-image-'))
    let runtime: Awaited<ReturnType<typeof startManagedRuntime>> | undefined
    let transport: AlphaLoopbackApiClient | undefined
    try {
      const runtimeRequire = createRequire(path.join(path.dirname(path.dirname(executable)), 'package.json'))
      const plugin = path.join(home, 'tool-image-probe.mjs')
      const patchFile = path.join(home, 'tool-image.patch.yml')
      await writeFile(
        plugin,
        probeSource((name) => JSON.stringify(pathToFileURL(runtimeRequire.resolve(name)).href)),
      )
      await writeFile(
        patchFile,
        `- insert:\n    - id: tool-image-live-probe\n      name: ${JSON.stringify(plugin.replaceAll('\\', '/'))}\n`,
      )
      runtime = await startManagedRuntime({ dshHome: home, patchFile })
      const { backend } = runtime
      const workspace = await backend.workspaces.create({
        name: 'Tool image ownership',
        path: runtime.snapshot.workspace,
      })
      const input = {
        workspaceId: workspace.id,
        configuration: {
          preset: '',
          toolMode: 'native' as const,
          permissionPreset: '',
          planMode: false,
          model: { providerId: '', modelId: '' },
        },
      }
      const owner = await backend.sessions.create(input)
      const other = await backend.sessions.create(input)
      expect(other.id).not.toBe(owner.id)
      if (runtime.launchUrl === undefined) throw new Error('Missing isolated runtime login URL.')
      const login = await fetch(runtime.launchUrl, { redirect: 'manual' })
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .find((value) => value?.includes('='))
      transport = new AlphaLoopbackApiClient({
        endpoint: backend.connection.endpoint,
        fetch: globalThis.fetch,
        authCookie: () => cookie,
        requestTimeoutMs: 10_000,
        retryPolicy: { maximumAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
      })
      const receipt = unwrapRpcResultValue<{ attachmentId: string }>(
        await transport.remoteRequest('toolImageProbe/seed', { request: { sessionId: owner.id } }),
        'tool image fixture',
      )
      await vi.waitFor(
        async () => {
          const history = await backend.sessions.history(owner.id)
          expect(
            history.events.some(
              ({ event }) =>
                event.type === 'tool.updated' &&
                event.tool.images?.some((image) => image.attachmentId === receipt.attachmentId),
            ),
          ).toBe(true)
          expect(
            history.events.some(
              ({ event }) =>
                (event.type === 'message.user' || event.type === 'message.completed') &&
                event.images?.some((image) => image.attachmentId === receipt.attachmentId),
            ),
          ).toBe(false)
        },
        { timeout: 10_000 },
      )
      const image = await backend.sessions.readAttachment(owner.id, receipt.attachmentId)
      expect(image.uri).toBe(`data:image/png;base64,${imageData}`)
      await expect(backend.sessions.readAttachment(other.id, receipt.attachmentId)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      })
      console.info(
        '[dsh-live-tool-image] alpha222: native stored tool-only image read passed; other session denied; no model call',
      )
    } finally {
      try {
        await transport?.close()
      } finally {
        if (runtime !== undefined) {
          await runtime.stop()
          expect(await canConnect(runtime.snapshot.port)).toBe(false)
        }
        await rm(home, { recursive: true, force: true })
      }
    }
  }, 120_000)
})
