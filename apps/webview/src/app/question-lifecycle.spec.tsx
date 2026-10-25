// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  AppError,
  type BackendEvent,
  type InteractionRepository,
  type QuestionAnswer,
  type QuestionReplyStatus,
  type UserQuestion,
} from '@dsh-vscode/domain'
import type {
  FeatureHostMessage,
  FeatureRequest,
  HostMessage,
  WebviewRequest,
} from '@dsh-vscode/webview-protocol'
import { ProtocolClient } from './protocol-client.js'
import { createAppStore, type AppStore } from './store.js'
import { usePendingInteractions } from './usePendingInteractions.js'
import { translate } from '../i18n.js'

afterEach(cleanup)

const question = (overrides: Partial<UserQuestion> = {}): UserQuestion => ({
  id: 'first',
  rpcId: 'rpc-one',
  sessionId: 's1',
  prompt: 'First?',
  allowFreeText: true,
  items: [
    { id: 'first', prompt: 'First?', allowFreeText: true },
    { id: 'second', prompt: 'Second?', allowFreeText: true },
  ],
  ...overrides,
})
const answers: readonly QuestionAnswer[] = [
  { id: 'first', response: 'one' },
  { id: 'second', response: 'two' },
]

type ResponseSender = (rpcId: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>
interface Fixture {
  readonly stores: readonly AppStore[]
  readonly emit: (event: BackendEvent) => void
  readonly postEvent: (event: BackendEvent) => void
  readonly respondEnvelope: Mock<ResponseSender>
  readonly writes: readonly WebviewRequest[]
  readonly setAnswerLate: (respond: () => Promise<unknown>) => void
  readonly setReplyStatus: (read: () => Promise<unknown>) => void
  readonly dispose: () => void
}

async function fixture(): Promise<Fixture> {
  const { WebviewMessageRouter } = await vi.importActual<{
    WebviewMessageRouter: new (deps: {
      postMessage(message: HostMessage | FeatureHostMessage): Promise<boolean>
      handleRequest(request: WebviewRequest): Promise<unknown>
      handleFeatureRequest(request: FeatureRequest): Promise<unknown>
    }) => { handle(message: unknown, surfaceId: string): Promise<void>; cancelAll(): void }
  }>('../../../extension/src/view/message-router.js')
  const { Rc6InteractionRepository } = await vi.importActual<{
    Rc6InteractionRepository: new (
      transport: unknown,
      options: { onSettled(event: BackendEvent): void },
    ) => InteractionRepository & { remember(event: BackendEvent): void }
  }>('../../../../packages/dsh-adapter/src/repositories/interaction-repository.js')
  const { questionResponse } = await vi.importActual<{
    questionResponse(
      this: void,
      value: Extract<WebviewRequest, { type: 'interaction.question.respond' }>['payload']['response'],
    ): string | readonly string[] | readonly QuestionAnswer[]
  }>('../../../extension/src/composition/session-payload.js')
  let sequence = 0
  const postEvent = (event: BackendEvent): void => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          protocolVersion: 1,
          message: { type: 'event', name: event.type, sequence: ++sequence, payload: event },
        },
      }),
    )
  }
  const respondEnvelope = vi.fn<ResponseSender>().mockResolvedValue({ accepted: true })
  const repository = new Rc6InteractionRepository({ respondEnvelope }, { onSettled: postEvent })
  let answerLate: () => Promise<unknown> = () => Promise.resolve({ kind: 'question.answer', accepted: true })
  let nativeSequence = -1
  const nativeStatuses = new Map<string, QuestionReplyStatus>()
  let readReplyStatus: (() => Promise<unknown>) | undefined
  const writes: WebviewRequest[] = []
  const router = new WebviewMessageRouter({
    postMessage: (message) => {
      window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: 1, message } }))
      return Promise.resolve(true)
    },
    handleRequest: async (request) => {
      if (request.type === 'interaction.question.respond') {
        writes.push(request)
        await repository.respondToQuestion(
          request.payload.questionId,
          questionResponse(request.payload.response),
          undefined,
          request.payload.identity,
        )
      } else if (request.type === 'interaction.question.cancel') {
        writes.push(request)
        await repository.cancelQuestion(request.payload.questionId, undefined, request.payload.identity)
      }
      return []
    },
    handleFeatureRequest: (request) => {
      if (request.type === 'user-question.answer') {
        nativeStatuses.set(request.payload.callId, { state: 'queued', asOfSequence: ++nativeSequence })
        return answerLate()
      }
      if (request.type === 'user-question.reply.read')
        return (
          readReplyStatus?.() ??
          Promise.resolve({
            kind: 'question.reply',
            status: nativeStatuses.get(request.payload.callId) ?? {
              state: 'unknown',
              asOfSequence: nativeSequence,
            },
          })
        )
      return Promise.resolve({ kind: 'empty' })
    },
  })
  const stores = ['sidebar', 'editor'].map((surfaceId) =>
    createAppStore(
      new ProtocolClient({
        getState: () => undefined,
        setState: () => undefined,
        postMessage: (message) => {
          void router.handle(message, surfaceId)
        },
      }),
    ),
  )
  const emit = (event: BackendEvent): void => {
    if (event.sequence !== undefined) nativeSequence = Math.max(nativeSequence, event.sequence)
    if (event.type === 'question.reply.status') {
      nativeSequence = Math.max(nativeSequence, event.asOfSequence)
      if (event.asOfSequence >= (nativeStatuses.get(event.callId)?.asOfSequence ?? -1))
        nativeStatuses.set(event.callId, { state: event.state, asOfSequence: event.asOfSequence })
    }
    repository.remember(event)
    postEvent(event)
  }
  return {
    stores,
    emit,
    postEvent,
    respondEnvelope,
    writes,
    setAnswerLate: (respond: () => Promise<unknown>) => {
      answerLate = respond
    },
    setReplyStatus: (read) => {
      readReplyStatus = read
    },
    dispose: () => {
      for (const store of stores) store.dispose()
      router.cancelAll()
    },
  }
}

