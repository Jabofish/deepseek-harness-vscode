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

async function expectMalformedFollow(transport: AlphaLoopbackApiClient, from = 0): Promise<void> {
  await expect(
    (async () => {
      for await (const _frame of new Alpha171JobRepository(transport).follow('session-1', 'job-1', from))
        void _frame
    })(),
  ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
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
        {
          type: 'status',
          job: {
            ...row,
            status: 'completed',
            finishedAt: 20,
            output: { total: 6, earliest: 0 },
          },
        },
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

  it('sends the session-fenced kill and unwraps and validates its Remote receipt', async () => {
    const transport = client(() => asyncSequence(), { ok: true, value: { outcome: 'requested' } })
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

    const finished = client(() => asyncSequence(), { ok: true, value: { outcome: 'already-finished' } })
    await expect(new Alpha171JobRepository(finished.client).kill('session-1', 'job-1')).resolves.toBe(
      'already-finished',
    )

    const malformed = client(() => asyncSequence(), { ok: true, value: { outcome: 'stopped' } })
    await expect(
      new Alpha171JobRepository(malformed.client).kill('session-1', 'job-1'),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })

    const missingValue = client(() => asyncSequence(), { ok: true })
    await expect(
      new Alpha171JobRepository(missingValue.client).kill('session-1', 'job-1'),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })

    const remoteError = client(() => asyncSequence(), {
      ok: false,
      error: { code: 'job-not-found', message: 'The job is no longer available.', details: {} },
    })
    await expect(
      new Alpha171JobRepository(remoteError.client).kill('session-1', 'job-1'),
    ).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
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

  it('accepts upstream-valid overlap, lossy recovery, and an offset beyond the opening total', async () => {
    const cases = [
      {
        from: 3,
        openedJob: row,
        output: {
          type: 'output',
          chunks: [{ at: 0, text: 'abcde' }],
          next: 5,
        },
        statusJob: { ...row, status: 'completed', finishedAt: 20 },
      },
      {
        from: 0,
        openedJob: { ...row, output: { total: 6, earliest: 4 } },
        output: {
          type: 'output',
          chunks: [{ at: 4, text: 'ef' }],
          next: 6,
          lossy: true,
        },
        statusJob: {
          ...row,
          status: 'completed',
          finishedAt: 20,
          output: { total: 6, earliest: 4 },
        },
      },
      {
        // A byte-less cursor advance is valid only when the upstream marks
        // the omitted output as lossy.
        from: 0,
        openedJob: row,
        output: { type: 'output', chunks: [], next: 5, lossy: true },
        statusJob: { ...row, status: 'completed', finishedAt: 20 },
      },
      {
        // An explicit per-chunk marker preserves an internal lossy hole.
        from: 0,
        openedJob: row,
        output: {
          type: 'output',
          chunks: [
            { at: 0, text: 'a' },
            { at: 2, text: 'c', gapBefore: true },
          ],
          next: 3,
        },
        statusJob: { ...row, status: 'completed', finishedAt: 20 },
      },
      {
        // A one-byte ring cap can trim a multi-byte code point to an empty,
        // gap-marked UTF-8 tail while preserving its absolute end offset.
        from: 0,
        openedJob: { ...row, output: { total: 4, earliest: 4 } },
        output: {
          type: 'output',
          chunks: [{ at: 4, text: '', gapBefore: true }],
          next: 4,
          lossy: true,
        },
        statusJob: {
          ...row,
          status: 'completed',
          finishedAt: 20,
          output: { total: 4, earliest: 4 },
        },
      },
      {
        // DSH accepts offsets beyond the current total. Its first read clamps
        // the live cursor to that total, so later output may start before from.
        from: 9,
        openedJob: row,
        output: {
          type: 'output',
          chunks: [{ at: 5, text: 'f' }],
          next: 6,
        },
        statusJob: {
          ...row,
          status: 'completed',
          finishedAt: 20,
          output: { total: 6, earliest: 0 },
        },
      },
    ]

    for (const recovery of cases) {
      const transport = client(() =>
        asyncSequence({ type: 'opened', job: recovery.openedJob, from: recovery.from }, recovery.output, {
          type: 'status',
          job: recovery.statusJob,
        }),
      )
      const frames: unknown[] = []

      await expect(
        (async () => {
          for await (const frame of new Alpha171JobRepository(transport.client).follow(
            'session-1',
            'job-1',
            recovery.from,
          ))
            frames.push(frame)
        })(),
      ).resolves.toBeUndefined()
      expect(frames).toHaveLength(3)
    }
  })

  it('accepts a removed terminal projection whose total advanced past the last output cursor', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: { ...row, output: { total: 3, earliest: 0 } }, from: 0 },
        { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 },
        {
          type: 'status',
          job: {
            ...row,
            status: 'killed',
            finishedAt: 20,
            output: { total: 5, earliest: 0 },
          },
        },
      ),
    )
    const frames: unknown[] = []

    await expect(
      (async () => {
        for await (const frame of new Alpha171JobRepository(transport.client).follow('session-1', 'job-1'))
          frames.push(frame)
      })(),
    ).resolves.toBeUndefined()
    expect(frames).toHaveLength(3)
  })

  it('rejects unopened streams, output cursor rollback, and replayed chunks', async () => {
    const terminal = { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } }
    const malformedStreams = [
      {
        from: undefined,
        // The upstream stream always starts with its opened anchor.
        transport: client(() => asyncSequence({ type: 'output', chunks: [], next: 0 }, terminal)),
      },
      {
        from: 3,
        // A chunk ending at the initial offset is wholly outside readAt's [from,total) range.
        transport: client(() =>
          asyncSequence(
            { type: 'opened', job: row, from: 3 },
            { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 4 },
            terminal,
          ),
        ),
      },
      {
        from: 3,
        // The opened frame must preserve an explicit request cursor exactly.
        transport: client(() => asyncSequence({ type: 'opened', job: row, from: 4 }, terminal)),
      },
      {
        from: 0,
        // The second frame overlaps bytes already delivered by the first frame.
        transport: client(() =>
          asyncSequence(
            { type: 'opened', job: row, from: 0 },
            { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 },
            { type: 'output', chunks: [{ at: 1, text: 'x' }], next: 4 },
            terminal,
          ),
        ),
      },
      {
        from: 0,
        // A frame cursor is the end of this frame's last returned ring chunk.
        transport: client(() =>
          asyncSequence(
            { type: 'opened', job: row, from: 0 },
            { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 2 },
            {
              type: 'status',
              job: {
                ...row,
                status: 'completed',
                finishedAt: 20,
                output: { total: 2, earliest: 0 },
              },
            },
          ),
        ),
      },
      {
        from: 0,
        // Chunks in one readAt result retain ring order and cannot overlap.
        transport: client(() =>
          asyncSequence(
            { type: 'opened', job: row, from: 0 },
            {
              type: 'output',
              chunks: [
                { at: 0, text: 'abc' },
                { at: 2, text: 'cd' },
              ],
              next: 4,
            },
            {
              type: 'status',
              job: {
                ...row,
                status: 'completed',
                finishedAt: 20,
                output: { total: 4, earliest: 0 },
              },
            },
          ),
        ),
      },
      {
        from: 0,
        // Chunks in one readAt result cannot run backwards by byte offset.
        transport: client(() =>
          asyncSequence(
            { type: 'opened', job: row, from: 0 },
            {
              type: 'output',
              chunks: [
                { at: 3, text: 'x' },
                { at: 0, text: 'abc' },
              ],
              next: 4,
            },
            {
              type: 'status',
              job: {
                ...row,
                status: 'completed',
                finishedAt: 20,
                output: { total: 4, earliest: 0 },
              },
            },
          ),
        ),
      },
      {
        from: 0,
        // Even an empty frame cannot move the absolute resume cursor backwards.
        transport: client(() =>
          asyncSequence(
            { type: 'opened', job: row, from: 0 },
            { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 },
            { type: 'output', chunks: [], next: 2 },
            terminal,
          ),
        ),
      },
      {
        from: 3,
        // The first output frame also cannot move behind its opening cursor.
        transport: client(() =>
          asyncSequence(
            { type: 'opened', job: row, from: 3 },
            { type: 'output', chunks: [], next: 2 },
            terminal,
          ),
        ),
      },
    ]

    for (const { transport, from } of malformedStreams) {
      await expect(
        (async () => {
          for await (const _frame of new Alpha171JobRepository(transport.client).follow(
            'session-1',
            'job-1',
            from,
          ))
            void _frame
        })(),
      ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    }
  })

  it('rejects a non-terminal status even when followed by a terminal status', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 0 },
        { type: 'status', job: row },
        { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } },
      ),
    )

    await expectMalformedFollow(transport.client)
  })

  it('rejects a terminal status whose total rolls back behind the last output cursor', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 0 },
        { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 },
        {
          type: 'status',
          job: {
            ...row,
            status: 'completed',
            finishedAt: 20,
            output: { total: 2, earliest: 0 },
          },
        },
      ),
    )

    await expectMalformedFollow(transport.client)
  })

  it('rejects an empty output frame that repeats the prior cursor', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 0 },
        { type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 },
        { type: 'output', chunks: [], next: 3 },
        { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } },
      ),
    )

    await expectMalformedFollow(transport.client)
  })

  it('rejects an empty output frame that skips bytes without the lossy marker', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 0 },
        { type: 'output', chunks: [], next: 3 },
        { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } },
      ),
    )

    await expectMalformedFollow(transport.client)
  })

  it('rejects a byte-bearing output frame whose next cursor skips past its last chunk', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 0 },
        { type: 'output', chunks: [{ at: 0, text: 'a' }], next: 5 },
        { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } },
      ),
    )

    await expectMalformedFollow(transport.client)
  })

  it('rejects an unmarked byte gap between output chunks', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 0 },
        {
          type: 'output',
          chunks: [
            { at: 0, text: 'a' },
            { at: 2, text: 'c' },
          ],
          next: 3,
        },
        { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } },
      ),
    )

    await expectMalformedFollow(transport.client)
  })

  it('does not let lossy output mark an internal byte gap', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 0 },
        {
          type: 'output',
          chunks: [
            { at: 0, text: 'a' },
            { at: 2, text: 'c' },
          ],
          next: 3,
          lossy: true,
        },
        { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } },
      ),
    )

    await expectMalformedFollow(transport.client)
  })

  it('rejects an unmarked byte gap before the first returned chunk', async () => {
    const transport = client(() =>
      asyncSequence(
        { type: 'opened', job: row, from: 0 },
        { type: 'output', chunks: [{ at: 2, text: 'c' }], next: 3 },
        { type: 'status', job: { ...row, status: 'completed', finishedAt: 20 } },
      ),
    )

    await expectMalformedFollow(transport.client)
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
