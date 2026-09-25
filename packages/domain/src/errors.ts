export type AppErrorCode =
  | 'DSH_NOT_FOUND'
  | 'DSH_INCOMPATIBLE'
  | 'BACKEND_UNREACHABLE'
  | 'BACKEND_BUSY'
  | 'NO_RUNNING_INSTANCE'
  | 'PORT_CONFLICT'
  | 'INVALID_ENDPOINT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'STALE_INTERACTION'
  | 'PROCESS_FAILED'
  | 'EXPORT_FAILED'
  | 'PROTOCOL_ERROR'
  | 'REQUEST_CANCELLED'
  | 'INVALID_CONFIGURATION'
  | 'FEATURE_DISABLED'
  | 'CONTEXT_LIMIT'
  | 'CONTEXT_EXPIRED'
  | 'CONTEXT_STALE'
  | 'PATH_NOT_ALLOWED'
  | 'CHANGE_INCOMPLETE'
  | 'CHANGE_PROPOSAL_ONLY'
  | 'CHECKPOINT_CONFLICT'
  | 'CHECKPOINT_PARTIAL'
  | 'CHECKPOINT_QUOTA'
  | 'TASK_NOT_OWNED'
  | 'TASK_STATE_STALE'
  | 'STORAGE_CORRUPT'
  | 'RESOURCE_NOT_OWNED'
  | 'GENERATION_MISMATCH'
  | 'EVENT_GAP'
  | 'PLUGIN_INSTALL_NOT_STARTED'
  | 'INTERNAL_ERROR'

export interface AppErrorDetails {
  readonly code: AppErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly cause?: unknown
  readonly context?: Readonly<Record<string, string | number | boolean>>
}

export class AppError extends Error {
  public readonly code: AppErrorCode
  public readonly retryable: boolean
  public readonly context: Readonly<Record<string, string | number | boolean>> | undefined

  public constructor(details: AppErrorDetails) {
    super(details.message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'AppError'
    this.code = details.code
    this.retryable = details.retryable
    this.context = details.context
  }
}
