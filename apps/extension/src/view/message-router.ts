import { AppError } from '@dsh-vscode/domain'
import {
  hostMessageSchema,
  protocolValueWithinBudget,
  webviewEnvelopeSchema,
  type HostMessage,
  type WebviewRequest,
} from '@dsh-vscode/webview-protocol'

export interface MessageRouterDependencies {
  readonly postMessage: (message: HostMessage) => Thenable<boolean>
  readonly handleRequest?: (request: WebviewRequest, signal: AbortSignal) => Promise<unknown>
}

export class WebviewMessageRouter {
  private readonly inFlight = new Map<string, AbortController>()

  public constructor(private readonly dependencies: MessageRouterDependencies) {}

  public async handle(rawMessage: unknown): Promise<void> {
    if (!protocolValueWithinBudget(rawMessage)) {
      await this.postError('invalid', 'The Webview request exceeds the protocol limits.', false)
      return
    }
    const parsed = webviewEnvelopeSchema.safeParse(rawMessage)
    if (!parsed.success) {
      await this.postError('invalid', 'Invalid Webview request.', false)
      return
    }
    const request = parsed.data.message
    if (this.inFlight.has(request.requestId)) {
      await this.postError(request.requestId, 'A request with this id is already running.', true)
      return
    }
    const controller = new AbortController()
    this.inFlight.set(request.requestId, controller)
    try {
      const payload =
        this.dependencies.handleRequest === undefined
          ? { accepted: true }
          : await this.dependencies.handleRequest(request, controller.signal)
      this.complete(request, response(request.requestId, true, payload))
    } catch (error) {
      this.complete(request, response(request.requestId, false, undefined, publicError(error, request.type)))
    }
  }

  public cancelAll(): void {
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
  }

  private complete(request: WebviewRequest, message: HostMessage): void {
    if (!this.inFlight.delete(request.requestId)) return
    void this.dependencies.postMessage(message)
  }

  private async postError(requestId: string, message: string, retryable: boolean): Promise<void> {
    const value = response(requestId, false, undefined, { code: 'PROTOCOL_ERROR', message, retryable })
    await this.dependencies.postMessage(value)
  }
}

function response(
  requestId: string,
  ok: boolean,
  payload?: unknown,
  error?: { code: string; message: string; retryable: boolean },
): HostMessage {
  const candidate = {
    type: 'response' as const,
    requestId,
    ok,
    ...(payload === undefined ? {} : { payload }),
    ...(error === undefined ? {} : { error }),
  }
  const parsed = hostMessageSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  // A large historical transcript must never turn the response path itself
  // into an uncaught host exception. The adapter compacts streaming chunks,
  // but keep a precise protocol-level fallback for unusually large payloads.
  if (!ok) return hostMessageSchema.parse(candidate)
  return hostMessageSchema.parse({
    type: 'response',
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
        return 'The DSH installation command failed. Check the install output and try again.'
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
        return 'The selected DSH version could not be verified against the upstream registry.'
      if (reason === 'verify-failed')
        return 'DSH installation finished, but the selected global version could not be verified.'
      if (reason === 'install-failed')
        return 'The selected DSH version could not be installed. Check the npm output and try again.'
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
    INTERNAL_ERROR: 'DSH returned an internal error.',
  }
  const base = fallback[code] ?? `DSH operation failed (${code}).`
  if (requestType === 'command.execute') {
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
          : diagnostic,
    ].filter((entry): entry is string => entry !== undefined)
    return suffix.length === 0 ? base : `${base} ${suffix.join(' ')}`
  }
  // Settings and model configuration failures are actionable in the drawer.
  // Keep the same bounded/redacted diagnostic used for commands; otherwise a
  // native opener failure or a schema rejection is reduced to the unhelpful
  // "internal error" text and the user has no way to locate the fault.
  if (
    requestType.startsWith('settings.') ||
    requestType.startsWith('models.') ||
    requestType.startsWith('provider.')
  ) {
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
          : `DSH detail: ${diagnostic}`,
    ].filter((entry): entry is string => entry !== undefined)
    return suffix.length === 0 ? base : `${base} ${suffix.join(' ')}`
  }
  if (requestType === 'session.open' || context?.operation === 'session.open') {
    const stage = typeof context?.stage === 'string' ? context.stage : 'session open'
    const rpcCode = typeof context?.rpcCode === 'string' ? context.rpcCode : undefined
    const rpcSuffix = rpcCode === undefined ? '' : ` DSH code: ${rpcCode}.`
    return `Unable to open this DSH session during ${stage}. ${base}${rpcSuffix}`
  }
  return base
}

/** Command failures are actionable in the composer, so retain a bounded, redacted diagnostic. */
function safeCommandDiagnostic(message: string): string | undefined {
  const compact = message.replace(/\s+/gu, ' ').trim()
  if (compact === '') return undefined
  const redacted = compact.replace(
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|private[_ -]?key|token|prompt|body|response)\b\s*[:=]\s*[^\s,;]+/giu,
    (match) => match.replace(/[:=].*$/u, ': [redacted]'),
  )
  return redacted.slice(0, 320)
}
