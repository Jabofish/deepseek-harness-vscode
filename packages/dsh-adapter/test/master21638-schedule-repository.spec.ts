import { describe, expect, it } from 'vitest'

import { AppError, type ScheduleRecord, type ScheduleRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
import { Master21638ScheduleRepository } from '../src/versions/master21638/schedule-repository.js'
import { normalizeRc172ErrorCode } from '../src/versions/rc172/error-vocabulary.js'
import { unwrapRpcResultValue } from '../src/versions/rc6/rpc.js'

const record: ScheduleRecord = {
  id: 'schedule-1',
  kind: 'at',
  title: 'Reminder',
  prompt: '[redacted prompt]',
  scheduledAt: '2026-10-02T09:00:00.000Z',
}

interface ScheduleOperation {
  readonly method: string
  readonly invoke: (repository: ScheduleRepository, signal?: AbortSignal) => Promise<unknown>
}

const operations: readonly ScheduleOperation[] = [
  { method: 'schedule/catalog', invoke: (repository, signal) => repository.catalog(signal) },
  { method: 'schedule/list', invoke: (repository, signal) => repository.list('session-1', signal) },
  {
    method: 'schedule/history',
    invoke: (repository, signal) =>
      repository.history({ sessionId: 'session-1', id: record.id, limit: 20 }, signal),
  },
  {
    method: 'schedule/update',
    invoke: (repository, signal) =>
      repository.update(
        { sessionId: 'session-1', id: record.id, expected: record, title: 'Updated' },
        signal,
      ),
  },
  {
    method: 'schedule/delete',
    invoke: (repository, signal) => repository.delete('session-1', record.id, signal),
  },
]

function remoteFailureTransport(sourceCode: string, signalFailure?: AppError): DshTransport {
  const normalizedCode = normalizeRc172ErrorCode(sourceCode, {})
  return {
    request: <TResponse>() => Promise.reject<TResponse>(new Error('Schedule test issued no ordinary RPC')),
    remoteRequest: <TResponse>(
      _endpoint: string,
      _args: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<TResponse> => {
      if (signal?.aborted)
        return Promise.reject<TResponse>(
          signalFailure ??
            new AppError({
              code: 'REQUEST_CANCELLED',
              message: 'The Schedule request was cancelled.',
              retryable: false,
            }),
        )
      return Promise.resolve({
        ok: false,
        error: {
          code: normalizedCode,
          message: 'The optional Schedule Remote is unavailable.',
          details: {},
        },
      } as TResponse)
    },
    openEventStream: async function* () {
      /* Schedule Remotes do not create event streams. */
    },
    close: () => Promise.resolve(),
  }
}

describe('DSH master temporary Schedule Remote capability mapping', () => {
  for (const operation of operations) {
    it(`maps ${operation.method} withdrawn by the optional bundle to capability unavailable`, async () => {
      const repository = new Master21638ScheduleRepository(
        remoteFailureTransport('gateway/definition-unavailable'),
      )

      await expect(operation.invoke(repository)).rejects.toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'This DSH host does not expose Schedule in its current configuration.',
        retryable: false,
        context: {
          capability: 'schedule',
          rpcMethod: operation.method,
          rpcCode: 'unknown-command',
        },
      })
    })
  }

  it('keeps other Gateway failures and cancellation errors unchanged', async () => {
    const gatewayFailure = new Master21638ScheduleRepository(remoteFailureTransport('gateway/internal'))
    await expect(gatewayFailure.catalog()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      context: { rpcMethod: 'schedule/catalog', rpcCode: 'internal' },
    })

    const cancelled = new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The request was cancelled.',
      retryable: false,
    })
    const cancellation = new Master21638ScheduleRepository(
      remoteFailureTransport('gateway/definition-unavailable', cancelled),
    )
    const controller = new AbortController()
    controller.abort()
    await expect(cancellation.catalog(controller.signal)).rejects.toBe(cancelled)
  })

  it('leaves unknown-command classification for non-Schedule Remotes unchanged', async () => {
    const remoteError = {
      ok: false,
      error: {
        code: normalizeRc172ErrorCode('gateway/definition-unavailable', {}),
        message: 'The strict definition was withdrawn.',
        details: {},
      },
    }

    await expect(
      Promise.resolve().then(() => unwrapRpcResultValue(remoteError, 'session/list')),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      context: { rpcMethod: 'session/list', rpcCode: 'unknown-command' },
    })
  })
})
