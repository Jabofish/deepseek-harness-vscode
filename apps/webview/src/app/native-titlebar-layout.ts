import { PROTOCOL_VERSION, webviewEnvelopeSchema, type WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { VsCodeApi } from '../vscode-api.js'

type Layout = Extract<WebviewRequest, { type: 'surface.titlebarLayout' }>['payload']['layout']

/** Report only breakpoint crossings; no store updates, polling or backend work. */
export function watchNativeTitlebarLayout(
  api: Pick<VsCodeApi, 'postMessage'>,
  target: Window = window,
): () => void {
  let previous: Layout | undefined
  const publish = (): void => {
    const width = target.innerWidth
    const layout: Layout = width >= 360 ? 'wide' : width >= 280 ? 'regular' : 'compact'
    if (layout === previous) return
    try {
      api.postMessage(
        webviewEnvelopeSchema.parse({
          protocolVersion: PROTOCOL_VERSION,
          message: { type: 'surface.titlebarLayout', requestId: crypto.randomUUID(), payload: { layout } },
        }),
      )
      previous = layout
    } catch {
      // A closing Webview may lose its bridge. Another resize can retry.
    }
  }
  const dispose = (): void => {
    target.removeEventListener('resize', publish)
    target.removeEventListener('pagehide', dispose)
  }
  target.addEventListener('resize', publish)
  target.addEventListener('pagehide', dispose, { once: true })
  publish()
  return dispose
}
