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
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private sequence = 100

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.respond(request) as T)
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
          id: SESSION_ID,
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

function emitFollowFrame(client: JobClient, frame: unknown): void {
  client.emit('job.follow.updated', { sessionId: SESSION_ID, jobId: job.id, frame })
}

describe('AppStore Job follow', () => {
  it('keeps displayed chunks when a resumed follow receives its opened frame', async () => {
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
        next: 16,
      })
      expect(store.jobFollow?.next).toBe(16)
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text)).toEqual(['already displayed'])

      await store.followJob(job.id)
      const starts = client.requests.filter((request) => request.type === 'job.follow.start')
      expect(starts).toHaveLength(2)
      expect(starts[1]?.type === 'job.follow.start' ? starts[1].payload.from : undefined).toBe(16)

      emitFollowFrame(client, { type: 'opened', job, from: 16 })

      expect(store.jobFollow?.chunks.map((chunk) => chunk.text)).toEqual(['already displayed'])
      expect(store.jobFollow?.next).toBe(16)
    } finally {
      store.dispose()
    }
  })

  it('ignores opened, output, and status frames delivered after following stops', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      await store.stopFollowingJob()

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

  it('ignores an older stream while a newer follow waits for its requested offset', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      emitFollowFrame(client, { type: 'output', chunks: [{ at: 0, text: 'prior' }], next: 8 })
      await store.stopFollowingJob()

      const resumedJob = { ...job, output: { total: 12, earliest: 8 } }
      client.emit('jobs.updated', { sessionId: SESSION_ID, jobs: [resumedJob] })
      await store.followJob(job.id)

      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      emitFollowFrame(client, {
        type: 'output',
        chunks: [{ at: 8, text: 'stale output' }],
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

  it('retains read chunks when a terminal status closes the follow', async () => {
    const { client, store } = await openJobStore()

    try {
      await store.followJob(job.id)
      emitFollowFrame(client, { type: 'opened', job, from: 0 })
      emitFollowFrame(client, {
        type: 'output',
        chunks: [{ at: 0, text: 'finished output' }],
        next: 12,
      })
      emitFollowFrame(client, { type: 'status', job: settledJob })

      expect(store.jobFollow?.job?.status).toBe('completed')
      expect(store.jobFollow?.chunks.map((chunk) => chunk.text)).toEqual(['finished output'])
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
