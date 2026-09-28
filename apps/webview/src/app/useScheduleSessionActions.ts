import type { AppStore } from './store.js'
import type { useI18n } from '../i18n.js'
import { useStableCallback } from './useStableCallback.js'
import { resolveScheduleSessionLink } from '../features/schedules/session-link.js'
import { isDefinitePromptRejection } from '../features/schedules/prompt-rejection.js'

interface ScheduleSessionActions {
  readonly getLinkedSession: (sessionId: string) => ReturnType<typeof resolveScheduleSessionLink>
  readonly onOpenLinkedSession: (sessionId: string) => void
  readonly onStartSession: (prompt: string) => Promise<string>
}

export function useScheduleSessionActions({
  store,
  workspaceId,
  discardAttachmentDrafts,
  setError,
  t,
}: {
  readonly store: AppStore
  readonly workspaceId: string | undefined
  readonly discardAttachmentDrafts: () => void
  readonly setError: (message: string | undefined) => void
  readonly t: ReturnType<typeof useI18n>['t']
}): ScheduleSessionActions {
  const getLinkedSession = useStableCallback((sessionId: string) => {
    const current = store.getState()
    return resolveScheduleSessionLink(
      sessionId,
      current.backend.kind === 'connected' ? (current.sessionDirectoryStatus ?? 'loading') : 'loading',
      current.sessions,
      current.workspaces,
      current.archivedSessionIds,
    )
  })
  const onOpenLinkedSession = useStableCallback((sessionId: string): void => {
    const current = store.getState()
    if (current.backend.kind !== 'connected') return
    if (
      resolveScheduleSessionLink(
        sessionId,
        current.sessionDirectoryStatus ?? 'loading',
        current.sessions,
        current.workspaces,
        current.archivedSessionIds,
      ).status !== 'available'
    )
      return
    discardAttachmentDrafts()
    void store
      .openSession(sessionId)
      .then(() => {
        if (store.getState().drawer === 'schedules') store.setDrawer(undefined)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('app.error.openSession')),
      )
  })
  const onStartSession = useStableCallback(async (prompt: string): Promise<string> => {
    await store.createSession(workspaceId)
    const sessionId = store.getState().activeSessionId
    if (sessionId === undefined) throw new Error(t('schedules.createSessionFailed'))
    const turn = store.watchSessionTurnEnd(sessionId)
    try {
      try {
        await store.sendPrompt(sessionId, prompt, [], 'queue')
      } catch (reason) {
        if (isDefinitePromptRejection(reason)) throw reason
        // A transport failure can arrive after the Host admitted the prompt.
        // Keep this creation locked until the Session proves the turn ended.
      }
      await turn.completion
      return sessionId
    } catch (reason) {
      if (reason instanceof Error && reason.name === 'SessionTurnWatchDisposedError') {
        const uncertain = new Error('The schedule creation turn ended without a terminal Session event.')
        const indeterminate = uncertain as Error & { scheduleCreateIndeterminate?: boolean }
        indeterminate.scheduleCreateIndeterminate = true
        throw uncertain
      }
      throw reason
    } finally {
      turn.dispose()
    }
  })
  return { getLinkedSession, onOpenLinkedSession, onStartSession }
}
