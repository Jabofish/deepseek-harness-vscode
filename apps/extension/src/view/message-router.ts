import { AppError } from '@dsh-vscode/domain'
import { RUNTIME_INSTALL_FAILURE_MESSAGES } from '../vscode/runtime-installation.js'
import { redactText } from '@dsh-vscode/dsh-adapter'
import {
  MAX_HOST_ERROR_MESSAGE_CHARS,
  hostMessageSchema,
  protocolAppErrorCodeSchema,
  protocolValueWithinBudget,
  featureHostMessageSchema,
  featureWebviewEnvelopeSchema,
  webviewEnvelopeSchema,
  type FeatureHostMessage,
  type FeatureRequest,
  type HostMessage,
  type WebviewRequest,
} from '@dsh-vscode/webview-protocol'

export interface UnexpectedErrorEntry {
  readonly requestType: string
  readonly name: string
  readonly message: string
  readonly stack?: string
}

export interface MessageRouterDependencies {
  /**
   * Deliver a message to one surface. `surfaceId` is the surface that owns the
   * request; `undefined` means the caller has no surface identity (broadcast).
   * One router serves every surface, so the answer must travel back to the
   * Webview that asked instead of the first one that happens to be open.
   */
  readonly postMessage: (
    message: HostMessage | FeatureHostMessage,
    surfaceId: string | undefined,
  ) => Thenable<boolean>
  readonly handleRequest?: (
    request: WebviewRequest,
    signal: AbortSignal,
    surfaceId: string | undefined,
  ) => Promise<unknown>
  readonly handleFeatureRequest?: (request: FeatureRequest, signal: AbortSignal) => Promise<unknown>
  /**
   * Non-AppError handler failures are reduced to a generic INTERNAL_ERROR for
   * the Webview; this hook keeps the redacted cause reachable in the host
   * diagnostics channel instead of losing it entirely.
   */
  readonly logUnexpectedError?: (entry: UnexpectedErrorEntry) => void
}

interface InFlightRequest {
  readonly controller: AbortController
  readonly kind: 'request' | 'cancellation'
  /** The surface that sent this request; its terminal response goes back here. */
  readonly surfaceId: string | undefined
  phase: 'running' | 'responding'
}

interface QuestionWaitRoute {
  readonly key: string
  /** The surface that attached the wait; its own teardown releases the wait. */
  readonly surfaceId: string | undefined
  readonly lifetime: AbortController
  readonly signal: AbortSignal
  unlinkRequest?: () => void
  unlink?: () => void
}

export class WebviewMessageRouter {
  private readonly inFlight = new Map<string, InFlightRequest>()
  private readonly questionWaits = new Map<string, Set<QuestionWaitRoute>>()

  public constructor(private readonly dependencies: MessageRouterDependencies) {}

