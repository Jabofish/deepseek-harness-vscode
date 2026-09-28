import type { BackendEvent } from '@dsh-vscode/domain'

export interface SessionTurnWatcher {
  readonly sessionId: string
  turn: number | undefined
  finish(): void
  dispose(): void
}

/**
 * `sendPrompt` callers await the end of the turn their prompt started. The
 * registry only observes the durable `turn.started`/`turn.ended` pair: a
 * watcher whose turn already advanced past the observed one settles on the
 * first matching `turn.ended`, and disposal rejects it so no App await hangs
 * after the store is gone.
 */
export function createTurnWatchers(options: { isDisposed: () => boolean }): {
  notify: (event: Extract<BackendEvent, { type: 'turn.started' | 'turn.ended' }>) => void
  watch: (sessionId: string) => { completion: Promise<void>; dispose: () => void }
  disposeAll: () => void
} {
  const { isDisposed } = options
  const sessionTurnWatchers = new Set<SessionTurnWatcher>()
  const notify = (event: Extract<BackendEvent, { type: 'turn.started' | 'turn.ended' }>): void => {
    for (const watcher of sessionTurnWatchers) {
      if (watcher.sessionId !== event.sessionId) continue
      if (event.type === 'turn.started') watcher.turn = event.turn
      else if (watcher.turn === event.turn) watcher.finish()
    }
  }
  const watch = (sessionId: string): { completion: Promise<void>; dispose: () => void } => {
    let resolveCompletion!: () => void
    let rejectCompletion!: (reason: Error) => void
    let settled = false
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    // The App may still be awaiting sendPrompt when disposal rejects this watcher.
    void completion.catch(() => undefined)
    const finish = (): void => {
      if (settled) return
      settled = true
      sessionTurnWatchers.delete(watcher)
      resolveCompletion()
    }
    const disposeWatcher = (): void => {
      if (settled) return
      settled = true
      sessionTurnWatchers.delete(watcher)
      const error = new Error('AppStore disposed before the Session turn ended.')
      error.name = 'SessionTurnWatchDisposedError'
      rejectCompletion(error)
    }
    const watcher: SessionTurnWatcher = { sessionId, turn: undefined, finish, dispose: disposeWatcher }
    if (isDisposed()) disposeWatcher()
    else sessionTurnWatchers.add(watcher)
    return { completion, dispose: disposeWatcher }
  }
  const disposeAll = (): void => {
    for (const watcher of [...sessionTurnWatchers]) watcher.dispose()
  }
  return { notify, watch, disposeAll }
}
