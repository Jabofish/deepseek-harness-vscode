import type { BackendEndpoint } from '@dsh-vscode/domain'
import type { AlphaAdapterOptions, Rc6AdapterOptions } from '@dsh-vscode/dsh-adapter'

export interface AdapterOptionsDependencies {
  /**
   * Read on every use, never while the options are built. Settings validation
   * throws on an invalid value such as a non-absolute `dsh.runtime.executablePath`;
   * reading one during activation would report a broken extension instead of
   * failing the single operation that needed the value.
   */
  readonly requestTimeoutMs: () => number
  readonly fetch: typeof globalThis.fetch
  readonly samePath: (left: string, right: string) => boolean
  readonly exportFileSystem: NonNullable<AlphaAdapterOptions['exportFileSystem']>
  readonly webSocket?: NonNullable<AlphaAdapterOptions['webSocket']> &
    NonNullable<Rc6AdapterOptions['webSocket']>
  readonly authCookie: (endpoint: BackendEndpoint) => string | undefined
  readonly allowLocalInspector?: (endpoint: BackendEndpoint) => boolean
  /** Advisory observability for the optional transient assistant preview. */
  readonly onAssistantPreview?: NonNullable<AlphaAdapterOptions['onAssistantPreview']>
}

/**
 * Options shared by every version adapter. The adapters keep the object and
 * read it when they connect, so the getters here are the only place that turns
 * a settings change into a new request value without a window reload.
 */
export function createAdapterOptions(
  dependencies: AdapterOptionsDependencies,
): Omit<AlphaAdapterOptions, 'webSocket'> & Pick<AdapterOptionsDependencies, 'webSocket'> {
  return {
    get requestTimeoutMs() {
      return dependencies.requestTimeoutMs()
    },
    get retryPolicy() {
      return { maximumAttempts: 2, baseDelayMs: 100, maximumDelayMs: 500 }
    },
    fetch: dependencies.fetch,
    samePath: dependencies.samePath,
    exportFileSystem: dependencies.exportFileSystem,
    authCookie: dependencies.authCookie,
    ...(dependencies.allowLocalInspector === undefined
      ? {}
      : { allowLocalInspector: dependencies.allowLocalInspector }),
    ...(dependencies.onAssistantPreview === undefined
      ? {}
      : { onAssistantPreview: dependencies.onAssistantPreview }),
    ...(dependencies.webSocket === undefined ? {} : { webSocket: dependencies.webSocket }),
  }
}
