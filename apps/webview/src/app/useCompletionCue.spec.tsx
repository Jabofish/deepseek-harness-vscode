// @vitest-environment jsdom
import { StrictMode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TimelineState } from '@dsh-vscode/timeline'
import { useCompletionCue } from './useCompletionCue.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const timeline = (completed: boolean): TimelineState => ({
  sessionId: 's',
  lastSequence: 1,
  eventCount: 1,
  nodes: [
    {
      kind: 'assistant-message',
      id: 'answer',
      turn: 1,
      markdown: 'Final answer',
      streaming: !completed,
      turnCompleted: completed,
    },
  ],
})

it('waits for the settled response commit and deduplicates Strict Mode and unrelated rerenders', async () => {
  const responseRendered = vi.fn(() => {
    expect(document.querySelector('p')?.textContent).toBe('Final answer')
    return Promise.resolve(false)
  })
  const store = { responseRendered }
  function View({ completed }: { completed: boolean }): React.ReactElement {
    useCompletionCue(store.responseRendered, timeline(completed))
    return <p>{completed ? 'Final answer' : 'Working'}</p>
  }
  const view = render(
    <StrictMode>
      <View completed={false} />
    </StrictMode>,
  )
  expect(responseRendered).not.toHaveBeenCalled()
  view.rerender(
    <StrictMode>
      <View completed />
    </StrictMode>,
  )
  await waitFor(() => expect(responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1))
  view.rerender(
    <StrictMode>
      <View completed />
    </StrictMode>,
  )
  expect(responseRendered).toHaveBeenCalledTimes(1)
})

it('plays the approved bell and releases audio when the panel closes', async () => {
  const close = vi.fn(() => Promise.resolve())
  const stop = vi.fn()
  const context = {
    resume: () => Promise.resolve(),
    close,
    state: 'running',
    currentTime: 0,
    destination: {},
    createOscillator: () => ({
      connect: vi.fn(),
      frequency: { value: 0 },
      start: vi.fn(),
      stop,
      onended: undefined,
    }),
    createGain: () => ({
      connect: vi.fn(),
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    }),
  }
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context
      }
    },
  )
  const store = { responseRendered: vi.fn(() => Promise.resolve(true)) }
  function View(): React.ReactElement {
    useCompletionCue(store.responseRendered, timeline(true))
    return <p>Final answer</p>
  }
  const view = render(<View />)
  await waitFor(() => expect(stop).toHaveBeenCalledWith(0.2))
  view.unmount()
  expect(close).toHaveBeenCalledTimes(1)
})
