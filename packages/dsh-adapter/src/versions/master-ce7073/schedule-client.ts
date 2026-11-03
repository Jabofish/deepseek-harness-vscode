import { AppError } from '@dsh-vscode/domain'
import { z } from 'zod'
import type { DshTransport } from '../../contracts.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'
import {
  parseMasterScheduleCatalog,
  parseMasterScheduleCreate,
  parseMasterScheduleCreateRequest,
  parseMasterScheduleDeleteInactive,
  parseMasterScheduleDeliveryLimits,
  parseMasterScheduleEdit,
  parseMasterScheduleEditRequest,
  parseMasterScheduleHistory,
  parseMasterScheduleHistoryRequest,
  parseMasterScheduleIdRequest,
  parseMasterScheduleList,
  parseMasterScheduleListRequest,
  parseMasterScheduleRun,
  parseMasterScheduleView,
} from './schedule-contract.js'

export const MASTER_CE7073_COMMIT = 'ce7073d51254c26cd63b22a60835b8f948deb447'
type CreateRequest = ReturnType<typeof parseMasterScheduleCreateRequest>
type EditRequest = ReturnType<typeof parseMasterScheduleEditRequest>
type ListRequest = ReturnType<typeof parseMasterScheduleListRequest>
type HistoryRequest = ReturnType<typeof parseMasterScheduleHistoryRequest>
type IdRequest = ReturnType<typeof parseMasterScheduleIdRequest>

/**
 * Commit-scoped Remote client, deliberately absent from the Adapter registry.
 * The caller must establish source identity and authorise Host-wide reads and
 * mutations before constructing it. A version label is insufficient evidence.
 * DTOs remain inside the Adapter; these are not Webview messages or Domain ports.
 */
export class MasterCe7073ScheduleClient {
  public constructor(
    private readonly transport: DshTransport,
    sourceCommit: string,
  ) {
    if (sourceCommit !== MASTER_CE7073_COMMIT)
      throw new AppError({
        code: 'DSH_INCOMPATIBLE',
        message: 'The Schedule client requires its exact upstream source commit.',
        retryable: false,
      })
  }

  public catalog(signal?: AbortSignal): Promise<ReturnType<typeof parseMasterScheduleCatalog>> {
    return this.invoke('catalog', {}, parseMasterScheduleCatalog, signal)
  }

  public async list(
    request: ListRequest = {},
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseMasterScheduleList>> {
    const args = requestValue(parseMasterScheduleListRequest, request)
    return this.invoke(
      'list',
      args,
      (value) => {
        const page = parseMasterScheduleList(value)
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
  ): Promise<ReturnType<typeof parseMasterScheduleView>> {
    const args = requestValue(parseMasterScheduleIdRequest, request)
    return this.invoke('view', args, (value) => parseMasterScheduleView(value, args.id), signal)
  }

  public async history(
    request: HistoryRequest,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseMasterScheduleHistory>> {
    const args = requestValue(parseMasterScheduleHistoryRequest, request)
    return this.invoke(
      'history',
      args,
      (value) => {
        const page = parseMasterScheduleHistory(value, args.id)
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
  ): Promise<ReturnType<typeof parseMasterScheduleCreate>> {
    return this.invoke(
      'create',
      requestValue(parseMasterScheduleCreateRequest, request),
      parseMasterScheduleCreate,
      signal,
    )
  }

  public async edit(
    request: EditRequest,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseMasterScheduleEdit>> {
    const args = requestValue(parseMasterScheduleEditRequest, request)
    return this.invoke(
      'edit',
      args,
      (value) => {
        const result = parseMasterScheduleEdit(value, args.id)
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
  ): Promise<ReturnType<typeof parseMasterScheduleRun>> {
    const args = requestValue(parseMasterScheduleIdRequest, request)
    return this.invoke('run', args, (value) => parseMasterScheduleRun(value, args.id), signal)
  }

  /** Deletes ended tasks across this Host; paused tasks are retained by upstream. */
  public deleteInactive(signal?: AbortSignal): Promise<ReturnType<typeof parseMasterScheduleDeleteInactive>> {
    return this.invoke('deleteInactive', {}, parseMasterScheduleDeleteInactive, signal)
  }

  public deliveryLimits(signal?: AbortSignal): Promise<ReturnType<typeof parseMasterScheduleDeliveryLimits>> {
    return this.invoke('deliveryLimits', {}, parseMasterScheduleDeliveryLimits, signal)
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
