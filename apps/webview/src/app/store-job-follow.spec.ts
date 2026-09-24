// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

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
  it('keeps displayed chunks and does not restart an active follow for the same job', async () => {
    const { client, store } = await openJobStore()

    try {
      expect(store.activeSessionId).toBe(SESSION_ID)
      expect(store.jobControllerAvailable).toBe(true)
      expect(store.jobs).toEqual([job])
      const firstStart = store.followJob(job.id)
      expect(store.jobFollow?.awaitingOpenFrom).toBe(0)
      await firstStart
      expect(store.jobFollow?.awaitingOpenFrom).toBe(0)
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      expect(store.jobFollow?.awaitingOpenFrom).toBeUndefined()
      emitFollowFrame(client, {
        type: 'output',
        chunks: [{ at: 0, text: 'already displayed' }],
        next: 17,
      })
      expect(store.jobFollow?.next).toBe(17)
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text)).toEqual(['already displayed'])

      const followId = store.jobFollow?.followId
      await store.followJob(job.id)
      const starts = client.requests.filter((request) => request.type === 'job.follow.start')
      expect(starts).toHaveLength(1)

      expect(store.jobFollow?.followId).toBe(followId)
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text)).toEqual(['already displayed'])
      expect(store.jobFollow?.next).toBe(17)
    } finally {
      store.dispose()
    }
  })

  it('keeps its active follow id when a duplicate start would fail Host validation', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      const firstStart = client.requests.find((request) => request.type === 'job.follow.start')
      const followId = firstStart?.type === 'job.follow.start' ? firstStart.payload.followId : undefined
      expect(followId).toBeDefined()

      client.rejectJobFollowStart = true
      await store.followJob(job.id)

      expect(client.requests.filter((request) => request.type === 'job.follow.start')).toHaveLength(1)
      expect(store.jobFollow?.followId).toBe(followId)
      expect(hasStopRequest(client, SESSION_ID, job.id, followId)).toBe(false)
    } finally {
      store.dispose()
    }
  })

  it('ignores opened, output, and status frames delivered after following stops', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const started = client.requests.find((request) => request.type === 'job.follow.start')
      const followId = started?.type === 'job.follow.start' ? started.payload.followId : 'missing-follow-id'
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      await store.stopFollowingJob()
      expect(hasStopRequest(client, SESSION_ID, job.id, followId)).toBe(true)

      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      emitFollowFrame(client, {
        type: 'output',
        chunks: [{ at: 0, text: 'late output' }],
        next: 11,
      })
      emitFollowFrame(client, { type: 'status', job: settledJob })

      expect(store.jobFollow).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('stops a parent job follow when opening a subagent session', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      await store.openSubagent(
        {
          kind: 'child',
          id: 'job-follow-child',
          label: 'worker',
          activity: 'running',
          parentSessionId: SESSION_ID,
          mode: 'continuable',
          hasChildren: false,
        },
        true,
      )

      expect(store.activeSessionId).toBe('job-follow-child')
      expect(store.jobFollow).toBeUndefined()
      expect(hasStopRequest(client, SESSION_ID, job.id)).toBe(true)
    } finally {
      store.dispose()
    }
  })

  it('clears the stopped follow if a subagent open fails after stopping it', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      client.rejectSubagentHistory = true

      await expect(
        store.openSubagent(
          {
            kind: 'child',
            id: 'job-follow-child',
            label: 'worker',
            activity: 'running',
            parentSessionId: SESSION_ID,
            mode: 'continuable',
            hasChildren: false,
          },
          true,
        ),
      ).rejects.toThrow('subagent history unavailable')

      expect(store.activeSessionId).toBe(SESSION_ID)
      expect(store.jobFollow).toBeUndefined()
      expect(hasStopRequest(client, SESSION_ID, job.id)).toBe(true)
    } finally {
      store.dispose()
    }
  })

  it('ignores an older stream while a newer follow waits for its requested offset', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'prior' }], next: 5 })
      await store.stopFollowingJob()

      const resumedJob = { ...job, output: { total: 12, earliest: 8 } }
      client.emit('jobs.updated', { sessionId: SESSION_ID, jobs: [resumedJob] })
      await store.followJob(job.id)

      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      emitFollowFrame(client, {
        type: 'output',
        chunks: [{ at: 8, text: 'tail' }],
        next: 12,
      })
      emitFollowFrame(client, { type: 'status', job: settledJob })

      expect(store.jobFollow?.awaitingOpenFrom).toBe(8)
      expect(store.jobFollow?.chunks).toEqual([])
      expect(store.jobFollow?.job?.status).toBe('running')

      emitFollowFrame(client, { type: 'opened', job: resumedJob, from: 8 })

      expect(store.jobFollow?.awaitingOpenFrom).toBeUndefined()
      expect(store.jobFollow?.job?.status).toBe('running')
    } finally {
      store.dispose()
    }
  })

  it('ignores an older stream after the replacement follow has opened', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const firstStart = client.requests.find((request) => request.type === 'job.follow.start')
      expect(firstStart?.type).toBe('job.follow.start')
      const firstFollowId =
        firstStart?.type === 'job.follow.start' ? firstStart.payload.followId : 'missing-follow-id'
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, firstFollowId)
      await store.stopFollowingJob()

      await store.followJob(job.id)
      const secondStart = [...client.requests]
        .reverse()
        .find((request) => request.type === 'job.follow.start')
      expect(secondStart?.type).toBe('job.follow.start')
      const secondFollowId =
        secondStart?.type === 'job.follow.start' ? secondStart.payload.followId : 'missing-follow-id'
      expect(secondFollowId).not.toBe(firstFollowId)
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, secondFollowId)
      emitFollowFrame(client, { type: 'status', job: settledJob }, firstFollowId)

      expect(store.jobFollow?.job?.status).toBe('running')
      expect(store.jobFollow).toMatchObject({ jobId: job.id })
    } finally {
      store.dispose()
    }
  })

  it('stops the matching Host generation when a start response fails', async () => {
    const { client, store } = await openJobStore()

    try {
      const deferredStart = client.deferNextRequest('job.follow.start')
      const starting = store.followJob(job.id)
      const startRequest = client.requests.find((request) => request.type === 'job.follow.start')
      const followId =
        startRequest?.type === 'job.follow.start' ? startRequest.payload.followId : 'missing-follow-id'

      deferredStart.reject(new Error('start response failed'))
      await expect(starting).rejects.toThrow('start response failed')

      expect(store.jobFollow).toBeUndefined()
      expect(hasStopRequest(client, SESSION_ID, job.id, followId)).toBe(true)
    } finally {
      store.dispose()
    }
  })

  it('does not replace a pending follow when the duplicate call arrives before opened', async () => {
    const { client, store } = await openJobStore()

    try {
      const deferredStart = client.deferNextRequest('job.follow.start')
      const olderStart = store.followJob(job.id)
      const pendingFollowId = store.jobFollow?.followId
      await store.followJob(job.id)

      expect(client.requests.filter((request) => request.type === 'job.follow.start')).toHaveLength(1)
      expect(store.jobFollow?.followId).toBe(pendingFollowId)
      expect(store.jobFollow?.awaitingOpenFrom).toBe(0)

      deferredStart.resolve()
      await olderStart
      expect(store.jobFollow?.followId).toBe(pendingFollowId)
    } finally {
      store.dispose()
    }
  })

  it('restarts a follow after a terminal status frame', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const firstStart = client.requests.find((request) => request.type === 'job.follow.start')
      const firstFollowId = firstStart?.type === 'job.follow.start' ? firstStart.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, firstFollowId)
      emitFollowFrame(client, { type: 'status', job: settledJob }, firstFollowId)

      await store.followJob(job.id)

      const starts = client.requests.filter((request) => request.type === 'job.follow.start')
      expect(starts).toHaveLength(2)
      const restartedFollowId =
        starts[1]?.type === 'job.follow.start' ? starts[1].payload.followId : undefined
      expect(restartedFollowId).toBeDefined()
      expect(restartedFollowId).not.toBe(firstFollowId)
      expect(store.jobFollow?.followId).toBe(restartedFollowId)
    } finally {
      store.dispose()
    }
  })

  it('fences failure events by session, job, and follow id, then retries from the saved cursor', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const firstStart = client.requests.find((request) => request.type === 'job.follow.start')
      const firstFollowId = firstStart?.type === 'job.follow.start' ? firstStart.payload.followId : undefined
      expect(firstFollowId).toBeDefined()
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, firstFollowId)
      emitFollowFrame(
        client,
        { type: 'output', chunks: [{ at: 0, text: 'partial' }], next: 7 },
        firstFollowId,
      )

      emitFollowFailure(client, { sessionId: 'another-session', followId: firstFollowId })
      emitFollowFailure(client, { jobId: 'another-job', followId: firstFollowId })
      emitFollowFailure(client, { followId: 'another-follow' })
      emitFollowFailure(client, { followId: firstFollowId, reason: 'sensitive upstream error' })
      expect(store.jobFollow?.error).toBeUndefined()

      emitFollowFailure(client, { followId: firstFollowId })
      expect(store.jobFollow).toMatchObject({
        jobId: job.id,
        followId: firstFollowId,
        next: 7,
        error: 'stream-failed',
        chunks: [{ at: 0, text: 'partial' }],
      })

      await store.followJob(job.id)
      const starts = client.requests.filter((request) => request.type === 'job.follow.start')
      expect(starts).toHaveLength(2)
      const secondFollowId = starts[1]?.type === 'job.follow.start' ? starts[1].payload.followId : undefined
      expect(secondFollowId).toBeDefined()
      expect(secondFollowId).not.toBe(firstFollowId)
      expect(starts[1]?.type === 'job.follow.start' ? starts[1].payload.from : undefined).toBe(7)
      expect(store.jobFollow).toMatchObject({
        followId: secondFollowId,
        error: undefined,
        awaitingOpenFrom: 7,
        chunks: [{ at: 0, text: 'partial' }],
      })

      emitFollowFailure(client, { followId: firstFollowId })
      expect(store.jobFollow?.followId).toBe(secondFollowId)
      expect(store.jobFollow?.error).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('clips an overlapping retry chunk at the saved UTF-8 byte cursor', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const firstStart = client.requests.find((request) => request.type === 'job.follow.start')
      const firstFollowId = firstStart?.type === 'job.follow.start' ? firstStart.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, firstFollowId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 }, firstFollowId)
      emitFollowFailure(client, { followId: firstFollowId })

      await store.followJob(job.id)
      const starts = client.requests.filter((request) => request.type === 'job.follow.start')
      const secondFollowId = starts[1]?.type === 'job.follow.start' ? starts[1].payload.followId : undefined
      expect(secondFollowId).not.toBe(firstFollowId)
      expect(starts[1]?.type === 'job.follow.start' ? starts[1].payload.from : undefined).toBe(3)
      emitFollowFrame(client, { type: 'opened', job, from: 3 }, secondFollowId)
      emitFollowFrame(client, { type: 'output', chunks: [], next: 3 }, secondFollowId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'abcde' }], next: 5 }, secondFollowId)

      expect(store.jobFollow?.next).toBe(5)
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('abcde')
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

  it('appends exact-boundary chunks once and preserves an explicit lossy gap', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const start = client.requests.find((request) => request.type === 'job.follow.start')
      const followId = start?.type === 'job.follow.start' ? start.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, followId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 }, followId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 }, followId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 3, text: 'd' }], next: 4 }, followId)
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('abcd')

      emitFollowFrame(
        client,
        { type: 'output', chunks: [{ at: 5, text: 'f', gapBefore: true }], next: 6 },
        followId,
      )
      expect(store.jobFollow).toMatchObject({ next: 6, lossy: true })
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('abcdf')

      emitFollowFrame(
        client,
        { type: 'output', chunks: [{ at: 8, text: 'g' }], next: 9, lossy: true },
        followId,
      )
      expect(store.jobFollow).toMatchObject({ next: 9, lossy: true })
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('abcdfg')

      emitFollowFrame(
        client,
        { type: 'output', chunks: [{ at: 10, text: '', gapBefore: true }], next: 10, lossy: true },
        followId,
      )
      expect(store.jobFollow).toMatchObject({ next: 10, lossy: true })
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('abcdfg')

      emitFollowFrame(client, { type: 'output', chunks: [], next: 12, lossy: true }, followId)
      expect(store.jobFollow).toMatchObject({ next: 12, lossy: true })
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('abcdfg')

      emitFollowFrame(
        client,
        {
          type: 'output',
          chunks: [
            { at: 12, text: 'x' },
            { at: 14, text: 'z', gapBefore: true },
          ],
          next: 15,
        },
        followId,
      )
      expect(store.jobFollow).toMatchObject({ next: 15, lossy: true })
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text).join('')).toBe('abcdfgxz')
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

  it('does not advance past the last retained byte in an output frame', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const start = client.requests.find((request) => request.type === 'job.follow.start')
      const followId = start?.type === 'job.follow.start' ? start.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, followId)

      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'a' }], next: 5 }, followId)

      expect(store.jobFollow?.next).toBe(0)
      expect(store.jobFollow?.chunks).toEqual([])
    } finally {
      store.dispose()
    }
  })

  it('drops output frames with an unmarked internal byte gap', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const start = client.requests.find((request) => request.type === 'job.follow.start')
      const followId = start?.type === 'job.follow.start' ? start.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, followId)
      emitFollowFrame(
        client,
        {
          type: 'output',
          chunks: [
            { at: 0, text: 'a' },
            { at: 2, text: 'c' },
          ],
          next: 3,
        },
        followId,
      )

      expect(store.jobFollow?.next).toBe(0)
      expect(store.jobFollow?.chunks).toEqual([])
    } finally {
      store.dispose()
    }
  })

  it('does not let lossy output authorize an unmarked internal byte gap', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const start = client.requests.find((request) => request.type === 'job.follow.start')
      const followId = start?.type === 'job.follow.start' ? start.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, followId)
      emitFollowFrame(
        client,
        {
          type: 'output',
          chunks: [
            { at: 0, text: 'a' },
            { at: 2, text: 'c' },
          ],
          next: 3,
          lossy: true,
        },
        followId,
      )

      expect(store.jobFollow?.next).toBe(0)
      expect(store.jobFollow?.chunks).toEqual([])
    } finally {
      store.dispose()
    }
  })

  it('rejects malformed follow payloads before they reach the store reducer', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const start = client.requests.find((request) => request.type === 'job.follow.start')
      const followId = start?.type === 'job.follow.start' ? start.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, followId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 }, followId)
      const before = store.jobFollow

      client.emit('job.follow.updated', {
        sessionId: SESSION_ID,
        jobId: job.id,
        followId,
        extra: 'not allowed',
        frame: { type: 'output', chunks: [{ at: 0, text: 'abcde' }], next: 4 },
      })
      client.emit('job.follow.failed', {
        sessionId: SESSION_ID,
        jobId: job.id,
        followId,
        reason: 'sensitive remote error',
      })

      expect(store.jobFollow).toEqual(before)
    } finally {
      store.dispose()
    }
  })

  it('keeps cross-frame failure scoped to the active session, job, and follow id', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      const start = client.requests.find((request) => request.type === 'job.follow.start')
      const followId = start?.type === 'job.follow.start' ? start.payload.followId : undefined
      emitFollowFrame(client, { type: 'opened', job, from: 0 }, followId)
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'a' }], next: 1 }, followId)
      const gapFrame = { type: 'output', chunks: [{ at: 2, text: 'c' }], next: 3 }

      client.emit('job.follow.updated', {
        sessionId: 'another-session',
        jobId: job.id,
        followId,
        frame: gapFrame,
      })
      client.emit('job.follow.updated', {
        sessionId: SESSION_ID,
        jobId: 'another-job',
        followId,
        frame: gapFrame,
      })
      client.emit('job.follow.updated', {
        sessionId: SESSION_ID,
        jobId: job.id,
        followId: 'another-follow',
        frame: gapFrame,
      })
      expect(store.jobFollow).toMatchObject({ next: 1, chunks: [{ at: 0, text: 'a' }] })
      expect(store.jobFollow?.error).toBeUndefined()

      emitFollowFrame(client, gapFrame, followId)
      expect(store.jobFollow).toMatchObject({
        next: 1,
        chunks: [{ at: 0, text: 'a' }],
        error: 'stream-failed',
      })
    } finally {
      store.dispose()
    }
  })

  it('does not resume an old session follow after its stop settles during a session switch', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      const nextJob = { ...job, id: 'bash-2', label: 'run tests' }
      client.emit('jobs.updated', { sessionId: SESSION_ID, jobs: [job, nextJob] })

      const releasePriorStop = client.deferNextRequest('job.follow.stop')
      const followNextJob = store.followJob(nextJob.id)
      await store.openSession('job-follow-next-session')
      releasePriorStop.resolve()
      await followNextJob

      expect(store.activeSessionId).toBe('job-follow-next-session')
      expect(store.jobFollow).toBeUndefined()
      expect(
        client.requests.filter(
          (request) =>
            request.type === 'job.follow.start' &&
            request.payload.sessionId === SESSION_ID &&
            request.payload.jobId === nextJob.id,
        ),
      ).toEqual([])
    } finally {
      store.dispose()
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

  it('accepts output after opening a job that was already settled', async () => {
    const { client, store } = await openJobStore()

    try {
      client.emit('jobs.updated', { sessionId: SESSION_ID, jobs: [settledJob] })
      await store.followJob(job.id)
      emitFollowFrame(client, { type: 'opened', job: settledJob, from: 0 })
      emitFollowFrame(client, {
        type: 'output',
        chunks: [{ at: 0, text: 'done' }],
        next: 4,
      })
      emitFollowFrame(client, { type: 'status', job: settledJob })

      expect(store.jobFollow?.chunks.map((chunk) => chunk.text)).toEqual(['done'])
      expect(store.jobFollow?.job?.status).toBe('completed')
    } finally {
      store.dispose()
    }
  })
})
