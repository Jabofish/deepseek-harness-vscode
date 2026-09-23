import { describe, expect, it, vi } from 'vitest'

import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { Alpha171JobRepository } from '../src/versions/alpha171/job-repository.js'

const row = {
  id: 'job-1',
  kind: 'bash',
  label: 'pnpm test',
  status: 'running',
  startedAt: 10,
  owner: 'session-1',
  outputLimitBytes: 4096,
  output: { total: 5, earliest: 0, spillPaths: ['/private/output.log'] },
}

function asyncSequence(...values: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve()
      yield* values
    },
  }
}

function rejectedSequence(error: Error): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(error),
    }),
  }
}

function client(
  stream: (endpoint: string, args: Record<string, unknown>) => AsyncIterable<unknown>,
  receipt?: unknown,
): {
  readonly client: AlphaLoopbackApiClient
  readonly openRemoteStream: ReturnType<typeof vi.fn>
  readonly remoteRequest: ReturnType<typeof vi.fn>
} {
  const openRemoteStream = vi.fn(stream)
  const remoteRequest = vi.fn().mockResolvedValue(receipt)
  return {
    client: { openRemoteStream, remoteRequest } as unknown as AlphaLoopbackApiClient,
    openRemoteStream,
    remoteRequest,
  }
}

