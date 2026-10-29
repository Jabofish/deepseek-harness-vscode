import { expect, it, vi } from 'vitest'
import { CompletionCue } from './completion-cue.js'

function fixture(): {
  cue: CompletionCue
  notify: ReturnType<typeof vi.fn>
  state: { mode: string; focused: boolean; now: number }
} {
  const state = { mode: 'notification', focused: false, now: 100 }
  const notify = vi.fn()
  const cue = new CompletionCue({
    mode: () => state.mode,
    focused: () => state.focused,
    notify,
    now: () => state.now,
  })
  return { cue, notify, state }
}
function complete(cue: CompletionCue, sessionId = 's', turn = 1): void {
  cue.accept('turn.started', { sessionId, turn })
  cue.accept('turn.ended', { sessionId, turn, reason: 'completed' })
}

it('waits for rendered success and deduplicates concurrent panel receipts', () => {
  const { cue, notify } = fixture()
  complete(cue)
  expect(notify).not.toHaveBeenCalled()
  expect(cue.rendered('other', 1)).toEqual({ bell: false })
  expect(cue.rendered('s', 2)).toEqual({ bell: false })
  cue.rendered('s', 1)
  cue.rendered('s', 1)
  expect(notify).toHaveBeenCalledTimes(1)
})

it('uses current preferences and focus without leaving a delayed cue', () => {
  const { cue, notify, state } = fixture()
  complete(cue)
  state.focused = true
  cue.rendered('s', 1)
  state.focused = false
  cue.rendered('s', 1)
  expect(notify).not.toHaveBeenCalled()
  for (const mode of ['off', 'invalid', 'bell']) {
    state.mode = mode
    complete(cue)
    expect(cue.rendered('s', 1)).toEqual({ bell: mode === 'bell' })
  }
  expect(notify).not.toHaveBeenCalled()
})

it('ignores replay, cancellation, failure, old turns and connection changes', () => {
  const { cue, notify } = fixture()
  for (const reason of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'unknown']) {
    cue.accept('turn.started', { sessionId: 's', turn: 1 })
    cue.accept('turn.ended', { sessionId: 's', turn: 1, reason })
    cue.rendered('s', 1)
  }
  cue.accept('turn.started', { sessionId: 's', turn: 1, replayed: true })
  cue.accept('turn.ended', { sessionId: 's', turn: 1, reason: 'completed', replayed: true })
  cue.rendered('s', 1)
  complete(cue)
  cue.accept('connection.snapshot', { kind: 'connected' })
  cue.rendered('s', 1)
  complete(cue)
  cue.accept('turn.started', { sessionId: 's', turn: 2 })
  cue.rendered('s', 1)
  complete(cue)
  cue.accept('session.removed', { sessionId: 's' })
  cue.rendered('s', 1)
  expect(notify).not.toHaveBeenCalled()
})

it('expires delayed rendering and bounds retained sessions', () => {
  const { cue, notify, state } = fixture()
  complete(cue)
  state.now += 60_001
  cue.rendered('s', 1)
  for (let index = 0; index < 257; index++) complete(cue, `s${index}`)
  cue.rendered('s0', 1)
  expect(notify).not.toHaveBeenCalled()
  cue.rendered('s256', 1)
  expect(notify).toHaveBeenCalledTimes(1)
})
