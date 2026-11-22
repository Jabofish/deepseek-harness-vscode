import { useEffect, useRef } from 'react'
import type { TimelineState } from '@dsh-vscode/timeline'
import type { AppStore } from './store.js'
import { installCompletionCueAudioUnlock, playCompletionCueBell } from './cue-audio.js'

/** Called by the transcript renderer after current full bodies have committed. */
export function useCompletionCue(
  responseRendered: AppStore['responseRendered'] | undefined,
  timeline: Pick<TimelineState, 'sessionId' | 'nodes'>,
  pendingIds?: ReadonlySet<string>,
): void {
  const last = useRef<string | undefined>(undefined)
  // A cue arrives long after the gesture that sent the prompt, so warm the
  // shared audio context while the user is still interacting with the chat.
  useEffect(() => installCompletionCueAudioUnlock(), [])
  const answer = timeline.nodes.findLast(
    (node) =>
      node.kind === 'assistant-message' &&
      node.turnCompleted === true &&
      !node.streaming &&
      node.reasoning?.streaming !== true,
  )
  const turn = answer?.kind === 'assistant-message' ? answer.turn : undefined
  const pending = timeline.nodes.some(
    (node) => 'turn' in node && node.turn === turn && pendingIds?.has(node.id) === true,
  )
  const sessionId = timeline.sessionId
  useEffect(() => {
    if (sessionId === undefined || turn === undefined || pending || responseRendered === undefined) return
    const key = JSON.stringify([sessionId, turn])
    if (last.current === key) return
    let active = true
    const timer = window.setTimeout(() => {
      last.current = key
      // The renderer knows whether the chat really has focus; VS Code's window
      // focus is stale on some Linux window managers.
      void responseRendered(sessionId, turn, document.hasFocus())
        .then(async (bell) => {
          if (!bell || !active) return
          await playCompletionCueBell()
        })
        .catch(() => undefined)
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [sessionId, turn, pending, responseRendered])
}
