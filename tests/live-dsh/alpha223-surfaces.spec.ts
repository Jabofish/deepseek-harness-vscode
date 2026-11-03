import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { canConnect, LIVE_TIMEOUT_MS, startManagedRuntime } from './harness.js'
import { AlphaLoopbackApiClient } from '../../packages/dsh-adapter/src/versions/alpha/transport.js'
import { unwrapRpcResultValue } from '../../packages/dsh-adapter/src/versions/rc6/rpc.js'
import { scopedSchedule } from '../../apps/extension/src/schedules/schedule-scope.js'

/** Native delivery and persistence run normally; reject the Agent step before any model request. */
function deliveryProbe(moduleUrl: (name: string) => string): string {
  return `
import {TypertRemoteService} from ${moduleUrl('@deepseek-ai/dsh-typert-protocol')}
import {z} from ${moduleUrl('zod')}
export const inject = ['typert','agents']
export function apply(ctx) {
  let rejected = 0
  ctx.on('agent/pre-step', () => {rejected++; return {kind:'reject'}}, {global:true})
  class Probe extends TypertRemoteService {
    constructor(ctx) {super(ctx,'scheduleDeliveryProbe')}
    count() {return rejected}
    inspect(request) {
      const events = ctx.agents.get(request.sessionId)?.session.ownEvents() ?? []
      return {
        hasDelivery: events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === request.messageId)),
        modelRequests: events.filter(event => event.type === 'request/header').length,
      }
    }
  }
  new Probe(ctx)
  ctx.typert.register({package:'schedule-delivery-live-probe',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:[{
    id:'schedule-delivery-live-probe#count',service:'scheduleDeliveryProbe',namespace:'scheduleDeliveryProbe',method:'count',invocation:{kind:'direct'},parameters:[],
    result:{mode:'strict',typeSymbol:'Count',create:()=>z.number().int().nonnegative()}
  },{
    id:'schedule-delivery-live-probe#inspect',service:'scheduleDeliveryProbe',namespace:'scheduleDeliveryProbe',method:'inspect',invocation:{kind:'direct'},
    parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'strict',typeSymbol:'Request',create:()=>z.object({sessionId:z.string(),messageId:z.string()})}}],
    result:{mode:'strict',typeSymbol:'Receipt',create:()=>z.object({hasDelivery:z.boolean(),modelRequests:z.number().int().nonnegative()})}
  }]})
}
`
}