  public async handle(rawMessage: unknown, surfaceId?: string): Promise<void> {
    // An invalid envelope has no trustworthy correlation id. Never answer it
    // with a fabricated id such as "invalid": that could settle an unrelated
    // live request which happens to use the same id.
    if (!protocolValueWithinBudget(rawMessage)) return
    const legacy = webviewEnvelopeSchema.safeParse(rawMessage)
    const feature = featureWebviewEnvelopeSchema.safeParse(rawMessage)
    if (!legacy.success && !feature.success) return
    const isFeature = feature.success && !legacy.success
    const request = (isFeature ? feature.data.message : legacy.success ? legacy.data.message : undefined) as
      WebviewRequest | FeatureRequest
    // Once a request id is occupied, a second envelope cannot be answered
    // independently: both responses would target the same Webview promise.
    // Ignore the duplicate and preserve the original operation's ownership.
    const operationKey = requestKey(surfaceId, request.requestId)
    if (this.inFlight.has(operationKey)) return
    const operation: InFlightRequest = {
      controller: new AbortController(),
      kind: isFeature && request.type === 'feature.request.cancel' ? 'cancellation' : 'request',
      surfaceId,
      phase: 'running',
    }
    this.inFlight.set(operationKey, operation)
    if (isFeature && request.type === 'feature.request.cancel') {
      const target =
        request.payload.targetRequestId === request.requestId
          ? undefined
          : this.inFlight.get(requestKey(surfaceId, request.payload.targetRequestId))
      const accepted =
        target !== undefined &&
        target.kind === 'request' &&
        target.phase === 'running' &&
        !target.controller.signal.aborted
      if (accepted) target.controller.abort()
      await this.complete(
        operationKey,
        operation,
        request.type,
        response(
          request.requestId,
          true,
          {
            kind: 'operation',
            operationId: request.payload.targetRequestId,
            state: accepted ? 'accepted' : 'rejected',
            ...(accepted ? {} : { message: 'The target request is no longer running.' }),
          },
          undefined,
          true,
        ),
      )
      return
    }
    // A wait belongs to the surface that attached it: another surface closing
    // or releasing the same session/call must not cancel a question the user is
    // still looking at.
    if (isFeature && request.type === 'user-question.wait.release')
      this.abortQuestionWait(questionWaitKey(surfaceId, request.payload.sessionId, request.payload.callId))

    const waitRoute =
      isFeature && request.type === 'user-question.wait.attach'
        ? this.beginQuestionWait(
            surfaceId,
            request.payload.sessionId,
            request.payload.callId,
            operation.controller,
          )
        : undefined
    try {
      const payload = isFeature
        ? this.dependencies.handleFeatureRequest === undefined
          ? routeNotEnabled('The staged feature route is not enabled.')
          : await this.dependencies.handleFeatureRequest(
              request as FeatureRequest,
              waitRoute?.signal ?? operation.controller.signal,
            )
        : this.dependencies.handleRequest === undefined
          ? routeNotEnabled('The Webview request route is not enabled.')
          : await this.dependencies.handleRequest(
              request as WebviewRequest,
              operation.controller.signal,
              surfaceId,
            )
      const delivered = await this.complete(
        operationKey,
        operation,
        request.type,
        response(request.requestId, true, payload, undefined, isFeature),
      )
      if (waitRoute !== undefined) {
        if (delivered && isQuestionWaitActive(payload)) waitRoute.unlinkRequest?.()
        else {
          waitRoute.unlink?.()
          this.abortQuestionWait(waitRoute.key, waitRoute.lifetime)
        }
      }
    } catch (error) {
      if (waitRoute !== undefined) {
        waitRoute.unlink?.()
        this.abortQuestionWait(waitRoute.key, waitRoute.lifetime)
      }
      if (!(error instanceof AppError)) this.reportUnexpectedError(unexpectedErrorEntry(request.type, error))
      await this.complete(
        operationKey,
        operation,
        request.type,
        response(request.requestId, false, undefined, publicError(error, request.type), isFeature),
      )
    }
  }

  public cancelAll(): void {
    for (const operation of this.inFlight.values())
      if (operation.kind === 'request' && operation.phase === 'running') operation.controller.abort()
    this.inFlight.clear()
    for (const routes of this.questionWaits.values()) for (const route of [...routes]) route.lifetime.abort()
    this.questionWaits.clear()
  }

  /**
   * One surface went away (its view was re-resolved, its panel was closed).
   * Only that surface's operations are cancelled: another surface's in-flight
   * request, question wait, or job follow must survive.
   */
  public cancelSurface(surfaceId: string): void {
    for (const [requestId, operation] of [...this.inFlight]) {
      if (operation.surfaceId !== surfaceId) continue
      if (operation.kind === 'request' && operation.phase === 'running') operation.controller.abort()
      this.inFlight.delete(requestId)
    }
    this.cancelSurfaceQuestionWaits(surfaceId)
  }

