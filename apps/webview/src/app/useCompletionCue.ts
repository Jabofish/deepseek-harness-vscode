import { useEffect, useRef } from 'react'
import type { TimelineState } from '@dsh-vscode/timeline'
import type { AppStore } from './store.js'

/** Called by the transcript renderer after current full bodies have committed. */
export function useCompletionCue(
  responseRendered: AppStore['responseRendered'] | undefined,
  timeline: Pick<TimelineState, 'sessionId' | 'nodes'>,
  pendingIds?: ReadonlySet<string>,
): void {
  const last = useRef<string | undefined>(undefined)
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
    let audio: AudioContext | undefined
    const timer = window.setTimeout(() => {
      last.current = key
      void responseRendered(sessionId, turn)
        .then(async (bell) => {
          if (!bell || !active || typeof AudioContext === 'undefined') return
          const context = new AudioContext()
          audio = context
          let started = false
          try {
            await context.resume()
            if (!active) return
            const oscillator = context.createOscillator()
            const gain = context.createGain()
            oscillator.connect(gain)
            gain.connect(context.destination)
            oscillator.frequency.value = 880
            gain.gain.setValueAtTime(0.08, context.currentTime)
            gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18)
            oscillator.onended = () => {
              void context.close().catch(() => undefined)
            }
            oscillator.start()
            oscillator.stop(context.currentTime + 0.2)
            started = true
          } finally {
            if (!started) await context.close()
          }
        })
        .catch(() => undefined)
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
      if (audio !== undefined && audio.state !== 'closed') void audio.close().catch(() => undefined)
    }
  }, [sessionId, turn, pending, responseRendered])
}
