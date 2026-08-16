import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import { unimplemented } from '@dsh-vscode/domain'

export interface VsCodeApi<State = unknown> {
  postMessage(message: WebviewRequest): void
  getState(): State | undefined
  setState(newState: State): void
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>

const holder: { singleton?: VsCodeApi } = {}

export function getVsCodeApi(): VsCodeApi {
  return unimplemented<VsCodeApi>('acquire and cache VS Code Webview API', [
    'call acquireVsCodeApi exactly once',
    'never expose the returned object on window or globalThis',
    'persist only non-sensitive UI state such as selected drawer and draft identifiers',
    'never persist prompts, tool output, endpoints, or provider credentials',
    `existing singleton ${String(holder.singleton !== undefined)}; acquire function type ${typeof acquireVsCodeApi}`,
  ])
}