  private beginQuestionWait(
    surfaceId: string | undefined,
    sessionId: string,
    callId: string,
    request: AbortController,
  ): QuestionWaitRoute {
    const key = questionWaitKey(surfaceId, sessionId, callId)
    const lifetime = new AbortController()
    const route: QuestionWaitRoute = {
      key,
      surfaceId,
      lifetime,
      signal: lifetime.signal,
    }
    const routes = this.questionWaits.get(key) ?? new Set<QuestionWaitRoute>()
    routes.add(route)
    this.questionWaits.set(key, routes)
    const abortLifetime = (): void => {
      request.signal.removeEventListener('abort', abortRequest)
      routes.delete(route)
      if (routes.size === 0 && this.questionWaits.get(key) === routes) this.questionWaits.delete(key)
    }
    const abortRequest = (): void => lifetime.abort(request.signal.reason)
    lifetime.signal.addEventListener('abort', abortLifetime, { once: true })
    request.signal.addEventListener('abort', abortRequest, { once: true })
    if (lifetime.signal.aborted) abortLifetime()
    if (request.signal.aborted) abortRequest()
    route.unlinkRequest = () => request.signal.removeEventListener('abort', abortRequest)
    route.unlink = () => {
      lifetime.signal.removeEventListener('abort', abortLifetime)
      request.signal.removeEventListener('abort', abortRequest)
    }
    return route
  }

  private abortQuestionWait(key: string, expected?: AbortController): void {
    const routes = this.questionWaits.get(key)
    if (routes === undefined) return
    if (expected !== undefined) {
      const route = [...routes].find((entry) => entry.lifetime === expected)
      if (route === undefined) return
      routes.delete(route)
      route.lifetime.abort()
    } else {
      this.questionWaits.delete(key)
      for (const route of [...routes]) route.lifetime.abort()
    }
    if (routes.size === 0 && this.questionWaits.get(key) === routes) this.questionWaits.delete(key)
  }

  /**
   * A question wait outlives the request that attached it, so cancelling a
   * surface has to release the waits that surface owns; another surface's
   * pending question must stay answerable.
   */
  private cancelSurfaceQuestionWaits(surfaceId: string): void {
    for (const [key, routes] of [...this.questionWaits]) {
      for (const route of [...routes]) {
        if (route.surfaceId !== surfaceId) continue
        routes.delete(route)
        route.lifetime.abort()
      }
      if (routes.size === 0 && this.questionWaits.get(key) === routes) this.questionWaits.delete(key)
    }
  }

  private async complete(
    operationKey: string,
    operation: InFlightRequest,
    requestType: string,
    message: HostMessage | FeatureHostMessage,
  ): Promise<boolean> {
    if (this.inFlight.get(operationKey) !== operation) return false
    operation.phase = 'responding'
    try {
      // Route the terminal answer back to the surface that asked for it.
      const delivered = await this.dependencies.postMessage(message, operation.surfaceId)
      if (!delivered) throw new Error('The Webview did not accept the response.')
      return true
    } catch (error) {
      // Keep the id occupied until its terminal response has been accepted or
      // refused, so a duplicate cannot race the original response in transit.
      this.reportUnexpectedError(unexpectedErrorEntry(requestType, error))
      return false
    } finally {
      if (this.inFlight.get(operationKey) === operation) this.inFlight.delete(operationKey)
    }
  }

  private reportUnexpectedError(entry: UnexpectedErrorEntry): void {
    try {
      this.dependencies.logUnexpectedError?.(entry)
    } catch {
      // Diagnostics are best effort. A broken output-channel adapter must not
      // suppress the protocol response or create a second unhandled rejection.
    }
  }
}

/**
 * A request the host cannot dispatch must fail. Answering `{accepted:true}`
 * would report work that never happened, and the Webview would render a
 * success it can neither observe nor retry.
 */
function routeNotEnabled(message: string): never {
  throw new AppError({ code: 'FEATURE_DISABLED', message, retryable: false })
}

/** An empty failure text tells the user nothing; the code still names the class. */
const UNSHAPED_ERROR_MESSAGE = 'The DSH request failed without a describable reason.'

