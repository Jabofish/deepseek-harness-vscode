import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { EditorCompanionService } from '../../packages/application/src/services/editor-companion-service.js'
import { verifyCompanionHost } from '../../apps/extension/src/editor/companion-host-proof.js'
import {
  EDITOR_COMPANION_TOOLS,
  EditorCompanionError,
  type EditorCompanionValue,
} from '../../packages/domain/src/editor-companion.js'
import { LIVE_TIMEOUT_MS, startManagedRuntime, spawnManagedChild } from './harness.js'
import { AlphaLoopbackApiClient } from '../../packages/dsh-adapter/src/versions/alpha/transport.js'

const version = process.env.DSH_LIVE_RUNTIME_VERSION ?? ''
const enabled = process.env.DSH_LIVE_SMOKE === '1' && process.env.DSH_LIVE_EDITOR_COMPANION === '1'
describe.skipIf(!enabled)('DSH published editor companion (isolated real runtime)', () => {
  it(
    'loads the independently built plugin and enforces binding ownership through actual Remote',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-editor-bridge-'))
      let runtime: Awaited<ReturnType<typeof startManagedRuntime>> | undefined
      try {
        const patchFile = path.join(home, 'editor-bridge.patch.yml')
        const probeFile = path.join(home, 'probe.mjs')
        const runtimeCommand = process.env.DSH_LIVE_RUNTIME
        if (runtimeCommand === undefined)
          throw new Error('Select the exact runtime executable for the probe.')
        let launchCommand = runtimeCommand
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
      const catalogue = ctx.tools.schemas(scopeOf(agent))
      if (!${JSON.stringify(Object.keys(EDITOR_COMPANION_TOOLS))}.every(name => catalogue.some(tool => tool.name === name))) return { ok: false, reason: 'not-catalogued' }
      // The pinned alpha release changes Registry execution to ordered batches.
      const result = ${JSON.stringify(version === '0.2.2-alpha.2')}
        ? (await ctx.tools.execute({ calls: [{type:'tool-call',id:'fixture-editor-call',name:request.name ?? 'vscode_get_editor_state',arguments:JSON.stringify(request.arguments ?? {})}],agent,signal })).results[0].result
        : await ctx.tools.execute({ name: request.name ?? 'vscode_get_editor_state', arguments: request.arguments ?? {}, callId: 'fixture-editor-call', agent, signal })
      return result.isError ? { ok: false, reason: result.error.code } : { ok: true, snapshot: result.value }
    }
  }
  new Probe(ctx)
  ctx.typert.register({ package: 'editor-bridge-live-probe', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{
    id: 'editor-bridge-live-probe#invoke', service: 'editorBridgeProbe', namespace: 'editorBridgeProbe', method: 'invoke', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'Request', create: () => z.strictObject({ sessionId: z.string(), name: z.string().optional(), arguments: z.record(z.string(), z.unknown()).optional() }) } }],
    cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: 'Result', create: () => z.union([z.strictObject({ ok: z.literal(true), snapshot: z.record(z.string(), z.unknown()) }), z.strictObject({ ok: z.literal(false), reason: z.string() })]) }
  }] })
}
`,
        )
        const bundle =
          process.env.DSH_EDITOR_BRIDGE_BUNDLE ??
          path.resolve('apps/extension/resources/editor-companion.tgz')
        if (bundle !== undefined) {
          let installer = runtimeCommand
          const pnpmEntry = process.env.DSH_EDITOR_BRIDGE_PNPM
          if (pnpmEntry !== undefined) {
            installer = path.join(home, 'install-cli.mjs')
            await writeFile(
              installer,
              `import { runCli } from ${moduleUrl('@deepseek-ai/dsh/lib/bin.js')}; await runCli({ packageManager: { command: process.execPath, args: [${JSON.stringify(pnpmEntry)}], env: { npm_config_offline: 'true' } } });`,
            )
            launchCommand = installer
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
          console.log(`[dsh-live-editor-bridge] ${version}: standard CLI installation passed`)
        }
        await writeFile(
          patchFile,
          `- insert:\n    - id: live-editor-probe\n      name: ${JSON.stringify(probeFile.replaceAll('\\', '/'))}\n`,
        )
        runtime = await startManagedRuntime({ dshHome: home, patchFile, requestedRuntime: launchCommand })
        const { backend } = runtime
        console.log(`[dsh-live-editor-bridge] ${version}: managed runtime connected`)
        const inventory = await backend.plugins.inventory()
        const editorEntry = inventory.entries.find(
          (entry) => entry.moduleName === '@dsh-vscode/editor-bridge',
        )
        expect(editorEntry?.meta?.title).toEqual({ en: 'VS Code Editor Companion', zh: 'VS Code 编辑器配套' })
        expect(editorEntry?.meta?.description).toMatchObject({
          en: expect.any(String) as unknown,
          zh: expect.any(String) as unknown,
        })
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
          await repository.detach(binding.bindingId)
          const companion = repository.companion
          if (companion === undefined) throw new Error('Missing negotiated companion repository.')
          expect(await companion.describe()).toMatchObject({
            protocolVersion: 2,
            packageVersion: '0.2.2',
            maxGrants: 16,
          })
          {
            const manifest = JSON.parse(
              await readFile(path.resolve('apps/extension/resources/editor-companion-build.json'), 'utf8'),
            ) as { buildId: string }
            expect(await companion.buildIdentity?.()).toBe(manifest.buildId)
          }
          await verifyCompanionHost(companion, new AbortController().signal)
          await expect(companion.verifyHost(randomUUID())).rejects.toMatchObject({
            code: 'CAPABILITY_UNAVAILABLE',
          })
          const service = new EditorCompanionService()
          let slowSignal: AbortSignal | undefined
          let calls = 0
          const document: EditorCompanionValue = {
            kind: 'document',
            relativePath: 'sample.ts',
            languageId: 'typescript',
            version: 3,
            dirty: true,
            range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
            text: 'const',
            truncated: false,
          }
          const editFile = path.join(home, 'edit-roundtrip.ts')
          await writeFile(editFile, 'const')
          const proposalId = randomUUID()
          let writes = 0
          const applied: EditorCompanionValue = {
            kind: 'proposal',
            proposalId,
            relativePath: 'sample.ts',
            version: 4,
            status: 'applied',
            saved: true,
          }
          try {
            const invoke = (
              name: string,
              args: Readonly<Record<string, unknown>>,
              signal?: AbortSignal,
            ): Promise<unknown> =>
              transport.remoteRequest(
                'editorBridgeProbe/invoke',
                { request: { sessionId: session.id, name, arguments: args } },
                signal,
              )
            const automaticFirstCall = invoke('vscode_read_document', { path: 'sample.ts' })
            await new Promise((resolve) => setTimeout(resolve, 100))
            await service.start(companion, session.id, randomUUID(), ['content', 'edit', 'navigation'], {
              execute: async (request, signal) => {
                calls += 1
                if (request.kind === 'propose') {
                  writes += 1
                  await writeFile(editFile, 'const changed')
                  return applied
                }
                if (request.kind === 'proposal') {
                  if (request.proposalId !== proposalId) throw new EditorCompanionError('not-found')
                  return applied
                }
                if (request.kind === 'open') return { kind: 'opened', relativePath: 'sample.ts' }
                if (request.kind === 'document' && request.path === 'slow.ts') {
                  slowSignal = signal
                  return new Promise<EditorCompanionValue>(() => undefined)
                }
                return Promise.resolve(document)
              },
            })
            expect(await automaticFirstCall).toMatchObject({
              ok: true,
              value: { ok: true, snapshot: document },
            })
            expect(await invoke('vscode_get_diagnostics', { path: 'sample.ts' })).toMatchObject({
              ok: true,
              value: { ok: false },
            })
            expect(calls).toBe(1)
            const cancelled = new AbortController()
            const pending = expect(
              invoke('vscode_read_document', { path: 'slow.ts' }, cancelled.signal),
            ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
            await vi.waitFor(() => expect(slowSignal).toBeDefined(), { timeout: 5_000 })
            cancelled.abort()
            await pending
            await vi.waitFor(() => expect(slowSignal?.aborted).toBe(true), { timeout: 5_000 })
            expect(await invoke('vscode_read_document', { path: 'sample.ts' })).toMatchObject({
              ok: true,
              value: { ok: true, snapshot: document },
            })
            expect(service.active).toBe(true)
            expect(
              await invoke('vscode_propose_edit', {
                path: 'sample.ts',
                expectedVersion: 3,
                edits: [
                  { range: { start: { line: 1, column: 6 }, end: { line: 1, column: 6 } }, text: ' changed' },
                ],
              }),
            ).toMatchObject({ value: { ok: true, snapshot: applied } })
            expect(await readFile(editFile, 'utf8')).toBe('const changed')
            expect(writes).toBe(1)
            expect(await invoke('vscode_get_edit_result', { proposalId })).toMatchObject({
              value: { ok: true, snapshot: applied },
            })
            expect(await invoke('vscode_get_edit_result', { proposalId: randomUUID() })).toMatchObject({
              value: { ok: false },
            })
            expect(await invoke('vscode_open_file', {})).toMatchObject({
              value: { ok: true, snapshot: { kind: 'opened', relativePath: 'sample.ts' } },
            })
            expect(service.active).toBe(true)
            const second = await backend.sessions.create({
              workspaceId: workspace.id,
              configuration: {
                preset: '',
                toolMode: 'native',
                permissionPreset: '',
                planMode: false,
                model: { providerId: '', modelId: '' },
              },
            })
            const otherBinding = await companion.attach(second.id, randomUUID(), [])
            await expect(companion.attach(session.id, randomUUID(), [])).rejects.toMatchObject({
              code: 'BACKEND_BUSY',
            })
            await companion.detach(otherBinding.bindingId)
          } finally {
            await service.stop()
          }
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
        if (bundle !== undefined) {
          console.log(`[dsh-live-editor-bridge] ${version}: authenticated editor tools passed`)
          const plugins = backend.pluginBundles
          if (plugins === undefined) throw new Error('Missing native bundle manager.')
          expect(
            (await plugins.listBundles()).find((item) => item.name === '@dsh-vscode/editor-bridge'),
          ).toMatchObject({ installed: true, version: '0.2.2' })
          expect(
            (await plugins.setBundleEnabled('@dsh-vscode/editor-bridge', false, AbortSignal.timeout(30_000)))
              .application,
          ).toMatch(/^(?:applied|restart-required)$/u)
          expect(
            (await plugins.setBundleEnabled('@dsh-vscode/editor-bridge', true, AbortSignal.timeout(30_000)))
              .application,
          ).toMatch(/^(?:applied|restart-required)$/u)
          const updatedBundle = path.join(home, 'companion-update.tgz')
          await copyFile(bundle, updatedBundle)
          const upgraded = await plugins.installBundle(
            updatedBundle,
            { requestId: randomUUID(), saveExact: true, approvedBuilds: [] },
            AbortSignal.timeout(60_000),
          )
          expect(upgraded.application, JSON.stringify(upgraded)).toMatch(/^(?:applied|restart-required)$/u)
          const removed = await plugins.removeBundle('@dsh-vscode/editor-bridge', AbortSignal.timeout(30_000))
          expect(removed.application, JSON.stringify(removed)).toMatch(/^(?:applied|restart-required)$/u)
          const installed = await plugins.installBundle(
            bundle,
            { requestId: randomUUID(), saveExact: true, approvedBuilds: [] },
            AbortSignal.timeout(60_000),
          )
          expect(installed.application, JSON.stringify(installed)).toMatch(/^(?:applied|restart-required)$/u)
          expect(
            (await plugins.listBundles()).find((item) => item.name === '@dsh-vscode/editor-bridge'),
          ).toMatchObject({ version: '0.2.2', installed: true })
          const cancelledBundle = path.join(home, 'companion-cancel.tgz')
          await copyFile(bundle, cancelledBundle)
          const cancelId = randomUUID()
          const cancelling = plugins.installBundle(
            cancelledBundle,
            { requestId: cancelId, saveExact: true, approvedBuilds: [] },
            AbortSignal.timeout(60_000),
          )
          // Give the real Remote time to register its request before cancelling it.
          await new Promise((resolve) => setTimeout(resolve, 500))
          expect(await plugins.cancelInstall(cancelId)).toMatchObject({ status: 'cancelled' })
          expect(await cancelling).toMatchObject({ application: 'cancelled' })
          expect(
            (await plugins.listBundles()).find((item) => item.name === '@dsh-vscode/editor-bridge'),
          ).toMatchObject({ installed: true, version: '0.2.2' })
        }
        console.log(
          `[dsh-live-editor-bridge] ${version} native metadata, CLI install, Remote update/remove/reinstall/cancel, Agent/tool execution, binding conflict and detach passed; no model invoked`,
        )
      } finally {
        await runtime?.stop()
        await rm(home, { recursive: true, force: true })
      }
    },
    Math.max(LIVE_TIMEOUT_MS, 180_000),
  )
})
