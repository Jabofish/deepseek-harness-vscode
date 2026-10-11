import { AppError } from '@dsh-vscode/domain'

/** Exhaustiveness at compile time, and an explicit refusal if a contract drifts at runtime. */
export function unsupportedRequest(_request: never): never {
  throw new AppError({
    code: 'FEATURE_DISABLED',
    message: 'The Webview request has no host route in this extension build.',
    retryable: false,
  })
}