function response(
  requestId: string,
  ok: boolean,
  payload?: unknown,
  error?: { code: string; message: string; retryable: boolean },
  feature = false,
): HostMessage | FeatureHostMessage {
  const candidate = {
    type: feature ? ('feature.response' as const) : ('response' as const),
    requestId,
    ok,
    ...(payload === undefined ? {} : { payload }),
    ...(error === undefined ? {} : { error }),
  }
  const schema = feature ? featureHostMessageSchema : hostMessageSchema
  const parsed = schema.safeParse(candidate)
  if (parsed.success) return parsed.data
  // A failure must still reach the Webview inside the wire budget. Host-supplied
  // text (an RPC error code, a method name) is appended to the message, so an
  // unrepresentable error used to throw out of the response path: the request
  // stayed unanswered until the client's own timeout and the real cause lived
  // only in the host log. Keep the code — the Webview maps it to its own text —
  // and bound the free text.
  if (!ok) {
    const known = protocolAppErrorCodeSchema.safeParse(error?.code)
    return schema.parse({
      type: feature ? ('feature.response' as const) : ('response' as const),
      requestId,
      ok: false as const,
      error: {
        code: known.success ? known.data : 'PROTOCOL_ERROR',
        message: (error?.message ?? '').slice(0, MAX_HOST_ERROR_MESSAGE_CHARS) || UNSHAPED_ERROR_MESSAGE,
        retryable: error?.retryable === true,
      },
    })
  }
  // A large historical transcript must never turn the response path itself
  // into an uncaught host exception. The adapter compacts streaming chunks,
  // but keep a precise protocol-level fallback for unusually large payloads.
  return schema.parse({
    type: feature ? 'feature.response' : 'response',
    requestId,
    ok: false,
    error: {
      code: 'PROTOCOL_ERROR',
      message: 'The DSH response exceeded the Webview protocol budget.',
      retryable: false,
    },
  })
}

function publicError(
  error: unknown,
  requestType: string,
): { code: string; message: string; retryable: boolean } {
  if (error instanceof AppError)
    return {
      code: error.code,
      message: publicErrorMessage(error.code, error.message, error.context, requestType),
      retryable: error.retryable,
    }
  return {
    code: 'INTERNAL_ERROR',
    message:
      requestType === 'session.open'
        ? 'Unable to open this DSH session: an unexpected host error occurred. Open DSH diagnostics for the redacted failure details.'
        : `Unable to complete ${requestType}: an unexpected host error occurred. Open DSH diagnostics for the redacted failure details.`,
    retryable: true,
  }
}

function questionWaitKey(surfaceId: string | undefined, sessionId: string, callId: string): string {
  return JSON.stringify([surfaceId ?? null, sessionId, callId])
}

function isQuestionWaitActive(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return result.kind === 'question.wait' && typeof result.remainingMs === 'number'
}

/** Bound and redact an unexpected failure for the diagnostics channel. */
function unexpectedErrorEntry(requestType: string, error: unknown): UnexpectedErrorEntry {
  const name = error instanceof Error ? error.name : typeof error
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = safeCommandDiagnostic(rawMessage) ?? ''
  const entry: UnexpectedErrorEntry = { requestType, name: name.slice(0, 128), message }
  if (error instanceof Error && typeof error.stack === 'string') {
    const stack = error.stack
      .split('\n')
      .slice(0, 8)
      .map((line) => safeCommandDiagnostic(line) ?? '')
      .join('\n')
    if (stack !== '') return { ...entry, stack: stack.slice(0, 2_048) }
  }
  return entry
}