/** Exact published alpha.3, empty disposable home, future deliveries only; no model call. */
describe.skipIf(
  process.env.DSH_LIVE_SMOKE !== '1' || process.env.DSH_LIVE_RUNTIME_VERSION !== '0.2.2-alpha.3',
)('native alpha223 Host Schedule lifecycle', () => {
  it(
    'delivers native Run now into real new_once/new sessions, retains history and maps input refusals without a model',
    async () => {
      const executable = process.env.DSH_LIVE_RUNTIME
      if (executable === undefined) throw new Error('Select the exact alpha223 runtime.')
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-schedule-delivery-'))
      let runtime: Awaited<ReturnType<typeof startManagedRuntime>> | undefined
      let transport: AlphaLoopbackApiClient | undefined
      try {
        const runtimeRequire = createRequire(
          path.join(path.dirname(path.dirname(executable)), 'package.json'),
        )
        const plugin = path.join(home, 'delivery-probe.mjs')
        const patchFile = path.join(home, 'delivery.patch.yml')
        await writeFile(
          plugin,
          deliveryProbe((name) => JSON.stringify(pathToFileURL(runtimeRequire.resolve(name)).href)),
        )
        await writeFile(
          patchFile,
          `- insert:\n    - id: schedule-delivery-live-probe\n      name: ${JSON.stringify(plugin.replaceAll('\\', '/'))}\n`,
        )
        runtime = await startManagedRuntime({ dshHome: home, patchFile })
        const { backend } = runtime
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
        await backend.workspaces.create({
          name: 'Schedule delivery fixture',
          path: runtime.snapshot.workspace,
        })
        const schedules = backend.schedules
        if (schedules?.create === undefined || schedules.run === undefined)
          throw new Error('Native Schedule management is missing')
        const create = {
          title: 'Native delivery',
          prompt: 'Review the disposable fixture',
          timing: { kind: 'after' as const, seconds: 3600 },
          workingDirectory: runtime.snapshot.workspace,
          targetMode: 'new_once' as const,
        }
        await expect(
          schedules.create({ ...create, timing: { kind: 'at', at: '2000-01-01T00:00:00.000Z' } }),
        ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION', context: { scheduleReason: 'not_future' } })
        const sessions = new Set<string>()
        for (const targetMode of ['new_once', 'new'] as const) {
          const task = await schedules.create({ ...create, targetMode })
          expect(await schedules.run(task.id)).toEqual({ id: task.id, admitted: true })
          const updated = (await schedules.catalog()).find((item) => item.id === task.id)!
          expect(updated.lastDelivery?.targetSessionId).toBeDefined()
          const receipt = updated.lastDelivery!
          expect(sessions.has(receipt.targetSessionId!)).toBe(false)
          sessions.add(receipt.targetSessionId!)
          expect(updated.target?.kind).toBe(targetMode === 'new_once' ? 'session' : 'new')
          if (targetMode === 'new_once' && task.target?.kind === 'new_once')
            expect(receipt.targetSessionId).toBe(task.target.sessionId)
          expect(scopedSchedule(updated, await backend.workspaces.list())).toMatchObject({ id: task.id })
          expect(await schedules.history({ id: task.id, limit: 10 })).toMatchObject({
            id: task.id,
            records: [
              { messageId: receipt.messageId, targetSessionId: receipt.targetSessionId, prompt: task.prompt },
            ],
          })
          // Delivery persists Inbox insertion; a pre-step rejection intentionally
          // never admits it into the visible conversation or a model request.
          expect(
            unwrapRpcResultValue(
              await transport.remoteRequest('scheduleDeliveryProbe/inspect', {
                request: { sessionId: receipt.targetSessionId, messageId: receipt.messageId },
              }),
              'native delivery inspection',
            ),
          ).toEqual({ hasDelivery: true, modelRequests: 0 })
          await backend.sessions.history(receipt.targetSessionId!)
          expect(await schedules.run(task.id)).toEqual({
            id: task.id,
            admitted: false,
            code: 'schedule_execution_pending',
          })
          expect(
            await schedules.update({
              id: task.id,
              expected: updated,
              expectedUpdatedAt: updated.updatedAt ?? null,
              change: { kind: 'rrule', rrule: 'invalid rule' },
            }),
          ).toMatchObject({ code: 'invalid_rule' })
          await schedules.delete(undefined, task.id, undefined, updated.updatedAt ?? null)
        }
        await vi.waitFor(
          async () =>
            expect(
              unwrapRpcResultValue<number>(
                await transport!.remoteRequest('scheduleDeliveryProbe/count', {}),
                'delivery probe',
              ),
            ).toBeGreaterThanOrEqual(2),
          { timeout: 10_000 },
        )
        expect(await schedules.catalog()).toEqual([])
        console.log(
          '[native-alpha223] positive Run now/new_once transition/new delivery/actual Session persistence/history/input refusal passed; every Agent step rejected before model generation',
        )
      } finally {
        try {
          await transport?.close()
        } finally {
          if (runtime !== undefined) {
            await runtime.stop()
            expect(await canConnect(runtime.snapshot.port)).toBe(false)
          }
          assert.equal(path.dirname(home), os.tmpdir(), 'Unexpected Schedule fixture home.')
          await rm(home, { recursive: true, force: true })
        }
      }
    },
    LIVE_TIMEOUT_MS * 2,
  )
  it(
    'creates new targets, pauses atomically, rejects stale revisions, reads history and deletes without a model',
    async () => {
      const runtime = await startManagedRuntime()
      try {
        const { backend } = runtime
        expect(backend.connection.capabilities).toMatchObject({
          adapterId: 'dsh-0.2.2-alpha.3',
          protocolVersion: 'alpha223',
          compatibilityMode: 'exact',
        })
        const schedules = backend.schedules
        if (schedules?.create === undefined || schedules.run === undefined)
          throw new Error('Native Schedule management is missing')
        const created = await schedules.create({
          title: 'Fixture review',
          prompt: 'Review the disposable fixture project',
          timing: { kind: 'after', seconds: 3600 },
          targetMode: 'new_once',
          workingDirectory: runtime.snapshot.workspace,
        })
        expect(created).toMatchObject({
          kind: 'after',
          status: 'active',
          target: { kind: 'new_once' },
          targetWorkingDirectory: runtime.snapshot.workspace,
        })
        const result = await schedules.update({
          id: created.id,
          expected: created,
          expectedUpdatedAt: created.updatedAt ?? null,
          active: false,
        })
        expect(result).toMatchObject({ id: created.id, updated: true })
        const paused = (await schedules.catalog()).find((item) => item.id === created.id)!
        expect(paused.status).toBe('paused')
        expect(
          await schedules.update({
            id: created.id,
            expected: created,
            expectedUpdatedAt: created.updatedAt ?? null,
            title: 'Stale title',
          }),
        ).toMatchObject({ updated: false, code: 'schedule_conflict' })
        expect(await schedules.history({ id: created.id, limit: 10 })).toMatchObject({
          id: created.id,
          records: [],
        })
        expect(
          await schedules.delete(undefined, created.id, undefined, created.updatedAt ?? null),
        ).toMatchObject({ deleted: false, code: 'schedule_conflict' })
        expect(await schedules.delete(undefined, created.id, undefined, paused.updatedAt ?? null)).toEqual({
          id: created.id,
          deleted: true,
        })
        const recurring = await schedules.create({
          title: 'Fixture recurrence',
          prompt: 'Review later',
          timing: { kind: 'rrule', rrule: 'DTSTART:20991104T090000Z\nRRULE:FREQ=DAILY' },
          targetMode: 'new',
          workingDirectory: runtime.snapshot.workspace,
        })
        expect(recurring).toMatchObject({ kind: 'rrule', target: { kind: 'new' }, status: 'active' })
        expect(await schedules.run('missing-fixture-task')).toEqual({
          id: 'missing-fixture-task',
          admitted: false,
          code: 'schedule_not_found',
        })
        await schedules.delete(undefined, recurring.id, undefined, recurring.updatedAt ?? null)
        expect(await schedules.catalog()).toEqual([])
        await expect(schedules.catalog(AbortSignal.abort())).rejects.toMatchObject({
          code: 'REQUEST_CANCELLED',
        })
        console.log(
          '[native-alpha223] create/new_once/new/RRULE/pause/history/conflict/delete/cancel passed without a model request',
        )
      } finally {
        await runtime.stop()
        expect(await canConnect(runtime.snapshot.port)).toBe(false)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