describe('alpha171 Job Controller repository', () => {
  it('uses the first whole-set frame for list and closes the dedicated stream', async () => {
    let closed = false
    const transport = client(() => ({
      async *[Symbol.asyncIterator]() {
        try {
          await Promise.resolve()
          yield { type: 'rows', jobs: [row] }
          yield { type: 'rows', jobs: [] }
        } finally {
          closed = true
        }
      },
    }))

    await expect(new Alpha171JobRepository(transport.client).list('session-1')).resolves.toEqual([
      {
        id: 'job-1',
        kind: 'bash',
        label: 'pnpm test',
        status: 'running',
        startedAt: 10,
        output: { total: 5, earliest: 0 },
      },
    ])
    expect(transport.openRemoteStream).toHaveBeenCalledWith(
      'job/list',
      { request: { sessionId: 'session-1' } },
      expect.any(AbortSignal),
    )
    expect(closed).toBe(true)
  })

  it('publishes every whole-set replacement, including an empty roster', async () => {
    const transport = client(() => asyncSequence({ type: 'rows', jobs: [row] }, { type: 'rows', jobs: [] }))
    const rowStream = new Alpha171JobRepository(transport.client).watchRows(
      'session-1',
      new AbortController().signal,
    )
    const iterator = rowStream[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'jobs.updated', sessionId: 'session-1', jobs: [{ id: 'job-1' }] },
      done: false,
    })
    await expect(iterator.next()).resolves.toEqual({
      value: { type: 'jobs.updated', sessionId: 'session-1', jobs: [] },
      done: false,
    })
    await iterator.return?.()
  })

  it('resumes at the requested byte offset and omits host-only spill paths', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 3 },
        {
          type: 'output',
          chunks: [{ at: 3, text: '✓', channel: 'stdout', gapBefore: true }],
          next: 6,
          lossy: true,
        },
        { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } },
      ),
    )
    const repository = new Alpha171JobRepository(transport.client)
    const followStream = repository.follow('session-1', 'job-1', 3)
    const iterator = followStream[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'opened', from: 3, job: { id: 'job-1', output: { total: 5, earliest: 0 } } },
    })
    await expect(iterator.next()).resolves.toEqual({
      value: {
        type: 'output',
        chunks: [{ at: 3, text: '✓', channel: 'stdout', gapBefore: true }],
        next: 6,
        lossy: true,
      },
      done: false,
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'status', job: { status: 'completed', finishedAt: 20 } },
    })
    expect(transport.openRemoteStream).toHaveBeenCalledWith(
      'job/follow',
      { request: { sessionId: 'session-1', jobId: 'job-1', from: 3 } },
      undefined,
    )
    await iterator.return?.()
  })

  it('completes after forwarding the terminal status and naturally releasing the stream', async () => {
    let released = false
    const transport = client(() => ({
      async *[Symbol.asyncIterator]() {
        try {
          await Promise.resolve()
          yield { type: 'opened', job: row, from: 0 }
          yield {
            type: 'output',
            chunks: [{ at: 0, text: 'done', channel: 'stdout' }],
            next: 4,
          }
          yield { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } }
        } finally {
          released = true
        }
      },
    }))
    const repository = new Alpha171JobRepository(transport.client)
    const frames: unknown[] = []

    await expect(
      (async () => {
        for await (const frame of repository.follow('session-1', 'job-1')) frames.push(frame)
      })(),
    ).resolves.toBeUndefined()
    expect(frames).toEqual([
      {
        type: 'opened',
        job: {
          id: 'job-1',
          kind: 'bash',
          label: 'pnpm test',
          status: 'running',
          startedAt: 10,
          output: { total: 5, earliest: 0 },
        },
        from: 0,
      },
      {
        type: 'output',
        chunks: [{ at: 0, text: 'done', channel: 'stdout' }],
        next: 4,
      },
      {
        type: 'status',
        job: {
          id: 'job-1',
          kind: 'bash',
          label: 'pnpm test',
          status: 'completed',
          startedAt: 10,
          finishedAt: 20,
          output: { total: 5, earliest: 0 },
        },
      },
    ])
    expect(released).toBe(true)
  })

  it('rejects EOF without a terminal status, including a non-terminal status frame', async () => {
    const opened = { type: 'opened', job: row, from: 0 }
    const incompleteStreams = [
      client(() => asyncSequence(opened)),
      client(() => asyncSequence(opened, { type: 'status', job: row })),
    ]

    for (const transport of incompleteStreams) {
      const repository = new Alpha171JobRepository(transport.client)
      await expect(
        (async () => {
          for await (const _frame of repository.follow('session-1', 'job-1')) void _frame
        })(),
      ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    }
  })

  it('ends cleanly on request cancellation and releases the upstream iterator', async () => {
    const controller = new AbortController()
    let released = false
    const transport = client(() => ({
      async *[Symbol.asyncIterator]() {
        const aborted = new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve()
          else controller.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        try {
          yield { type: 'opened', job: row, from: 0 }
          await aborted
        } finally {
          released = true
        }
      },
    }))
    const repository = new Alpha171JobRepository(transport.client)
    const follow = repository.follow('session-1', 'job-1', undefined, controller.signal)
    const iterator = follow[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'opened', from: 0 },
    })
    const pending = iterator.next()
    controller.abort('cancelled')
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(released).toBe(true)
  })

  it('sends the session-fenced kill and validates its receipt', async () => {
    const transport = client(() => asyncSequence(), { outcome: 'requested' })
    await expect(new Alpha171JobRepository(transport.client).kill('session-1', 'job-1')).resolves.toBe(
      'requested',
    )
    expect(transport.remoteRequest).toHaveBeenCalledWith(
      'job/kill',
      {
        request: { sessionId: 'session-1', jobId: 'job-1' },
      },
      undefined,
    )

    const malformed = client(() => asyncSequence(), { outcome: 'stopped' })
    await expect(
      new Alpha171JobRepository(malformed.client).kill('session-1', 'job-1'),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('rejects malformed offsets, chunks, job views and row frames', async () => {
    const badRows = client(() =>
      asyncSequence({ type: 'rows', jobs: [{ ...row, output: { total: 1, earliest: 2 } }] }),
    )
    await expect(new Alpha171JobRepository(badRows.client).list('session-1')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })

    const badChunk = client(() => asyncSequence({ type: 'output', chunks: [{ at: 1, text: 'x' }], next: 1 }))
    const badFollow = new Alpha171JobRepository(badChunk.client).follow('session-1', 'job-1')
    await expect(badFollow[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })

    const badOffset = client(() => asyncSequence())
    const badOffsetStream = new Alpha171JobRepository(badOffset.client).follow('session-1', 'job-1', -1)
    await expect(badOffsetStream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('cancels before opening and preserves upstream failures', async () => {
    const transport = client(() => asyncSequence())
    const controller = new AbortController()
    controller.abort('cancelled')
    const cancelledStream = new Alpha171JobRepository(transport.client).follow(
      'session-1',
      'job-1',
      undefined,
      controller.signal,
    )
    await expect(cancelledStream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(transport.openRemoteStream).not.toHaveBeenCalled()

    const failed = client(() =>
      rejectedSequence(Object.assign(new Error('job not found'), { code: 'job-not-found' })),
    )
    await expect(new Alpha171JobRepository(failed.client).list('session-1')).rejects.toMatchObject({
      code: 'job-not-found',
    })
  })
})
