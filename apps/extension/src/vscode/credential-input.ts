import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

export function requestProviderSecret(
  window: typeof vscode.window,
  provider: string,
  field: string,
): Promise<string | undefined> {
  return unimplemented<Promise<string | undefined>>('secure provider credential input', [
    'use showInputBox with password true and ignoreFocusOut true',
    'explain destination and that the value is passed to local DSH',
    'never prefill, retain, log, send to Webview, or place the value on the clipboard',
    'return undefined on cancellation',
    `provider ${provider}; field ${field}; window API available ${String(window !== undefined)}`,
  ])
}
