/** Host-only result. The frontend URL must never be included in a Webview DTO. */
export type InspectorDevtoolsTarget =
  { readonly available: false } | { readonly available: true; readonly frontendUrl: string }
export interface InspectorDevtoolsRepository {
  discover(signal?: AbortSignal): Promise<InspectorDevtoolsTarget>
  close(): Promise<void>
}
