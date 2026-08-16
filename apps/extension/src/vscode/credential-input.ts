import type * as vscode from 'vscode'

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
