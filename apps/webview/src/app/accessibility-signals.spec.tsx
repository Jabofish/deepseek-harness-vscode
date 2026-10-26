// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAccessibilitySignals } from './accessibility-signals.js'

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
})