function publicErrorMessage(
  code: string,
  message: string,
  context: Readonly<Record<string, string | number | boolean>> | undefined,
  requestType: string,
): string {
  if (requestType === 'runtime.action') {
    if (context?.operation === 'runtime.install') {
      const reason = context.reason
      if (reason === 'node-version')
        return 'DSH installation requires Node.js 22.19.0 or newer in the Extension Host.'
      if (reason === 'npm-not-found')
        return 'npm was not found in the Extension Host environment. Copy the install command or open a terminal.'
      if (reason === 'verify-failed')
        return 'DSH installation finished, but the installed executable could not be verified. Check the runtime path.'
      if (reason === 'install-failed')
        return (
          installationFailureMessage(message) ??
          'The DSH installation command failed. Check the install output and try again.'
        )
    }
    if (context?.operation === 'runtime.select' && context.reason === 'invalid-executable')
      return 'The selected file is not a supported DeepSeek Harness executable.'
  }
  if (requestType === 'runtime.update.install' || requestType === 'runtime.update.check') {
    if (context?.operation === 'runtime.update') {
      const reason = context.reason
      if (reason === 'node-version')
        return 'DSH installation requires Node.js 22.19.0 or newer in the Extension Host.'
      if (reason === 'npm-not-found')
        return 'npm was not found in the Extension Host environment. Copy the install command or open a terminal.'
      if (reason === 'invalid-version') return 'Select an exact DSH version from the upstream version list.'
      if (reason === 'metadata-unavailable')
        return withRuntimeUpdateDetail(
          'The selected DSH version could not be verified against the upstream registry.',
          context.detail,
        )
      if (reason === 'verify-failed')
        return withRuntimeUpdateDetail(
          'DSH installation finished, but the selected global version could not be verified.',
          context.detail,
        )
      if (reason === 'install-failed')
        return (
          installationFailureMessage(message) ??
          withRuntimeUpdateDetail(
            'The selected DSH version could not be installed. Check the npm output and try again.',
            context.detail,
          )
        )
    }
  }
  const fallback: Record<string, string> = {
    DSH_NOT_FOUND: 'DeepSeek Harness was not found.',
    DSH_INCOMPATIBLE: 'The installed DeepSeek Harness version is not supported.',
    BACKEND_UNREACHABLE: 'The local DSH instance is unreachable.',
    BACKEND_BUSY: 'The DSH instance is busy.',
    NO_RUNNING_INSTANCE: 'No compatible local DSH instance is running.',
    PORT_CONFLICT: 'The configured DSH port is already in use.',
    INVALID_ENDPOINT: 'Only a validated local DSH endpoint is allowed.',
    CAPABILITY_UNAVAILABLE: 'This DSH capability is unavailable.',
    AUTH_REQUIRED: 'The selected DSH model or provider is unavailable.',
    PERMISSION_DENIED: 'The operation is not permitted.',
    STALE_INTERACTION: 'The DSH interaction is no longer pending.',
    PROCESS_FAILED: 'The managed DSH process failed.',
    EXPORT_FAILED: 'The session export failed.',
    PROTOCOL_ERROR: 'The DSH returned an invalid response.',
    REQUEST_CANCELLED: 'The DSH request was cancelled.',
    INVALID_CONFIGURATION: 'The DSH configuration is invalid.',
    FEATURE_DISABLED: 'This feature is not enabled for the connected DSH instance.',
    CONTEXT_LIMIT: 'The editor context is too large.',
    CONTEXT_EXPIRED: 'The editor context has expired. Capture it again.',
    CONTEXT_STALE: 'The editor context is stale. Refresh it before continuing.',
    PATH_NOT_ALLOWED: 'Only a validated workspace-relative path is allowed.',
    CHANGE_INCOMPLETE: 'The change record is incomplete and cannot be applied safely.',
    CHANGE_PROPOSAL_ONLY: 'This change is only a proposal; no filesystem mutation was confirmed.',
    CHECKPOINT_CONFLICT: 'The workspace changed after this checkpoint was created.',
    CHECKPOINT_PARTIAL: 'The checkpoint restore completed only partially.',
    CHECKPOINT_QUOTA: 'The checkpoint storage quota has been reached.',
    TASK_NOT_OWNED: 'This task is not owned by the current extension session.',
    TASK_STATE_STALE: 'The task changed before this action was applied. Refresh it and try again.',
    STORAGE_CORRUPT: 'The local feature storage is corrupt and needs recovery.',
    RESOURCE_NOT_OWNED: 'This resource is not owned by the current view or session.',
    GENERATION_MISMATCH: 'This request belongs to an older connection generation.',
    EVENT_GAP: 'Some DSH events were missed; the session is being synchronized.',
    PLUGIN_INSTALL_NOT_STARTED:
      'The DSH plugin installation did not start. Review the package source and try again.',
    INTERNAL_ERROR: 'DSH returned an internal error.',
  }
  const base = fallback[code] ?? `DSH operation failed (${code}).`
  if (requestType === 'command.execute') return withFailureDetail(base, context, message)
  // Settings and model configuration failures are actionable in the drawer.
  // Keep the same bounded/redacted diagnostic used for commands; otherwise a
  // native opener failure or a schema rejection is reduced to the unhelpful
  // "internal error" text and the user has no way to locate the fault.
  // Prompt templates and checkpoints fail for authored reasons the fallback
  // cannot name — an undeclared `{{variable}}`, a file too large to snapshot —
  // and the code's generic text ("the configuration is invalid", "the storage
  // quota has been reached") points at the wrong cause.
  if (
    requestType.startsWith('settings.') ||
    requestType.startsWith('models.') ||
    requestType.startsWith('provider.') ||
    requestType.startsWith('prompt.') ||
    requestType.startsWith('checkpoint.')
  )
    return withFailureDetail(base, context, message, 'DSH detail: ')
  // Attaching a file and sending it are rejected for reasons the user can act
  // on (unsupported type, byte limit, host-side image limits). Without the
  // cause they only read the code fallback and cannot tell what to change.
  if (requestType.startsWith('attachment.') || MESSAGE_ATTACHMENT_REQUESTS.has(requestType))
    return withFailureDetail(base, context, message)
  // Answering a timed question fails for reasons the user can act on: the call
  // is no longer answerable, or DSH already holds a reply. The code's fallback
  // ("the interaction is no longer pending") cannot say which, nor whether the
  // composed batch was recorded, so the bounded cause must reach the card.
  if (requestType === 'user-question.answer') return withFailureDetail(base, context, message)
  if (requestType === 'session.open' || context?.operation === 'session.open') {
    const stage = typeof context?.stage === 'string' ? context.stage : 'session open'
    const rpcCode = typeof context?.rpcCode === 'string' ? context.rpcCode : undefined
    const rpcSuffix = rpcCode === undefined ? '' : ` DSH code: ${rpcCode}.`
    return `Unable to open this DSH session during ${stage}. ${base}${rpcSuffix}`
  }
  return base
}

