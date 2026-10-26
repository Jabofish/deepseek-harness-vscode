// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

const SESSION_ID = 'job-follow-session'

const job = {
  id: 'bash-1',
  kind: 'bash',
  label: 'run build',
  status: 'running',
  startedAt: 1_000,
  output: { total: 0, earliest: 0 },
} as const

const settledJob = {
  ...job,
  status: 'completed',
  finishedAt: 2_000,
  output: { total: 12, earliest: 0 },
} as const

class JobClient {
  public readonly requests: WebviewRequest[] = []
  public rejectSubagentHistory = false
  public rejectJobFollowStart = false
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private nextDeferredRequest:
    | {
        readonly type: WebviewRequest['type']
        readonly promise: Promise<unknown>
        readonly resolve: () => void
        readonly reject: (reason: unknown) => void
      }
    | undefined
  private sequence = 100

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    if (this.nextDeferredRequest?.type === request.type) {
      const deferred = this.nextDeferredRequest
      this.nextDeferredRequest = undefined
      return deferred.promise as Promise<T>
    }
    return Promise.resolve(this.respond(request) as T)
  }

  public deferNextRequest(type: WebviewRequest['type']): {
    readonly resolve: () => void
    readonly reject: (reason: unknown) => void
  } {
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    this.nextDeferredRequest = { type, promise, resolve, reject }
    return { resolve, reject }
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public emit(name: string, payload: unknown): void {
    const message: HostMessage = {
      type: 'event',
      sequence: this.sequence++,
      name,
      payload,
    }
    for (const listener of this.listeners) listener(message)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  private respond(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open':
        return {
          id: request.payload.sessionId,
          workspaceId: 'job-workspace',
          workspaceFolderId: 'job-folder',
          title: 'Job follow',
          blank: false,
          status: 'running',
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
          history: [],
          historyHasMore: false,
          permissionPresets: [],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        }
      case 'job.list':
        return [job]
      case 'job.follow.start':
        if (this.rejectJobFollowStart) throw new Error('job follow start unavailable')
        return undefined
      case 'subagent.history':
        if (this.rejectSubagentHistory) throw new Error('subagent history unavailable')
        return { events: [], hasMore: false }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      case 'models.session.list':
        return { models: [], failures: [], current: undefined, routable: true }
      default:
        return []
    }
  }
}

async function openJobStore(): Promise<{
  readonly client: JobClient
  readonly store: ReturnType<typeof createAppStore>
}> {
  const client = new JobClient()
  const store = createAppStore(client as unknown as ProtocolClient)
  client.emit('connection.snapshot', { kind: 'connected', jobController: true })
  await store.openSession(SESSION_ID)
  await new Promise((resolve) => window.setTimeout(resolve, 32))
  client.emit('jobs.updated', { sessionId: SESSION_ID, jobs: [job] })
  return { client, store }
}

function emitFollowFrame(client: JobClient, frame: unknown, followId?: string): void {
  const latestStart = [...client.requests].reverse().find((request) => request.type === 'job.follow.start')
  const activeFollowId =
    followId ??
    (latestStart?.type === 'job.follow.start' ? latestStart.payload.followId : 'missing-follow-id')
  client.emit('job.follow.updated', { sessionId: SESSION_ID, jobId: job.id, followId: activeFollowId, frame })
}

function emitFollowFailure(
  client: JobClient,
  payload: {
    readonly sessionId?: string | undefined
    readonly jobId?: string | undefined
    readonly followId?: string | undefined
    readonly reason?: unknown
  },
): void {
  client.emit('job.follow.failed', {
    sessionId: SESSION_ID,
    jobId: job.id,
    followId: 'missing-follow-id',
    reason: 'stream-failed',
    ...payload,
  })
}

function hasStopRequest(client: JobClient, sessionId: string, jobId: string, followId?: string): boolean {
  return client.requests.some(
    (request) =>
      request.type === 'job.follow.stop' &&
      request.payload.sessionId === sessionId &&
      request.payload.jobId === jobId &&
      request.payload.followId.length > 0 &&
      (followId === undefined || request.payload.followId === followId),
  )
}

