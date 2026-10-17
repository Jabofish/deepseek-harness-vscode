// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchNativeTitlebarLayout } from './native-titlebar-layout.js'
import type { VsCodeApi } from '../vscode-api.js'

describe('native title-bar responsive layout', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('restores wide actions after narrowing and reports only breakpoint crossings', () => {
    const postMessage = vi.fn<VsCodeApi['postMessage']>()
    const resize = (width: number): void => {
      vi.stubGlobal('innerWidth', width)
      window.dispatchEvent(new Event('resize'))
    }
    resize(500)
    const dispose = watchNativeTitlebarLayout({ postMessage })
    resize(480)
    resize(350)
    resize(240)
    resize(260)
    resize(500)
    expect(
      postMessage.mock.calls.map(([message]) =>
        'payload' in message.message ? message.message.payload : undefined,
      ),
    ).toEqual([{ layout: 'wide' }, { layout: 'regular' }, { layout: 'compact' }, { layout: 'wide' }])
    dispose()
    resize(200)
    expect(postMessage).toHaveBeenCalledTimes(4)
  })

  it('retries a failed bridge post and releases the observer when the Webview closes', () => {
    vi.stubGlobal('innerWidth', 240)
    const postMessage = vi.fn<VsCodeApi['postMessage']>().mockImplementationOnce(() => {
      throw new Error('closed bridge')
    })
    watchNativeTitlebarLayout({ postMessage })
    window.dispatchEvent(new Event('resize'))
    expect(postMessage).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('pagehide'))
    vi.stubGlobal('innerWidth', 500)
    window.dispatchEvent(new Event('resize'))
    expect(postMessage).toHaveBeenCalledTimes(2)
  })
})