/** Requests whose failure is explained by the prompt's own attachments. */
const MESSAGE_ATTACHMENT_REQUESTS = new Set(['session.sendPrompt', 'subagent.send'])

/**
 * Append the bounded, redacted cause (and RPC identity when present) so the
 * Webview can name the real fault instead of only the code's fallback text.
 */
function withFailureDetail(
  base: string,
  context: Readonly<Record<string, string | number | boolean>> | undefined,
  message: string,
  detailLabel = '',
): string {
  const method = typeof context?.rpcMethod === 'string' ? context.rpcMethod : undefined
  const rpcCode = typeof context?.rpcCode === 'string' ? context.rpcCode : undefined
  const diagnostic = safeCommandDiagnostic(message)
  const suffix = [
    method === undefined ? undefined : `DSH method: ${method}.`,
    rpcCode === undefined ? undefined : `DSH code: ${rpcCode}.`,
    diagnostic === undefined || diagnostic === base
      ? undefined
      : diagnostic.startsWith(`${base} `)
        ? diagnostic.slice(base.length + 1)
        : `${detailLabel}${diagnostic}`,
  ].filter((entry): entry is string => entry !== undefined)
  return suffix.length === 0 ? base : `${base} ${suffix.join(' ')}`
}

/** Command failures are actionable in the composer, so retain a bounded, redacted diagnostic. */
function safeCommandDiagnostic(message: string): string | undefined {
  const redacted = redactText(message, 320)
  return redacted === '' ? undefined : redacted
}

function withRuntimeUpdateDetail(base: string, value: string | number | boolean | undefined): string {
  if (typeof value !== 'string') return base
  const detail = safeCommandDiagnostic(value)
  return detail === undefined ? base : `${base} Detail: ${detail}`
}

/** Only authored failure summaries may cross the boundary, never npm output. */
function installationFailureMessage(message: string): string | undefined {
  return Object.values(RUNTIME_INSTALL_FAILURE_MESSAGES).find((allowed) => allowed === message)
}

/** Correlation ids are local to a Webview, never global Host authority. */
function requestKey(surfaceId: string | undefined, requestId: string): string {
  return JSON.stringify([surfaceId ?? null, requestId])
}
