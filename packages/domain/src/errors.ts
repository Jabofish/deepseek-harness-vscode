export type AppErrorCode =
  | 'DSH_NOT_FOUND'
  | 'DSH_INCOMPATIBLE'
  | 'BACKEND_UNREACHABLE'
  | 'BACKEND_BUSY'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'PROTOCOL_ERROR'
  | 'REQUEST_CANCELLED'
  | 'INVALID_CONFIGURATION'
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