describe('AppStore Job follow', () => {
  it('makes lost control output retryable from its accepted byte cursor without affecting transcript-only recovery', async () => {
    const { client, store } = await openJobStore()
    try {
      await store.followJob(job.id)
      const originalFollowId = store.jobFollow!.followId
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: '中' }], next: 3 })
      const following = store.jobFollow

      client.emit('session.transcript.invalidated', { sessionId: SESSION_ID })
      expect(store.jobFollow).toEqual(following)
      expect(hasStopRequest(client, SESSION_ID, job.id)).toBe(false)

      for (let index = 0; index < 3; index++) client.emit('ui.resync', {})
      expect(store.jobFollow).toMatchObject({
        next: 3,
        chunks: [{ at: 0, text: '中' }],
        error: 'stream-failed',
      })
      expect(client.requests.filter((request) => request.type === 'job.follow.stop')).toHaveLength(1)
      expect(hasStopRequest(client, SESSION_ID, job.id, originalFollowId)).toBe(true)
      emitFollowFrame(
        client,
        { type: 'output', chunks: [{ at: 3, text: 'stale' }], next: 8 },
        originalFollowId,
      )
      expect(store.jobFollow?.next).toBe(3)

      await store.followJob(job.id)
      const starts = client.requests.filter((request) => request.type === 'job.follow.start')
      expect(starts).toHaveLength(2)
      expect(starts[1]?.payload).toMatchObject({ sessionId: SESSION_ID, jobId: job.id, from: 3 })
      expect(store.jobFollow?.followId).not.toBe(originalFollowId)
      expect(store.jobFollow?.error).toBeUndefined()
      emitFollowFailure(client, { followId: originalFollowId })
      expect(store.jobFollow?.error).toBeUndefined()
      emitFollowFrame(client, { type: 'opened', job, from: 3 })
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 3, text: 'tail' }], next: 7 })
      emitFollowFrame(client, { type: 'status', job: { ...settledJob, output: { total: 7, earliest: 0 } } })
      expect(store.jobFollow).toMatchObject({ next: 7, terminalStatusReceived: true })
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('中tail')
    } finally {
      store.dispose()
    }
  })

  it('clips multibyte retry overlap by UTF-8 bytes and deduplicates complete old chunks', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const firstStart = client.requests.find((request) => request.type === 'job.follow.start')
      const firstFollowId = firstStart?.type === 'job.follow.start' ? firstStart.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, firstFollowId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: '✓' }], next: 3 }, firstFollowId)
      emitFollowFailure(client, { followId: firstFollowId })

      await store.followJob(job.id)
      const starts = client.requests.filter((request) => request.type === 'job.follow.start')
      const secondFollowId = starts[1]?.type === 'job.follow.start' ? starts[1].payload.followId : undefined
      expect(starts[1]?.type === 'job.follow.start' ? starts[1].payload.from : undefined).toBe(3)
      emitFollowFrame(client, { type: 'opened', job, from: 3 }, secondFollowId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: '✓x' }], next: 4 }, secondFollowId)
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('✓x')
      expect(store.jobFollow?.chunks).toEqual([
        { at: 0, text: '✓' },
        { at: 3, text: 'x' },
      ])

      emitFollowFrame(
        client,
        {
          type: 'output',
          chunks: [
            { at: 0, text: '✓' },
            { at: 3, text: 'x' },
          ],
          next: 4,
        },
        secondFollowId,
      )
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('✓x')
      expect(store.jobFollow?.next).toBe(4)
    } finally {
      store.dispose()
    }
  })

  it('fails closed on an unmarked gap or a byte cursor inside a UTF-8 code point', async () => {
    for (const output of [
      { type: 'output', chunks: [{ at: 2, text: 'c' }], next: 3 },
      { type: 'output', chunks: [{ at: 0, text: '✓x' }], next: 4 },
    ]) {
      const { client, store } = await openJobStore()

      try {
        await store.followJob(job.id)
        const start = client.requests.find((request) => request.type === 'job.follow.start')
        const followId = start?.type === 'job.follow.start' ? start.payload.followId : undefined
        emitFollowFrame(client, { type: 'opened', job, from: 0 }, followId)
        emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'a' }], next: 1 }, followId)
        expect(store.jobFollow).toMatchObject({ next: 1, chunks: [{ at: 0, text: 'a' }] })
        const before = store.jobFollow
        if (output.chunks[0]?.at === 2) {
          emitFollowFrame(client, output, followId)
        } else {
          // A retry may replay the prior code point, but cannot resume inside it.
          emitFollowFailure(client, { followId })
          await store.followJob(job.id)
          const starts = client.requests.filter((request) => request.type === 'job.follow.start')
          const retryFollowId =
            starts[1]?.type === 'job.follow.start' ? starts[1].payload.followId : undefined
          emitFollowFrame(client, { type: 'opened', job, from: 1 }, retryFollowId)
          emitFollowFrame(client, output, retryFollowId)
        }
        expect(store.jobFollow?.error, JSON.stringify(output)).toBe('stream-failed')
        expect(store.jobFollow?.next).toBe(before?.next)
        expect(store.jobFollow?.chunks).toEqual(before?.chunks)
      } finally {
        store.dispose()
      }
    }
  })

  it('retains read chunks when a terminal status closes the follow', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      emitFollowFrame(client, {
        type: 'output',
        chunks: [{ at: 0, text: 'finished' }],
        next: 8,
      })
      emitFollowFrame(client, { type: 'status', job: settledJob })

      expect(store.jobFollow?.job?.status).toBe('completed')
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text)).toEqual(['finished'])
    } finally {
      store.dispose()
    }
  })
})
