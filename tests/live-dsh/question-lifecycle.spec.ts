import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, UserQuestion } from '../../packages/domain/src/index.js'
import { AlphaLoopbackApiClient } from '../../packages/dsh-adapter/src/versions/alpha/transport.js'
import type { AlphaEventSource } from '../../packages/dsh-adapter/src/versions/alpha/events.js'
import { unwrapRpcResultValue } from '../../packages/dsh-adapter/src/versions/rc6/rpc.js'
import { redactText } from '../../packages/dsh-adapter/src/redaction.js'
import { canConnect, startManagedRuntime, spawnManagedChild } from './harness.js'

const version = process.env.DSH_LIVE_RUNTIME_VERSION ?? ''
const enabled = process.env.DSH_LIVE_SMOKE === '1' && ['0.2.1-alpha.2', '0.2.1-rc.3'].includes(version)

// Test-only Remote invokes the real question owner. Native Session.append records
// the caller's tool boundaries; the question service, Gateway, Inbox, driver and
// projections remain real. A pre-step gate allows deterministic admission/reject
// without a provider, model request, or a user's runtime/profile.
function probeSource(moduleUrl: (name: string) => string): string {
  return `
import { TypertRemoteService } from ${moduleUrl('@deepseek-ai/dsh-typert-protocol')}
import { createToolResultMessage, createUserMessage } from ${moduleUrl('@deepseek-ai/dsh-llm')}
import { z } from ${moduleUrl('zod')}
export const inject = ['typert', 'userQuestions', 'agents', 'sessionProjections']
export function apply(ctx) {
  const calls = new Map()
  const gates = new Map()
  ctx.on('agent/pre-step', ({ agent, messages, signal }) => new Promise(resolve => {
    const key = agent.session.id
    const finish = decision => { gates.delete(key); signal.removeEventListener('abort', abort); resolve(decision) }
    const abort = () => finish({kind:'reject'})
    gates.set(key, { messages, finish })
    signal.addEventListener('abort', abort, {once:true})
    if (signal.aborted) abort()
  }), {global:true})
  class Probe extends TypertRemoteService {
    constructor(ctx) { super(ctx, 'issue16Probe') }
    async invoke(request) {
      const agent = ctx.agents.get(request.sessionId) ?? (await ctx.agents.resume({resumeSessionId:request.sessionId})).agent
      const session = agent.session
      if (request.op === 'start') {
        const questions = [{id:'first',question:'First?',options:[{label:'One'},{label:'Two'}]}, {id:'second',question:'Second?'}]
        const callId = request.callId
        session.append('request/header', {header:{config:{provider:'fixture',model:'fixture'},tools:[{name:'ask_user_question',parameters:{type:'object',properties:{timeout:{type:'integer'}}}}]},reason:'initial'})
        const callSeq = session.append('tool/call', {turn:0,step:0,callId,name:'ask_user_question',arguments:JSON.stringify({questions,timeout:request.timeoutMs === undefined ? -1 : 1})}).seq
        const controller = new AbortController()
        const state = {done:false,controller}
        calls.set(callId,state)
        const pending = request.timeoutMs === undefined
          ? ctx.userQuestions.ask({agent,questions,signal:controller.signal,wait:{callId}})
          : ctx.userQuestions.askTimed({agent,questions,signal:controller.signal},callId,request.timeoutMs)
        void pending.then(value => {
          session.append('tool/result',{turn:0,step:0,message:createToolResultMessage({callId,isError:false,content:[{type:'text',text:JSON.stringify(value)}]})},{surfaceOp:'append',sourceEventSeqs:[callSeq]})
          state.done = true
        }, error => {
          session.append('tool/result',{turn:0,step:0,message:createToolResultMessage({callId,isError:true,content:[{type:'text',text:'fixture question cancelled'}]}),error:{code:error.code ?? 'ASK_ABORTED',message:'fixture question cancelled'}},{surfaceOp:'append',sourceEventSeqs:[callSeq]})
          state.done = true
        }).catch(error => { state.failure = String(error); state.done = true })
        return {started:true}
      }
      if (request.op === 'hold') {
        await agent.whenIdle()
        agent.steer(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'fixture pre-step gate'}]}))
        return {started:true}
      }
      if (request.op === 'decide') {
        const gate = gates.get(session.id)
        if (!gate) throw new Error('No claimed step')
        gate.finish(request.decision === 'reject' ? {kind:'reject'} : {kind:'enter',messages:request.decision === 'empty' ? [] : gate.messages})
        return {released:true}
      }
      if (request.op === 'discard') {
        for (const message of [...agent.inbox.nextTurn,...agent.inbox.nextStep])
          if (message.source.kind === 'user-question-reply') agent.inbox.remove(message.id)
        return {discarded:true}
      }
      if (request.op === 'cancel') { calls.get(request.callId)?.controller.abort(); return {cancelled:true} }
      if (request.op === 'status') return {
        gate:gates.has(session.id),
        claimedReply:gates.get(session.id)?.messages.some(message => message.source.kind === 'user-question-reply') ?? false,
        pending:agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
        done:calls.get(request.callId)?.done ?? false,
        failure:calls.get(request.callId)?.failure ?? null,
      }
      throw new Error('Unknown fixture operation')
    }
  }
  new Probe(ctx)
  ctx.typert.register({package:'issue16-live-probe',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:[{
    id:'issue16-live-probe#invoke',service:'issue16Probe',namespace:'issue16Probe',method:'invoke',invocation:{kind:'direct'},
    parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'strict',typeSymbol:'Request',create:()=>z.record(z.string(),z.unknown())}}],
    result:{mode:'strict',typeSymbol:'Result',create:()=>z.record(z.string(),z.unknown())}
  }]})
}
`
}

