import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { LIVE_TIMEOUT_MS, startManagedRuntime, spawnManagedChild } from './harness.js'
import { AlphaLoopbackApiClient } from '../../packages/dsh-adapter/src/versions/alpha/transport.js'

const enabled = process.env.DSH_LIVE_SMOKE === '1' && process.env.DSH_LIVE_RUNTIME_VERSION === '0.2.1-rc.2'
describe.skipIf(!enabled)('DSH rc.2 editor companion (isolated real runtime)', () => {
  it(
    'loads the independently built plugin and enforces binding ownership through actual Remote',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-editor-bridge-'))
      let runtime: Awaited<ReturnType<typeof startManagedRuntime>> | undefined
      try {
        const patchFile = path.join(home, 'editor-bridge.patch.yml')
        const entry = fileURLToPath(
          new URL('../../packages/dsh-editor-bridge/dist/index.js', import.meta.url),
        )
        const probeFile = path.join(home, 'probe.mjs')
        const runtimeCommand = process.env.DSH_LIVE_RUNTIME
        if (runtimeCommand === undefined)
          throw new Error('Select the exact runtime executable for the probe.')
        const runtimeRequire = createRequire(
          path.join(path.dirname(path.dirname(runtimeCommand)), 'package.json'),
        )
        const moduleUrl = (name: string): string =>
          JSON.stringify(pathToFileURL(runtimeRequire.resolve(name)).href)
        await writeFile(
          probeFile,
          `
import { TypertRemoteService } from ${moduleUrl('@deepseek-ai/dsh-typert-protocol')}
import { z } from ${moduleUrl('zod')}
import { scopeOf } from ${moduleUrl('@deepseek-ai/dsh-scope')}
export const inject = ['typert', 'tools', 'agents', 'sessionPersistence']
export function apply(ctx) {
  class Probe extends TypertRemoteService {
    constructor(ctx) { super(ctx, 'editorBridgeProbe') }
    async invoke(request, signal) {
      const agent = ctx.agents.get(request.sessionId) ?? (await ctx.agents.resume({ resumeSessionId: request.sessionId })).agent
      if (!ctx.tools.schemas(scopeOf(agent)).some(tool => tool.name === 'vscode_get_editor_state')) return { ok: false, reason: 'not-catalogued' }
      const result = await ctx.tools.execute({ name: 'vscode_get_editor_state', arguments: {}, callId: 'fixture-editor-call', agent, signal })
      return result.isError ? { ok: false, reason: result.error.code } : { ok: true, snapshot: result.value }
    }
  }
  new Probe(ctx)
  ctx.typert.register({ package: 'editor-bridge-live-probe', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{
    id: 'editor-bridge-live-probe#invoke', service: 'editorBridgeProbe', namespace: 'editorBridgeProbe', method: 'invoke', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'Request', create: () => z.strictObject({ sessionId: z.string() }) } }],
    cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: 'Result', create: () => z.union([z.strictObject({ ok: z.literal(true), snapshot: z.record(z.string(), z.unknown()) }), z.strictObject({ ok: z.literal(false), reason: z.string() })]) }
  }] })
}
`,
        )
        const bundle = process.env.DSH_EDITOR_BRIDGE_BUNDLE
        if (bundle !== undefined) {
          let installer = runtimeCommand
          const pnpmEntry = process.env.DSH_EDITOR_BRIDGE_PNPM
          if (pnpmEntry !== undefined) {
            installer = path.join(home, 'install-cli.mjs')
            await writeFile(
              installer,
              `import { runCli } from ${moduleUrl('@deepseek-ai/dsh/lib/bin.js')}; await runCli({ packageManager: { command: process.execPath, args: [${JSON.stringify(pnpmEntry)}] } });`,
            )
          }
          const install = spawnManagedChild(
            installer,
            [
              'plugin',
              '--profile',
              'web',
              'add',
              bundle,
              '--ignore-scripts',
              '--fetch-retries=0',
              '--fetch-timeout=10000',
            ],
            home,
            { DSH_HOME: home },
          )
          const drain = async (stream: AsyncIterable<string>): Promise<string> => {
            let output = ''
            for await (const chunk of stream) output = (output + chunk).slice(-3000)
            return output
          }
          const timer = setTimeout(() => install.kill(), 60_000)
          try {
            const [result, stdout, stderr] = await Promise.all([
              install.exited,
              drain(install.stdout),
              drain(install.stderr),
            ])
            expect(result.code, `install packed bundle in the test-owned profile: ${stdout} ${stderr}`).toBe(
              0,
            )
          } finally {
            clearTimeout(timer)
          }
        }
        const bridgeEntry =
          bundle === undefined
            ? `    - id: live-editor-bridge\n      name: ${JSON.stringify(entry.replaceAll('\\', '/'))}\n`
            : ''
        await writeFile(
          patchFile,
          `- insert:\n${bridgeEntry}    - id: live-editor-probe\n      name: ${JSON.stringify(probeFile.replaceAll('\\', '/'))}\n`,
        )
        runtime = await startManagedRuntime({ dshHome: home, patchFile })
        const { backend } = runtime
        const repository = backend.editorBridge
        if (repository === undefined) throw new Error('The exact adapter did not expose the companion port.')
        const workspace = await backend.workspaces.create({
          name: 'Editor bridge fixture',
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
        const binding = await repository.attach(session.id, randomUUID())
        expect(binding.protocolVersion).toBe(1)
        await expect(repository.attach(session.id, randomUUID())).rejects.toMatchObject({
          code: 'BACKEND_BUSY',
        })
        expect(await repository.poll(binding.bindingId)).toEqual({ kind: 'idle' })
        if (runtime.launchUrl === undefined) throw new Error('Missing test-owned login URL.')
        const login = await fetch(runtime.launchUrl, { redirect: 'manual' })
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .find((value) => value !== undefined && value.includes('='))
        if (cookie === undefined) throw new Error('The test-owned client could not authenticate.')
        const transport = new AlphaLoopbackApiClient({
          endpoint: backend.connection.endpoint,
          fetch: globalThis.fetch,
          requestTimeoutMs: 10_000,
          retryPolicy: { maximumAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
          authCookie: () => cookie,
        })
        try {
          const toolResult = transport
            .remoteRequest<unknown>('editorBridgeProbe/invoke', { request: { sessionId: session.id } })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            )
          let request = await repository.poll(binding.bindingId)
          for (let attempt = 0; request.kind === 'idle' && attempt < 5; attempt += 1)
            request = await repository.poll(binding.bindingId)
          if (request.kind !== 'request')
            throw new Error(
              `The registered tool did not request editor state: ${JSON.stringify(await toolResult)}`,
            )
          const snapshot = {
            relativePath: 'sample.ts',
            languageId: 'typescript',
            documentVersion: 2,
            dirty: true,
            selection: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            diagnostics: { errors: 1, warnings: 0 },
            capturedAt: new Date().toISOString(),
          }
          await repository.respond(binding.bindingId, request.requestId, { ok: true, snapshot })
          expect(await toolResult).toMatchObject({ value: { ok: true, value: { ok: true, snapshot } } })
        } finally {
          await transport.close()
        }
        const controller = new AbortController()
        const poll = expect(repository.poll(binding.bindingId, controller.signal)).rejects.toMatchObject({
          code: 'REQUEST_CANCELLED',
        })
        controller.abort()
        await poll
        await repository.detach(binding.bindingId)
        await expect(repository.poll(binding.bindingId)).rejects.toMatchObject({
          code: 'CAPABILITY_UNAVAILABLE',
        })
        console.log(
          '[dsh-live-editor-bridge] rc.2 plugin, actual Agent/tool execution pipeline, Remote round trip, binding conflict, cancellation and detach passed; no model invoked',
        )
      } finally {
        await runtime?.stop()
        await rm(home, { recursive: true, force: true })
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