function useQuestions(store: AppStore, sessionId = 's1'): ReturnType<typeof usePendingInteractions> {
  const state = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
  )
  return usePendingInteractions({
    store,
    state,
    activeSessionId: sessionId,
    setRespondingInteractionId: () => undefined,
    setError: () => undefined,
    t: translate,
  })
}

describe('question lifecycle through the real Store, protocol, Host router and repository', () => {
  it('keeps an accepted write latched when its read fails and retries only the read on reconnect', async () => {
    const f = await fixture()
    const store = f.stores[0]!
    const write = vi.fn(() => Promise.resolve({ kind: 'question.answer', accepted: true }))
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('Read unavailable'))
      .mockResolvedValue({ kind: 'question.reply', status: { state: 'released', asOfSequence: 102 } })
    f.setAnswerLate(write)
    f.setReplyStatus(read)
    try {
      f.emit({
        type: 'session.projection',
        sessionId: 's1',
        key: 'userQuestions',
        value: {
          active: [{ callId: 'call-q', state: 'continued', questions: question().items }],
          settled: [],
        },
      })
      const hook = renderHook(() => useQuestions(store))
      await act(async () => {
        await hook.result.current.questionRespondFor(hook.result.current.pendingQuestions[0]!)(answers)
      })
      expect(hook.result.current.pendingQuestions[0]?.replyQueued).toBe(true)
      act(() =>
        f.emit({
          type: 'question.reply.status',
          sessionId: 's1',
          callId: 'call-q',
          state: 'released',
          asOfSequence: 100,
        }),
      )
      expect(hook.result.current.pendingQuestions[0]?.replyQueued).toBe(true)
      expect(read).toHaveBeenCalledTimes(1)
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              protocolVersion: 1,
              message: {
                type: 'event',
                name: 'connection.snapshot',
                sequence: 1000,
                payload: { kind: 'connected', backendInstanceId: 'same-host', connectionGeneration: 2 },
              },
            },
          }),
        )
      })
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(store.getState().queuedQuestionReplies).toEqual([]))
      expect(write).toHaveBeenCalledTimes(1)
      hook.unmount()
    } finally {
      f.dispose()
    }
  })
  it.each(['before-receipt', 'after-receipt'] as const)(
    'rejects a delayed pre-submission snapshot above the last client cut (%s)',
    async (order) => {
      const f = await fixture()
      const store = f.stores[0]!
      try {
        f.emit({
          type: 'session.projection',
          sessionId: 's1',
          key: 'userQuestions',
          sequence: 90,
          value: {
            active: [{ callId: 'call-q', state: 'continued', questions: question().items }],
            settled: [],
          },
        })
        f.emit({
          type: 'session.projection',
          sessionId: 's1',
          key: 'inbox',
          sequence: 90,
          value: { 'next-step': [], 'next-turn': [] },
        })
        f.setReplyStatus(() =>
          Promise.resolve({ kind: 'question.reply', status: { state: 'queued', asOfSequence: 101 } }),
        )
        let accept!: (value: unknown) => void
        if (order === 'before-receipt')
          f.setAnswerLate(
            () =>
              new Promise((resolve) => {
                accept = resolve
              }),
          )
        const hook = renderHook(() => useQuestions(store))
        let response!: Promise<void>
        act(() => {
          response = hook.result.current.questionRespondFor(hook.result.current.pendingQuestions[0]!)(answers)
        })
        const stale = (): void =>
          f.emit({
            type: 'question.reply.status',
            sessionId: 's1',
            callId: 'call-q',
            state: 'released',
            asOfSequence: 100,
          })
        if (order === 'before-receipt') {
          await vi.waitFor(() => expect(accept).toBeTypeOf('function'))
          act(stale)
          await act(async () => {
            accept({ kind: 'question.answer', accepted: true })
            await response
          })
        } else {
          await act(async () => {
            await response
          })
          act(stale)
        }
        expect(hook.result.current.pendingQuestions).toHaveLength(1)
        expect(hook.result.current.pendingQuestions[0]?.replyQueued).toBe(true)
        act(() =>
          f.emit({
            type: 'question.reply.status',
            sessionId: 's1',
            callId: 'call-q',
            state: 'released',
            asOfSequence: 102,
          }),
        )
        expect(hook.result.current.pendingQuestions[0]?.replyQueued).not.toBe(true)
        hook.unmount()
      } finally {
        f.dispose()
      }
    },
  )

  it.each(['snapshot', 'live'] as const)(
    'honors a real discard that overtakes the post-acceptance read (%s)',
    async (source) => {
      const f = await fixture()
      const store = f.stores[0]!
      try {
        f.emit({
          type: 'session.projection',
          sessionId: 's1',
          key: 'userQuestions',
          value: {
            active: [{ callId: 'call-q', state: 'continued', questions: question().items }],
            settled: [],
          },
        })
        let finish!: (value: unknown) => void
        f.setReplyStatus(
          () =>
            new Promise((resolve) => {
              finish = resolve
            }),
        )
        const hook = renderHook(() => useQuestions(store))
        let response!: Promise<void>
        act(() => {
          response = hook.result.current.questionRespondFor(hook.result.current.pendingQuestions[0]!)(answers)
        })
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
        if (source === 'live')
          act(() =>
            f.emit({
              type: 'question.reply.status',
              sessionId: 's1',
              callId: 'call-q',
              state: 'released',
              asOfSequence: 102,
            }),
          )
        await act(async () => {
          finish({
            kind: 'question.reply',
            status: {
              state: source === 'snapshot' ? 'released' : 'queued',
              asOfSequence: source === 'snapshot' ? 102 : 101,
            },
          })
          await response
        })
        expect(hook.result.current.pendingQuestions[0]?.replyQueued).not.toBe(true)
        hook.unmount()
      } finally {
        f.dispose()
      }
    },
  )
  it('does not unlock a newly accepted late reply from an older discard snapshot', async () => {
    const f = await fixture()
    const store = f.stores[0]!
    try {
      f.emit({
        type: 'session.projection',
        sessionId: 's1',
        key: 'userQuestions',
        sequence: 9,
        value: {
          active: [{ callId: 'call-q', state: 'continued', questions: question().items }],
          settled: [],
        },
      })
      f.emit({
        type: 'session.projection',
        sessionId: 's1',
        key: 'inbox',
        sequence: 10,
        value: { 'next-step': [], 'next-turn': [] },
      })
      const hook = renderHook(() => useQuestions(store))
      await act(async () => {
        await hook.result.current.questionRespondFor(hook.result.current.pendingQuestions[0]!)(answers)
      })
      act(() =>
        f.emit({
          type: 'question.reply.status',
          sessionId: 's1',
          callId: 'call-q',
          state: 'released',
          asOfSequence: 9,
        }),
      )
      expect(hook.result.current.pendingQuestions[0]?.replyQueued).toBe(true)
      act(() =>
        f.emit({
          type: 'question.reply.status',
          sessionId: 's1',
          callId: 'call-q',
          state: 'released',
          asOfSequence: 12,
        }),
      )
      expect(hook.result.current.pendingQuestions[0]?.replyQueued).not.toBe(true)
      hook.unmount()
    } finally {
      f.dispose()
    }
  })
  it('broadcasts explicit timed cancellation as a terminal call without confusing foreground timeout', async () => {
    const f = await fixture()
    try {
      const timed = question({ callId: 'call-cancel', timed: true, state: 'open' })
      f.emit({ type: 'question.requested', question: timed })
      await f.stores[0]!.cancelQuestion('first', { sessionId: 's1', rpcId: 'rpc-one' })
      f.emit({
        type: 'session.projection',
        sessionId: 's1',
        key: 'userQuestions',
        value: {
          active: [{ callId: 'call-cancel', state: 'continued', questions: timed.items }],
          settled: [],
        },
      })
      const hook = renderHook(() => useQuestions(f.stores[1]!))
      expect(hook.result.current.pendingQuestions).toEqual([])
      hook.unmount()
    } finally {
      f.dispose()
    }
  })
  it('routes reused item ids independently in separate sessions and windows', async () => {
    const f = await fixture()
    try {
      f.emit({ type: 'question.requested', question: question() })
      f.emit({ type: 'question.requested', question: question({ sessionId: 's2', rpcId: 'rpc-two' }) })
      await expect(f.stores[0]!.respondToQuestion('first', answers)).rejects.toMatchObject({
        code: 'STALE_INTERACTION',
      })
      expect(f.respondEnvelope).not.toHaveBeenCalled()
      await f.stores[0]!.respondToQuestion('first', answers, { sessionId: 's1', rpcId: 'rpc-one' })
      expect(f.stores[1]!.questions.map((value) => value.sessionId)).toEqual(['s2'])
      await f.stores[1]!.respondToQuestion('first', answers, { sessionId: 's2', rpcId: 'rpc-two' })
      expect(f.respondEnvelope.mock.calls.map((value) => value[0])).toEqual(['rpc-one', 'rpc-two'])
      expect(f.stores[0]!.questions).toEqual([])
    } finally {
      f.dispose()
    }
  })
  it('recovers a timed foreground timeout as continued without matching another call by item id', async () => {
    const f = await fixture()
    const store = f.stores[0]!
    try {
      f.emit({
        type: 'question.requested',
        question: question({ callId: 'foreground', timed: true, state: 'open' }),
      })
      expect(store.questions[0]).toMatchObject({ callId: 'foreground', timed: true, state: 'open' })
      const hook = renderHook((sessionId: string) => useQuestions(store, sessionId), { initialProps: 's1' })
      act(() => {
        f.emit({ type: 'question.resolved', sessionId: 's1', questionRpcId: 'rpc-one', outcome: 'cancelled' })
        f.emit({
          type: 'session.projection',
          sessionId: 's1',
          key: 'userQuestions',
          value: {
            active: [{ callId: 'foreground', state: 'continued', questions: question().items }],
            settled: [],
          },
        })
        f.emit({
          type: 'question.requested',
          question: question({ rpcId: 'rpc-other-call', callId: 'other-call' }),
        })
      })
      expect(hook.result.current.pendingQuestions.map((value) => [value.callId, value.state])).toEqual([
        ['other-call', undefined],
        ['foreground', 'continued'],
      ])
      hook.rerender('other-session')
      expect(hook.result.current.pendingQuestions).toEqual([])
      hook.rerender('s1')
      expect(hook.result.current.pendingQuestions).toHaveLength(2)
      hook.unmount()
    } finally {
      f.dispose()
    }
  })
  it('settles an accepted batch in both windows, rejects stale replay, and keeps a new request with reused item ids', async () => {
    const f = await fixture()
    try {
      f.emit({ type: 'question.requested', question: question() })
      await f.stores[0]!.respondToQuestion('second', answers)
      expect(f.respondEnvelope).toHaveBeenCalledTimes(1)
      for (const store of f.stores) expect(store.questions).toEqual([])
      f.postEvent({ type: 'question.requested', question: question() })
      for (const store of f.stores) expect(store.questions).toEqual([])
      f.emit({ type: 'question.requested', question: question({ rpcId: 'rpc-two' }) })
      f.postEvent({
        type: 'question.resolved',
        sessionId: 's1',
        questionRpcId: 'rpc-one',
        questionId: 'first',
      })
      for (const store of f.stores) expect(store.questions[0]?.rpcId).toBe('rpc-two')
      await f.stores[1]!.cancelQuestion('second')
      for (const store of f.stores) expect(store.questions).toEqual([])
    } finally {
      f.dispose()
    }
  })

  it('retains failed batches for manual retry and ignores a receipt from a departed connection', async () => {
    const f = await fixture()
    try {
      f.emit({ type: 'question.requested', question: question() })
      f.respondEnvelope.mockRejectedValueOnce(
        new AppError({ code: 'BACKEND_UNREACHABLE', message: 'Temporary failure', retryable: true }),
      )
      await expect(f.stores[0]!.respondToQuestion('first', answers)).rejects.toMatchObject({
        code: 'BACKEND_UNREACHABLE',
      })
      expect(f.stores[0]!.questions).toHaveLength(1)
      // No automatic retry of the business write.
      expect(f.respondEnvelope).toHaveBeenCalledTimes(1)
      let release!: (value: unknown) => void
      f.respondEnvelope.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      const old = f.stores[0]!.respondToQuestion('first', answers)
      await vi.waitFor(() => expect(f.respondEnvelope).toHaveBeenCalledTimes(2))
      f.postEvent({ type: 'connection.lost', reason: 'Disconnected' })
      // A new connection epoch clears process-local requests; the next request
      // has a distinct rpc identity even though its item ids are reused.
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            protocolVersion: 1,
            message: {
              type: 'event',
              name: 'connection.snapshot',
              sequence: 1000,
              payload: { kind: 'connected', backendInstanceId: 'new-host', connectionGeneration: 2 },
            },
          },
        }),
      )
      f.emit({ type: 'question.requested', question: question({ rpcId: 'rpc-new' }) })
      release({ accepted: true })
      await old
      expect(f.stores[0]!.questions[0]?.rpcId).toBe('rpc-new')
    } finally {
      f.dispose()
    }
  })

  it('keeps continued replies read-only across remount until Inbox admission or discard, including a late receipt', async () => {
    const f = await fixture()
    const store = f.stores[0]!
    const projected = { callId: 'call-q', state: 'continued', questions: question().items }
    const project = (key: string, value: unknown): void =>
      f.emit({ type: 'session.projection', sessionId: 's1', key, value })
    const queued = {
      'next-step': [],
      'next-turn': [{ source: { kind: 'user-question-reply', callId: 'call-q' } }],
    }
    try {
      project('userQuestions', { active: [projected], settled: [] })
      const first = renderHook(() => useQuestions(store))
      await act(async () => {
        await first.result.current.questionRespondFor(first.result.current.pendingQuestions[0]!)(answers)
      })
      expect(first.result.current.pendingQuestions[0]?.replyQueued).toBe(true)
      first.unmount()
      const reopened = renderHook(() => useQuestions(store))
      expect(reopened.result.current.pendingQuestions[0]?.replyQueued).toBe(true)
      act(() => {
        project('inbox', queued)
        f.emit({
          type: 'question.reply.status',
          sessionId: 's1',
          callId: 'call-q',
          state: 'claimed',
          asOfSequence: 2,
        })
        project('inbox', { 'next-step': [], 'next-turn': [] })
      })
      expect(reopened.result.current.pendingQuestions[0]?.replyQueued).toBe(true)
      act(() =>
        f.emit({
          type: 'question.reply.status',
          sessionId: 's1',
          callId: 'call-q',
          state: 'released',
          asOfSequence: 3,
        }),
      )
      expect(reopened.result.current.pendingQuestions[0]?.replyQueued).not.toBe(true)
      let release!: (value: unknown) => void
      f.setAnswerLate(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      let response!: Promise<void>
      act(() => {
        response = reopened.result.current.questionRespondFor(reopened.result.current.pendingQuestions[0]!)(
          answers,
        )
      })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      act(() => {
        project('inbox', queued)
        project('inbox', { 'next-step': [], 'next-turn': [] })
        f.emit({
          type: 'question.reply.status',
          sessionId: 's1',
          callId: 'call-q',
          state: 'released',
          asOfSequence: 5,
        })
      })
      await act(async () => {
        release({ kind: 'question.answer', accepted: true })
        await response
      })
      expect(reopened.result.current.pendingQuestions[0]?.replyQueued).not.toBe(true)
      act(() =>
        f.emit({
          type: 'question.reply.status',
          sessionId: 's1',
          callId: 'call-q',
          state: 'admitted',
          asOfSequence: 6,
        }),
      )
      expect(reopened.result.current.pendingQuestions).toEqual([])
      act(() => {
        project('userQuestions', { active: [], settled: [{ callId: 'call-q', answers: [] }] })
      })
      expect(reopened.result.current.pendingQuestions).toEqual([])
      reopened.unmount()
    } finally {
      f.dispose()
    }
  })
})
