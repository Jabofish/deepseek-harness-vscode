import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

export interface CompositionRoot extends vscode.Disposable {
  start(): Promise<void>
}

export function createCompositionRoot(context: vscode.ExtensionContext): CompositionRoot {
  return unimplemented<CompositionRoot>('extension composition root', [
    'instantiate runtime discovery, OS discovery providers, probe, version adapters, factory, coordinator, and use cases',
    'keep dependency direction Extension -> Application -> Domain and Adapter -> Domain',
    'share one connection and event stream across commands and the Webview',
    'inject vscode.env, workspace configuration, fetch, filesystem, clock, and process functions for testability',
    'wire disposal in reverse dependency order',
    `extension path ${context.extensionPath}`,
  ])
}
