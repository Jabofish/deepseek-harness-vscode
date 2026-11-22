// @vitest-environment jsdom
import { StrictMode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TimelineState } from '@dsh-vscode/timeline'

const audio = vi.hoisted(() => ({
  unlock: vi.fn(() => vi.fn()),
  play: vi.fn<(_signal?: AbortSignal) => Promise<boolean>>(() => Promise.resolve(true)),
}))

vi.mock('./cue-audio.js', () => ({
  installCompletionCueAudioUnlock: audio.unlock,
  playCompletionCueBell: audio.play,
}))

const { useCompletionCue } = await import('./useCompletionCue.js')

beforeEach(() => {
  audio.unlock.mockClear()
  audio.play.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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

it('waits for the settled response commit and forwards the chat focus', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
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
  await waitFor(() => expect(responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1, false))
  view.rerender(
    <StrictMode>
      <View completed />
    </StrictMode>,
  )
  expect(responseRendered).toHaveBeenCalledTimes(1)
  expect(audio.play).not.toHaveBeenCalled()
})

it('plays the accepted bell through the unlocked Webview audio', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const responseRendered = vi.fn(() => Promise.resolve(true))
  function View(): React.ReactElement {
    useCompletionCue(responseRendered, timeline(true))
    return <p>Final answer</p>
  }
  const view = render(<View />)
  await waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1))
  const signal = audio.play.mock.calls[0]?.[0]
  expect(signal?.aborted).toBe(false)
  expect(responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1, true)
  expect(audio.unlock).toHaveBeenCalled()
  view.unmount()
  expect(signal?.aborted).toBe(true)
})