describe.skipIf(!enabled)('real DSH question lifecycle in an isolated profile', () => {
  it('accepts batches, cancels and expires waits, discards queued replies and observes real claim/admission', async () => {
    const executable = process.env.DSH_LIVE_RUNTIME
    if (executable === undefined) throw new Error('Select an exact DSH executable for the live probe.')
    const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-questions-'))
    let runtime: Awaited<ReturnType<typeof startManagedRuntime>> | undefined
    let transport: AlphaLoopbackApiClient | undefined
    let unsubscribe: (() => void) | undefined
    const diagnostics: string[] = []
    const observe = async function* (stream: AsyncIterable<string>): AsyncIterable<string> {
      for await (const chunk of stream) {
        for (const line of chunk.split('\n'))
          if (/Error|unhandled|question-probe\.mjs/.test(line)) {
            diagnostics.push(redactText(line, 500))
            if (diagnostics.length > 20) diagnostics.shift()
          }
        yield chunk
      }
    }
    try {
      const requireRuntime = createRequire(path.join(path.dirname(path.dirname(executable)), 'package.json'))
      const plugin = path.join(home, 'question-probe.mjs')
      const patchFile = path.join(home, 'questions.patch.yml')
      await writeFile(
        plugin,
        probeSource((name) => JSON.stringify(pathToFileURL(requireRuntime.resolve(name)).href)),
      )
      await writeFile(
        patchFile,
        `- insert:\n    - id: issue16-live-probe\n      name: ${JSON.stringify(plugin.replaceAll('\\', '/'))}\n`,
      )
      runtime = await startManagedRuntime({
        dshHome: home,
        patchFile,
        spawn: (file, args, cwd, environment) => {
          const child = spawnManagedChild(file, args, cwd, environment)
          return { ...child, stdout: observe(child.stdout), stderr: observe(child.stderr) }
        },
      })
      const { backend } = runtime
      expect(backend.connection.capabilities.dshVersion).toBe(version)
      const inventory = await backend.plugins.inventory()
      const probeEntry = inventory.entries.find(
        (entry) => entry.entryId === 'issue16-live-probe' || entry.moduleName.endsWith('/question-probe.mjs'),
      )
      expect(probeEntry, 'the test-only question probe must be in the effective profile').toBeDefined()
      expect(
        probeEntry?.fiberPhase,
        'the test-only probe must finish loading before invoking its Remote',
      ).toBe('active')
      const workspace = await backend.workspaces.create({
        name: 'Issue 16 isolated questions',
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
      const events: BackendEvent[] = []
      unsubscribe = backend.events.subscribe((event) => events.push(event))
      backend.events.watchSession?.(session.id)
      await vi.waitFor(
        () =>
          expect(
            events.some((event) => event.type === 'session.subscribed' && event.sessionId === session.id),
          ).toBe(true),
        { timeout: 15000 },
      )
      if (runtime.launchUrl === undefined) throw new Error('Missing isolated runtime login URL.')
      const login = await fetch(runtime.launchUrl, { redirect: 'manual' })
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .find((value) => value?.includes('='))
      if (cookie === undefined) throw new Error('The isolated probe could not authenticate.')
      transport = new AlphaLoopbackApiClient({
        endpoint: backend.connection.endpoint,
        fetch: globalThis.fetch,
        requestTimeoutMs: 10000,
        retryPolicy: { maximumAttempts: 1, baseDelayMs: 0, maximumDelayMs: 0 },
        authCookie: () => cookie,
      })
      const invoke = async (
        op: string,
        fields: Readonly<Record<string, unknown>> = {},
      ): Promise<Record<string, unknown>> =>
        unwrapRpcResultValue(
          await transport!.remoteRequest('issue16Probe/invoke', {
            request: { op, sessionId: session.id, ...fields },
          }),
          'fixture',
        )
      const pendingQuestion = (callId: string): UserQuestion | undefined =>
        events.findLast(
          (event): event is Extract<BackendEvent, { type: 'question.requested' }> =>
            event.type === 'question.requested' && event.question.callId === callId,
        )?.question
      const replyState = (callId: string): string | undefined =>
        events.findLast(
          (event): event is Extract<BackendEvent, { type: 'question.reply.status' }> =>
            event.type === 'question.reply.status' && event.callId === callId,
        )?.state
      const waitQuestion = async (callId: string): Promise<UserQuestion> => {
        await vi.waitFor(() => expect(pendingQuestion(callId)).toBeDefined(), { timeout: 10000 })
        return pendingQuestion(callId)!
      }
      const answers = [
        { id: 'first', response: ['One'] },
        { id: 'second', response: 'fixture answer' },
      ]
      const batchCall = randomUUID()
      await invoke('start', { callId: batchCall })
      const batch = await waitQuestion(batchCall)
      expect(batch.items).toHaveLength(2)
      // Inject one logical follow failure while the real $events waterfall is
      // pending. Its cached ownership and native answer must both survive.
      const afterQuestion = events.length
      const follow = vi
        .spyOn(AlphaLoopbackApiClient.prototype, 'openSessionStream')
        .mockImplementationOnce(async function* () {
          yield await Promise.reject(new Error('Fixture logical follow interruption'))
        })
      try {
        await (backend.events as AlphaEventSource).refreshSession(session.id)
        expect(follow.mock.calls[0]?.[0]).toBe(session.id)
        await vi.waitFor(
          () =>
            expect(
              events
                .slice(afterQuestion)
                .some((event) => event.type === 'notice' && event.sessionId === session.id),
            ).toBe(true),
          { timeout: 10000 },
        )
        expect(events.slice(afterQuestion).some((event) => event.type === 'connection.lost')).toBe(false)
        expect(
          backend.interactions.sessionForQuestion?.('second', { sessionId: session.id, rpcId: batch.rpcId! }),
        ).toBe(session.id)
        await backend.interactions.respondToQuestion('second', answers, undefined, {
          sessionId: session.id,
          rpcId: batch.rpcId!,
        })
      } finally {
        follow.mockRestore()
      }
      await vi.waitFor(async () => expect((await invoke('status', { callId: batchCall })).done).toBe(true))
      expect((await invoke('status', { callId: batchCall })).failure).toBeNull()
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'question.resolved',
          questionRpcId: batch.rpcId,
          settledCallId: batchCall,
          outcome: 'answered',
        }),
      )
      const cancelCall = randomUUID()
      await invoke('start', { callId: cancelCall })
      const cancel = await waitQuestion(cancelCall)
      await backend.interactions.cancelQuestion('first', undefined, {
        sessionId: session.id,
        rpcId: cancel.rpcId!,
      })
      await vi.waitFor(async () => expect((await invoke('status', { callId: cancelCall })).done).toBe(true))
      expect((await invoke('status', { callId: cancelCall })).failure).toBeNull()
      const waitCall = randomUUID()
      await invoke('start', { callId: waitCall, timeoutMs: 3000 })
      const timed = await waitQuestion(waitCall)
      expect(timed).toMatchObject({ timed: true, state: 'open' })
      const remaining = await backend.userQuestions!.attachWait(session.id, waitCall)
      expect(remaining).toBeGreaterThan(0)
      await sleep(3100)
      expect((await invoke('status', { callId: waitCall })).done).toBe(false)
      await backend.userQuestions!.releaseWait(session.id, waitCall)
      await vi.waitFor(async () => expect((await invoke('status', { callId: waitCall })).done).toBe(true), {
        timeout: 10000,
      })
      expect((await backend.sessions.history(session.id)).projection?.values.userQuestions).toHaveProperty(
        'active',
        expect.arrayContaining([expect.objectContaining({ callId: waitCall, state: 'continued' })]),
      )
      const lateCall = randomUUID()
      await invoke('start', { callId: lateCall, timeoutMs: 200 })
      await waitQuestion(lateCall)
      await vi.waitFor(async () => expect((await invoke('status', { callId: lateCall })).done).toBe(true), {
        timeout: 10000,
      })
      expect((await invoke('status', { callId: lateCall })).failure).toBeNull()
      await invoke('hold')
      await vi.waitFor(async () => expect((await invoke('status')).gate).toBe(true), { timeout: 10000 })
      const lateAnswer = {
        answers: [
          { id: 'first', selected: ['One'] },
          { id: 'second', selected: [], custom: 'late fixture answer' },
        ],
      }
      expect(await backend.userQuestions!.answer(session.id, lateCall, lateAnswer)).toBe(true)
      await vi.waitFor(() => expect(replyState(lateCall)).toBe('queued'), { timeout: 10000 })
      expect(await backend.userQuestions!.readReplyStatus!(session.id, lateCall)).toMatchObject({
        state: 'queued',
      })
      await invoke('discard')
      await vi.waitFor(() => expect(replyState(lateCall)).toBe('released'), { timeout: 10000 })
      expect(await backend.userQuestions!.readReplyStatus!(session.id, lateCall)).toMatchObject({
        state: 'released',
      })
      expect(await backend.userQuestions!.answer(session.id, lateCall, lateAnswer)).toBe(true)
      await invoke('decide', { decision: 'empty' })
      await vi.waitFor(async () => expect((await invoke('status')).gate).toBe(false))
      await invoke('hold')
      await vi.waitFor(async () => expect((await invoke('status')).claimedReply).toBe(true), {
        timeout: 10000,
      })
      await vi.waitFor(() => expect(replyState(lateCall)).toBe('claimed'), { timeout: 10000 })
      expect(await backend.userQuestions!.readReplyStatus!(session.id, lateCall)).toMatchObject({
        state: 'claimed',
      })
      const claimedStatus = await invoke('status')
      // Pinned Gateway rpcFailure only preserves marked RemoteError. The real
      // UserQuestionError extends HarnessError, so duplicate-reply refusal is
      // gateway/internal on these published versions, not REPLY_QUEUED wire.
      // Never infer acceptance from the diagnostic text or retry the write.
      await expect(backend.userQuestions!.answer(session.id, lateCall, lateAnswer)).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      })
      expect(await invoke('status')).toEqual(claimedStatus)
      await invoke('decide', { decision: 'reject' })
      await vi.waitFor(() => expect(replyState(lateCall)).toBe('released'), { timeout: 10000 })
      await invoke('hold')
      await vi.waitFor(async () => expect((await invoke('status')).gate).toBe(true), { timeout: 10000 })
      expect(await backend.userQuestions!.answer(session.id, lateCall, lateAnswer)).toBe(true)
      await invoke('decide', { decision: 'empty' })
      await invoke('hold')
      await vi.waitFor(async () => expect((await invoke('status')).claimedReply).toBe(true), {
        timeout: 10000,
      })
      await invoke('decide', { decision: 'admit' })
      await vi.waitFor(() => expect(replyState(lateCall)).toBe('admitted'), { timeout: 10000 })
      expect(await backend.userQuestions!.readReplyStatus!(session.id, lateCall)).toMatchObject({
        state: 'settled',
      })
      expect(await backend.userQuestions!.answer(session.id, lateCall, lateAnswer)).toBe(false)
      backend.events.unwatchSession?.(session.id)
      console.log(
        `[dsh-live-questions] ${version}: batch, cancel, timed claim/release, timeout/continued, queued discard/retry, claimed duplicate refusal, rejected-turn release/retry and real user-message admission passed`,
      )
    } catch (error) {
      if (diagnostics.length > 0) console.error('[dsh-live-questions] runtime errors', diagnostics)
      throw error
    } finally {
      unsubscribe?.()
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
  }, 120000)
})
