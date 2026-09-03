import { AppError } from '@dsh-vscode/domain'
import type * as vscode from 'vscode'

const LEGAL_API_KEY = /^[\x21-\x7E]+$/u
const ENVIRONMENT_ASSIGNMENT = /^[A-Z][A-Z0-9_]*=[^=]/u

export function requestProviderSecret(
  window: typeof vscode.window,
  provider: string,
  field: string,
): Promise<string | undefined> {
  return Promise.resolve(
    window.showInputBox({
      title: `Configure ${provider} credential`,
      prompt: `${field} is sent directly to the local DSH credential service.`,
      password: true,
      ignoreFocusOut: true,
    }),
  )
}

/**
 * Collect an optional provider key for a custom route or one-off discovery.
 * The value is consumed only by the Host/DSH call; it is never placed in a
 * Webview request or response. An empty input (and the native input-box
 * cancel result) means that the provider's ambient authentication may be
 * used.
 */
export async function requestOptionalProviderApiKey(
  window: typeof vscode.window,
  provider: string,
): Promise<string | undefined> {
  const value = await window.showInputBox({
    title: `Configure ${provider} API key (optional)`,
    prompt: 'Leave blank to use provider-native authentication. The key stays in the Extension Host.',
    password: true,
    ignoreFocusOut: true,
  })
  return normalizeOptionalProviderApiKey(value)
}

/** Normalize and reject common pasted environment/configuration mistakes. */
export function normalizeOptionalProviderApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (normalized === '') return undefined
  const quoted =
    normalized.length > 1 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")) ||
      (normalized.startsWith('`') && normalized.endsWith('`')))
  if (ENVIRONMENT_ASSIGNMENT.test(normalized) || quoted || !LEGAL_API_KEY.test(normalized))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message:
        'The API key must be a non-empty printable value, not an environment assignment or quoted paste.',
      retryable: false,
    })
  return normalized
}
