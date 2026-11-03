import { AppError } from '@dsh-vscode/domain'
import { z } from 'zod'
import type { DshTransport } from '../../contracts.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'
import {
  parseAlpha223ScheduleCatalog,
  parseAlpha223ScheduleCreate,
  parseAlpha223ScheduleCreateRequest,
  parseAlpha223ScheduleDeleteInactive,
  parseAlpha223ScheduleDeliveryLimits,
  parseAlpha223ScheduleEdit,
  parseAlpha223ScheduleEditRequest,
  parseAlpha223ScheduleHistory,
  parseAlpha223ScheduleHistoryRequest,
  parseAlpha223ScheduleIdRequest,
  parseAlpha223ScheduleList,
  parseAlpha223ScheduleListRequest,
  parseAlpha223ScheduleRun,
  parseAlpha223ScheduleView,
} from './schedule-contract.js'

type CreateRequest = ReturnType<typeof parseAlpha223ScheduleCreateRequest>
type EditRequest = ReturnType<typeof parseAlpha223ScheduleEditRequest>
type ListRequest = ReturnType<typeof parseAlpha223ScheduleListRequest>
type HistoryRequest = ReturnType<typeof parseAlpha223ScheduleHistoryRequest>
type IdRequest = ReturnType<typeof parseAlpha223ScheduleIdRequest>

/** Internal Remotes for dsh-v0.2.2-alpha.3. Exact admission belongs to its Adapter. */
export class Alpha223ScheduleClient {
  public constructor(private readonly transport: DshTransport) {}

  public catalog(signal?: AbortSignal): Promise<ReturnType<typeof parseAlpha223ScheduleCatalog>> {
    return this.invoke('catalog', {}, parseAlpha223ScheduleCatalog, signal)
  }

  public async list(
    request: ListRequest = {},
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAlpha223ScheduleList>> {
    const args = requestValue(parseAlpha223ScheduleListRequest, request)
    return this.invoke(
      'list',
      args,
      (value) => {
        const page = parseAlpha223ScheduleList(value)
        if (
          page.limit !== (args.limit ?? 100) ||
          page.offset !== (args.offset ?? 0) ||
          page.items.some((item) => args.active !== undefined && (item.status === 'active') !== args.active)
        )
          throw new Error('Schedule page does not match the request')
        return page
      },
      signal,
    )
  }

  public async view(
    request: IdRequest,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAlpha223ScheduleView>> {
    const args = requestValue(parseAlpha223ScheduleIdRequest, request)
    return this.invoke('view', args, (value) => parseAlpha223ScheduleView(value, args.id), signal)
  }

  public async history(
    request: HistoryRequest,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAlpha223ScheduleHistory>> {
    const args = requestValue(parseAlpha223ScheduleHistoryRequest, request)
    return this.invoke(
      'history',
      args,
      (value) => {
        const page = parseAlpha223ScheduleHistory(value, args.id)
        if (
          'records' in page &&
          (page.records.length > args.limit ||
            page.records.some((record) => record.messageId === args.before) ||
            (page.nextBefore !== undefined &&
              (page.records.length === 0 || page.nextBefore !== page.records.at(-1)?.messageId)))
        )
          throw new Error('Schedule history does not match the request')
        return page
      },
      signal,
    )
  }

  public async create(
    request: CreateRequest,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAlpha223ScheduleCreate>> {
    return this.invoke(
      'create',
      requestValue(parseAlpha223ScheduleCreateRequest, request),
      parseAlpha223ScheduleCreate,
      signal,
    )
  }

  public async edit(
    request: EditRequest,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAlpha223ScheduleEdit>> {
    const args = requestValue(parseAlpha223ScheduleEditRequest, request)
    return this.invoke(
      'edit',
      args,
      (value) => {
        const result = parseAlpha223ScheduleEdit(value, args.id)
        if (
          (args.action === 'update' && 'deleted' in result) ||
          (args.action === 'delete' && 'kind' in result)
        )
          throw new Error('Schedule edit result does not match the action')
        return result
      },
      signal,
    )
  }

  public async run(
    request: IdRequest,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAlpha223ScheduleRun>> {
    const args = requestValue(parseAlpha223ScheduleIdRequest, request)
    return this.invoke('run', args, (value) => parseAlpha223ScheduleRun(value, args.id), signal)
  }

  /** Deletes ended tasks across this Host; paused tasks are retained by upstream. */
  public deleteInactive(
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAlpha223ScheduleDeleteInactive>> {
    return this.invoke('deleteInactive', {}, parseAlpha223ScheduleDeleteInactive, signal)
  }

  public deliveryLimits(
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseAlpha223ScheduleDeliveryLimits>> {
    return this.invoke('deliveryLimits', {}, parseAlpha223ScheduleDeliveryLimits, signal)
  }

  private async invoke<T>(
    method: string,
    args: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted)
      throw new AppError({
        code: 'REQUEST_CANCELLED',
        message: 'The Schedule request was cancelled.',
        retryable: false,
      })
    const endpoint = `schedule/${method}`
    // The transport owns deadlines, abort listeners and connections. Never retry:
    // a lost create/edit/run/delete reply may follow a committed mutation.
    const remoteArgs = ['catalog', 'deleteInactive', 'deliveryLimits'].includes(method)
      ? {}
      : { request: args }
    const response = await this.transport.remoteRequest(endpoint, remoteArgs, signal)
    const failure = scheduleFailure.safeParse(response)
    if (failure.success) {
      const error = failure.data.error
      const wireCode = error.details.wireCode ?? error.code
      if (wireCode === 'schedule/input-invalid') {
        const reason = inputReason.safeParse(error.details.code)
        if (!reason.success) throw malformed(endpoint)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'DSH rejected the Schedule input.',
          retryable: false,
          context: { rpcMethod: endpoint, scheduleReason: reason.data },
        })
      }
      if (wireCode === 'schedule/target-archived') {
        if (typeof error.details.sessionId !== 'string' || error.details.sessionId.trim() === '')
          throw malformed(endpoint)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The Schedule target session is archived.',
          retryable: false,
          context: { rpcMethod: endpoint, scheduleReason: 'target-archived' },
        })
      }
    }
    const value = unwrapRpcResultValue<unknown>(response, endpoint)
    try {
      return parse(value)
    } catch {
      throw malformed(endpoint)
    }
  }
}

const inputReason = z.enum([
  'invalid_prompt',
  'invalid_selector',
  'invalid_rule',
  'invalid_time_zone',
  'not_future',
  'time_out_of_range',
  'frequency_too_high',
  'subagent_session',
])
const scheduleFailure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    details: z.object({
      wireCode: z.string().optional(),
      code: z.unknown().optional(),
      sessionId: z.unknown().optional(),
    }),
  }),
})

function requestValue<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value)
  } catch {
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'Invalid Schedule request.',
      retryable: false,
    })
  }
}

function malformed(method: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed Schedule response.',
    retryable: false,
    context: { rpcMethod: method },
  })
}
