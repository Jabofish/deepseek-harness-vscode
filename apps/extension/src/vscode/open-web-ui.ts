import * as vscode from 'vscode'
import { isLoopbackEndpoint, type BackendState } from '@dsh-vscode/domain'

type BrowserHost = Pick<typeof vscode, 'commands' | 'env' | 'window' | 'workspace' | 'Uri'>

/** Open only the connected backend; launch credentials remain in the Host. */
export async function openDshWebUi(
  state: BackendState,
  launchUrls: ReadonlyMap<string, string>,
  host: BrowserHost = vscode,
): Promise<void> {
  if (state.kind !== 'connected') {
    await host.window.showInformationMessage('Connect to DSH before opening its Web UI.')
    return
  }
  try {
    const endpoint = state.backend.endpoint
    let uri = host.Uri.parse(launchUrls.get(endpoint.baseUrl) ?? endpoint.baseUrl)
    if (host.env.remoteName !== undefined && isLoopbackEndpoint(endpoint))
      uri = await host.env.asExternalUri(uri)
    if (!['http', 'https'].includes(uri.scheme)) throw new Error('Unsupported browser URL')
    const target = host.workspace.getConfiguration('dsh').get<unknown>('webUi.browser', 'internal')
    if (target === 'external') {
      if (!(await host.env.openExternal(uri))) throw new Error('Browser did not open')
    } else if (target === 'internal') {
      // VS Code 1.125's integrated browser accepts a URL string and supports
      // full browser navigation without an extension-owned iframe or server.
      // Uri.toString() encodes '=' and '&', turning the login query into an
      // unrecognised parameter. The browser needs the original HTTP query.
      await host.commands.executeCommand('workbench.action.browser.open', uri.toString(true))
    } else {
      throw new Error('Invalid browser setting')
    }
  } catch {
    // Native failures can contain the launch URL, including its login token.
    const settings = 'Open Browser Settings'
    const selected = await host.window.showWarningMessage(
      'Unable to open the DSH Web UI. Check the connection or change the browser setting.',
      settings,
    )
    if (selected === settings)
      await host.commands.executeCommand('workbench.action.openSettings', 'dsh.webUi.browser')
  }
}
