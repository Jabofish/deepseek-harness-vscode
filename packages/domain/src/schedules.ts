/** Host-owned scheduled tasks exposed by the pinned DSH Schedule Remote. */

export interface ScheduleBaseRecord {
  readonly id: string
  readonly title: string
  readonly prompt: string
  /** Canonical UTC timestamp selected by the Host. */
  readonly scheduledAt: string
}

export type ScheduleRecord =
  | (ScheduleBaseRecord & { readonly kind: 'at' })
  | (ScheduleBaseRecord & { readonly kind: 'after'; readonly afterSeconds: number })
  | (ScheduleBaseRecord & { readonly kind: 'every'; readonly everySeconds: number })
  | (ScheduleBaseRecord & { readonly kind: 'daily'; readonly time: string; readonly timeZone: string })
  | (ScheduleBaseRecord & {
      readonly kind: 'weekly'
      readonly time: string
      readonly timeZone: string
      /** ISO weekdays, Monday 1 through Sunday 7. */
      readonly weekdays: readonly number[]
    })
  | (ScheduleBaseRecord & {
      readonly kind: 'cron'
      readonly expression: string
      readonly timeZone: string
    })
  | (ScheduleBaseRecord & { readonly kind: 'rrule'; readonly rrule: string })

export type ScheduleTarget =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'new_once'; readonly sessionId: string; readonly agentPreset?: string }
  | { readonly kind: 'new'; readonly agentPreset?: string }

export interface ScheduleDeliveryReceipt {
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly messageId: string
  readonly targetSessionId?: string
}

export interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt {
  /** Older saved receipts may not retain the prompt sent to the Session. */
  readonly prompt?: string
}

export type ScheduleCatalogEntry = ScheduleRecord & {
  /** The Session binding is authoritative and is retained for every mutation. */
  readonly sessionId?: string
  readonly status: 'active' | 'inactive' | 'paused' | 'ended'
  readonly target?: ScheduleTarget
  readonly updatedAt?: string
  readonly workspaceId?: string
  /** Host-only scope evidence. Remove before sending a Webview response. */
  readonly targetWorkingDirectory?: string
  readonly involvedSessionIds?: readonly string[]
  readonly lastDelivery?: ScheduleDeliveryReceipt
}

export interface ScheduleAtInput {
  readonly date: string
  readonly time: string
  readonly timeZone: string
}

export type ScheduleAtValue = string | ScheduleAtInput

export type ScheduleTimingChange =
  | { readonly kind: 'at'; readonly at: ScheduleAtValue }
  | { readonly kind: 'every'; readonly seconds: number }
  | { readonly kind: 'daily'; readonly time: string; readonly timeZone: string }
  | {
      readonly kind: 'weekly'
      readonly time: string
      readonly timeZone: string
      readonly weekdays: readonly number[]
    }
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }
  | { readonly kind: 'rrule'; readonly rrule: string }

export type ScheduleCreateTiming = ScheduleTimingChange | { readonly kind: 'after'; readonly seconds: number }
export interface ScheduleCreateRequest {
  readonly title: string
  readonly prompt: string
  readonly timing: ScheduleCreateTiming
  /** Host-authorised DSH workspace directory; never supplied by the Webview. */
  readonly workingDirectory: string
  readonly targetMode: 'new_once' | 'new'
}
export type ScheduleRunResult =
  | { readonly id: string; readonly admitted: true }
  | {
      readonly id: string
      readonly admitted: false
      readonly code: 'schedule_not_found' | 'schedule_execution_pending' | 'schedule_target_archived'
    }

export const SCHEDULE_INPUT_ERROR_CODES = [
  'invalid_prompt',
  'invalid_selector',
  'invalid_rule',
  'invalid_time_zone',
  'not_future',
  'time_out_of_range',
  'frequency_too_high',
  'subagent_session',
] as const

export interface ScheduleHistoryRequest {
  readonly sessionId?: string
  readonly id: string
  readonly limit: number
  readonly before?: string
}

export interface ScheduleHistoryPage {
  readonly id: string
  readonly records: readonly ScheduleDeliveryRecord[]
  readonly earlierRecordsUnavailable: boolean
  readonly earlierRecordsPruned: boolean
  readonly retention: { readonly days: number; readonly records: number }
  readonly nextBefore?: string
}

export type ScheduleHistoryResult =
  | ScheduleHistoryPage
  | { readonly id: string; readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' }

export interface ScheduleUpdateRequest {
  readonly sessionId?: string
  readonly id: string
  /** Complete rule snapshot captured when the user began editing. */
  readonly expected: ScheduleRecord
  readonly change?: ScheduleTimingChange
  readonly title?: string
  readonly prompt?: string
  readonly expectedUpdatedAt?: string | null
  readonly active?: boolean
}

export type ScheduleMutationFailure =
  | { readonly id: string; readonly code: 'schedule_not_found' }
  | { readonly id: string; readonly code: 'schedule_ended' }
  | { readonly id: string; readonly code: 'schedule_conflict' }
  | {
      readonly code:
        | 'invalid_prompt'
        | 'invalid_selector'
        | 'invalid_rule'
        | 'invalid_time_zone'
        | 'not_future'
        | 'time_out_of_range'
        | 'frequency_too_high'
        | 'subagent_session'
        | 'internal_error'
      readonly message: string
    }

export type ScheduleUpdateResult =
  | { readonly id: string; readonly updated: boolean; readonly record: ScheduleRecord }
  | {
      readonly id: string
      readonly updated: false
      readonly code: 'schedule_not_found' | 'schedule_ended' | 'schedule_conflict'
    }
  | Exclude<ScheduleMutationFailure, { readonly id: string }>

export type ScheduleDeleteResult =
  | { readonly id: string; readonly deleted: true }
  | {
      readonly id: string
      readonly deleted: false
      readonly code: 'schedule_not_found' | 'schedule_conflict'
    }
  | {
      readonly code:
        | 'invalid_prompt'
        | 'invalid_selector'
        | 'invalid_rule'
        | 'invalid_time_zone'
        | 'not_future'
        | 'time_out_of_range'
        | 'frequency_too_high'
        | 'internal_error'
      readonly message: string
    }

/** Domain port for the DSH Host's read, update, and delete Schedule surface. */
export interface ScheduleRepository {
  readonly management?: 'host'
  create?(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry>
  run?(id: string, signal?: AbortSignal): Promise<ScheduleRunResult>
  /** All retained tasks, including inactive tasks, bound to their original Sessions. */
  catalog(signal?: AbortSignal): Promise<readonly ScheduleCatalogEntry[]>
  /** Active tasks for one Session, without activating its Agent. */
  list(sessionId: string, signal?: AbortSignal): Promise<readonly ScheduleRecord[]>
  history(request: ScheduleHistoryRequest, signal?: AbortSignal): Promise<ScheduleHistoryResult>
  update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult>
  delete(
    sessionId: string | undefined,
    id: string,
    signal?: AbortSignal,
    expectedUpdatedAt?: string | null,
  ): Promise<ScheduleDeleteResult>
}
