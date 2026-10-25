// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeAccessibilitySignals, useAccessibilitySignals } from './accessibility-signals.js'
import { StrictMode } from 'react'

afterEach(() => {
  cleanup()
  document.body.className = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Signals(): React.JSX.Element {
  const signals = useAccessibilitySignals()
  return <output>{JSON.stringify(signals)}</output>
}

describe('shared accessibility signals', () => {
  it('releases resources through StrictMode setup-cleanup-setup and ignores unrelated body classes', async () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener, removeEventListener }))
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const view = render(
      <StrictMode>
        <Signals />
      </StrictMode>,
    )
    expect(addEventListener).toHaveBeenCalledTimes(2)
    expect(removeEventListener).toHaveBeenCalledOnce()
    const listener = vi.fn()
    const unsubscribe = subscribeAccessibilitySignals(listener)
    await act(async () => {
      document.body.classList.add('vscode-dark')
      await Promise.resolve()
    })
    expect(listener).not.toHaveBeenCalled()
    view.unmount()
    unsubscribe()
    expect(removeEventListener).toHaveBeenCalledTimes(2)
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
  it('combines initial OS and body values and follows both sources at runtime', async () => {
    const events = new EventTarget()
    const media = {
      matches: true,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    }
    vi.stubGlobal('matchMedia', () => media)
    document.body.className = 'vscode-using-screen-reader'
    render(<Signals />)
    const value = (): unknown => JSON.parse(screen.getByRole('status').textContent ?? '{}')
    expect(value()).toEqual({ reducedMotion: true, screenReader: true })
    await act(async () => {
      await Promise.resolve()
      media.matches = false
      events.dispatchEvent(new Event('change'))
      document.body.className = 'vscode-reduce-motion'
    })
    expect(value()).toEqual({ reducedMotion: true, screenReader: false })
    await act(async () => {
      await Promise.resolve()
      document.body.className = ''
    })
    expect(value()).toEqual({ reducedMotion: false, screenReader: false })
    await act(async () => {
      await Promise.resolve()
      document.body.className = 'vscode-using-screen-reader vscode-reduce-motion'
    })
    expect(value()).toEqual({ reducedMotion: true, screenReader: true })
  })

  it('shares one media listener/body observer and releases them after the last consumer', async () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener, removeEventListener }))
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const first = render(<Signals />)
    const second = render(<Signals />)
    const callback = vi.fn()
    const unsubscribe = subscribeAccessibilitySignals(callback)
    expect(addEventListener).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledExactlyOnceWith(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    })
    first.unmount()
    second.unmount()
    expect(disconnect).not.toHaveBeenCalled()
    unsubscribe()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(removeEventListener).toHaveBeenCalledExactlyOnceWith('change', addEventListener.mock.calls[0]?.[1])
    await act(async () => {
      await Promise.resolve()
      document.body.classList.add('vscode-reduce-motion')
    })
    expect(callback).not.toHaveBeenCalled()
    const reopened = render(<Signals />)
    expect(screen.getByRole('status').textContent).toContain('"reducedMotion":true')
    reopened.unmount()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
