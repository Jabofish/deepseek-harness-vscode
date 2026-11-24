import { expect, it, vi } from 'vitest'
import { CompletionCue } from './completion-cue.js'

function fixture(): {
  cue: CompletionCue
  notify: ReturnType<typeof vi.fn>
  bell: ReturnType<typeof vi.fn>
  state: { mode: string; focused: boolean; inputFocused: boolean; includeFocused: boolean; now: number }
  logs: unknown[]
} {
  const state = {
    mode: 'notification',
    focused: false,
    inputFocused: false,
    includeFocused: false,
    now: 100,
  }
  const notify = vi.fn()
  const bell = vi.fn()
  const logs: unknown[] = []
  const cue = new CompletionCue({
    mode: () => state.mode,
    focused: () => state.focused,
    includeFocused: () => state.includeFocused,
    notify,
    needsInput: () => ({ focused: state.inputFocused, bell }),
    now: () => state.now,
    log: (event) => logs.push(event),
  })
  return { cue, notify, bell, state, logs }
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

it('lets the renderer focus override a stale window focus', () => {
  const { cue, notify, state } = fixture()
  state.focused = true
  complete(cue)
  expect(cue.rendered('s', 1, false)).toEqual({ bell: false })
  expect(notify).toHaveBeenCalledTimes(1)

  // The chat itself has focus, so even an unfocused window stays quiet.
  state.focused = false
  complete(cue)
  expect(cue.rendered('s', 1, true)).toEqual({ bell: false })
  expect(notify).toHaveBeenCalledTimes(1)

  // Without a renderer signal the Host focus decides.
  complete(cue)
  cue.rendered('s', 1)
  expect(notify).toHaveBeenCalledTimes(2)
})

it('can cue while the chat is watched when the opt-in is set', () => {
  const { cue, notify, state } = fixture()
  state.mode = 'bell'
  state.focused = true
  state.includeFocused = true
  complete(cue)
  expect(cue.rendered('s', 1, true)).toEqual({ bell: true })
  state.mode = 'notification'
  complete(cue)
  cue.rendered('s', 1, false)
  expect(notify).toHaveBeenCalledTimes(1)
})

it('cues once for a question or an approval that needs the user', () => {
  const { cue, notify, bell, state } = fixture()
  cue.accept('question.requested', {
    question: { id: 'q1', sessionId: 's', prompt: 'Pick one' },
  })
  cue.accept('question.requested', {
    question: { id: 'q1', sessionId: 's', prompt: 'Pick one' },
  })
  expect(notify).toHaveBeenCalledTimes(1)

  cue.accept('permission.requested', {
    request: { id: 'p1', sessionId: 's', title: 'Run a command' },
  })
  expect(notify).toHaveBeenCalledTimes(2)

  state.mode = 'bell'
  cue.accept('permission.requested', {
    request: { id: 'p2', sessionId: 's', title: 'Run another command' },
  })
  expect(bell).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledTimes(2)

  bell.mockReturnValueOnce(false)
  cue.accept('permission.requested', {
    request: { id: 'p3', sessionId: 'bg', title: 'Background approval' },
  })
  expect(bell).toHaveBeenCalledTimes(2)
  expect(notify).toHaveBeenCalledTimes(3)
})

it('applies the focus policy to needs-input cues', () => {
  const { cue, notify, state } = fixture()
  state.inputFocused = true
  cue.accept('question.requested', { question: { id: 'focused', sessionId: 's' } })
  expect(notify).not.toHaveBeenCalled()

  state.includeFocused = true
  cue.accept('question.requested', { question: { id: 'watched', sessionId: 's' } })
  expect(notify).toHaveBeenCalledTimes(1)

  state.mode = 'off'
  cue.accept('question.requested', { question: { id: 'off', sessionId: 's' } })
  expect(notify).toHaveBeenCalledTimes(1)
})

it('scopes input deduplication to the session and clears it on reconnect', () => {
  const { cue, notify } = fixture()
  const request = (sessionId: string): void =>
    cue.accept('question.requested', { question: { id: 'same-request', sessionId } })
  request('first')
  request('first')
  request('second')
  expect(notify).toHaveBeenCalledTimes(2)

  cue.accept('connection.snapshot', { kind: 'connected' })
  request('first')
  expect(notify).toHaveBeenCalledTimes(3)
})

it('ignores replayed, continued and already-answered questions', () => {
  const { cue, notify, logs } = fixture()
  cue.accept('question.requested', {
    replayed: true,
    question: { id: 'replayed', sessionId: 's' },
  })
  cue.accept('question.requested', {
    question: { id: 'continued', sessionId: 's', state: 'continued' },
  })
  cue.accept('question.requested', {
    question: { id: 'queued', sessionId: 's', replyQueued: true },
  })
  cue.accept('question.requested', { question: { sessionId: 's' } })
  expect(notify).not.toHaveBeenCalled()
  expect(logs).toEqual([])
})

it('records each needs-input decision with its focus state', () => {
  const { cue, logs, state } = fixture()
  cue.accept('question.requested', { question: { id: 'q1', sessionId: 's' } })
  state.mode = 'off'
  cue.accept('question.requested', { question: { id: 'q2', sessionId: 's' } })
  expect(logs).toEqual([
    {
      decision: 'needs-input',
      kind: 'question',
      mode: 'notification',
      focused: false,
      delivered: true,
    },
    { decision: 'needs-input', kind: 'question', mode: 'off', focused: false, delivered: false },
  ])
})

it('normalizes the configured mode', () => {
  const { cue, state } = fixture()
  expect(cue.mode()).toBe('notification')
  state.mode = 'bell'
  expect(cue.mode()).toBe('bell')
  state.mode = 'something-else'
  expect(cue.mode()).toBe('off')
})

it('records one redaction-safe decision per gate', () => {
  const { cue, logs, state } = fixture()
  complete(cue)
  cue.rendered('s', 1)
  state.focused = true
  complete(cue)
  cue.rendered('s', 1, true)
  state.focused = false
  state.mode = 'off'
  complete(cue)
  cue.rendered('s', 1, false)
  complete(cue)
  state.now += 60_001
  cue.rendered('s', 1, false)
  expect(logs).toEqual([
    { decision: 'armed', turn: 1 },
    { decision: 'delivered', mode: 'notification', turn: 1, ageMs: 0 },
    { decision: 'armed', turn: 1 },
    { decision: 'suppressed', reason: 'focused', turn: 1, ageMs: 0 },
    { decision: 'armed', turn: 1 },
    { decision: 'suppressed', reason: 'off', turn: 1, ageMs: 0 },
    { decision: 'armed', turn: 1 },
    { decision: 'suppressed', reason: 'expired', turn: 1, ageMs: 60_001 },
  ])
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
