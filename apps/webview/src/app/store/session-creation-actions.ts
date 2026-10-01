import type { AgentConfiguration } from '@dsh-vscode/domain'
import { AppError, parseSlashCommand } from '@dsh-vscode/domain'
import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { clearedActiveSession } from './session-projection.js'
import { createDefaultConfiguration, isAgentConfiguration } from './model-catalog.js'
import { findReusableBlankSession } from './session-registry.js'
import type { createPromptActions } from './prompt-actions.js'
import type { AppActions, AppState, StateSetter } from './types.js'
import { object } from './unknown-record.js'

const DSH_RC11_VERSION = '0.1.1-rc.1'
const DSH_RC12_VERSION = '0.1.1-rc.2'

interface PendingSend {
  readonly revision: number
  readonly promise: Promise<void>
}

type SendUserTurn = ReturnType<typeof createPromptActions>['sendUserTurn']

export interface SessionCreationActionDependencies {
  readonly client: ProtocolClient
  readonly clearStartupRestorePending: () => void
  readonly discardEditorContextForSessionSwitch: (sessionId: string) => Promise<void>
  readonly flushPendingHistory: () => void
  readonly getComposerPreferences: () => Parameters<typeof createDefaultConfiguration>[1]
  readonly getOpenIntent: () => number
  readonly getPendingSend: () => PendingSend | undefined
  readonly getPendingSessionRevision: () => number
  readonly getState: () => AppState
  readonly nextOpenIntent: () => number
  readonly nextOpenVersion: () => number
  readonly nextPendingSessionRevision: () => number
  readonly openSession: (sessionId: string) => Promise<void>
  readonly persistWebviewState: () => void
  readonly rememberComposerConfiguration: (configuration: AgentConfiguration) => void
  readonly refresh: () => Promise<void>
  readonly sendUserTurn: SendUserTurn
  readonly setPendingSend: (pending: PendingSend | undefined) => void
  readonly setState: StateSetter
  readonly stopJobsBeforeSessionOpen: () => void
}

export function createSessionCreationActions(
  deps: SessionCreationActionDependencies,
): Pick<AppActions, 'stageSession' | 'configurePendingSession' | 'sendPendingPrompt' | 'createSession'> {
  const {
    client,
    clearStartupRestorePending,
    discardEditorContextForSessionSwitch,
    flushPendingHistory,
    getComposerPreferences,
    getOpenIntent,
    getPendingSend,
    getPendingSessionRevision,
    getState,
    nextOpenIntent,
    nextOpenVersion,
    nextPendingSessionRevision,
    openSession,
    persistWebviewState,
    rememberComposerConfiguration,
    refresh,
    sendUserTurn,
    setPendingSend,
    setState,
    stopJobsBeforeSessionOpen,
  } = deps

  return {
    stageSession: async (workspaceId, presetId) => {
      const state = getState()
      const workspace =
        (workspaceId === undefined
          ? undefined
          : state.workspaces.find((entry) => entry.id === workspaceId)) ?? state.workspaces[0]
      if (workspace === undefined) throw new Error(translate('app.workspaceLoadingDescription'))
      const defaultConfiguration = createDefaultConfiguration(state, getComposerPreferences())
      const configuration =
        presetId === undefined ? defaultConfiguration : { ...defaultConfiguration, preset: presetId }
      const revision = nextPendingSessionRevision()
      const navigationIntent = nextOpenIntent()
      nextOpenVersion()
      clearStartupRestorePending()
      stopJobsBeforeSessionOpen()
      flushPendingHistory()
      await discardEditorContextForSessionSwitch('')
      if (revision !== getPendingSessionRevision() || navigationIntent !== getOpenIntent()) return
      setState((current) => ({
        ...current,
        ...clearedActiveSession(current, current.activeSessionId ?? ''),
        pendingSession: { revision, workspaceId: workspace.id, configuration },
        editorContext: [],
        editorContextAvailableKinds: [],
        editorContextLoading: false,
        drawer: undefined,
      }))
      persistWebviewState()
    },
    configurePendingSession: (configuration) => {
      if (!isAgentConfiguration(configuration)) throw new Error(translate('app.error.sessionSettings'))
      setState((current) =>
        current.pendingSession === undefined
          ? current
          : {
              ...current,
              pendingSession: { ...current.pendingSession, configuration },
            },
      )
      rememberComposerConfiguration(configuration)
    },
    sendPendingPrompt: (text, attachments, mode) => {
      const pending = getState().pendingSession
      if (pending === undefined) return Promise.reject(new Error(translate('app.error.createSession')))
      const existingSend = getPendingSend()
      if (existingSend?.revision === pending.revision) return existingSend.promise
      if (text.trim() === '' && attachments.length === 0)
        return Promise.reject(new Error(translate('app.error.prompt')))
      if (parseSlashCommand(text) !== undefined)
        return Promise.reject(new Error(translate('app.error.commandBeforeFirstMessage')))
      // Any exit after the send started where nothing was delivered — another
      // navigation owns the panel, or a newer pending draft replaced this
      // composition — must reject as cancelled. Resolving would run the
      // composer's success cleanup and wipe the draft and attachments the user
      // can still see and edit.
      const supersededSend = (): AppError =>
        new AppError({
          code: 'REQUEST_CANCELLED',
          message: 'The first message was not sent because the view moved on before delivery.',
          retryable: true,
        })
      const send = (async () => {
        let sessionId = pending.createdSessionId
        if (sessionId === undefined) {
          const state = getState()
          const workspace = state.workspaces.find((entry) => entry.id === pending.workspaceId)
          const reusableBlank =
            workspace === undefined
              ? undefined
              : findReusableBlankSession(state.sessions, state.archivedSessionIds, workspace)
          if (state.connectedDshVersion === DSH_RC12_VERSION && reusableBlank !== undefined) {
            sessionId = reusableBlank.id
          } else {
            const rc11ReusableBlank =
              state.connectedDshVersion === DSH_RC11_VERSION ? reusableBlank : undefined
            const result = object(
              await client.request<unknown>({
                type: 'session.create',
                requestId: requestId(),
                payload: {
                  workspaceId: pending.workspaceId,
                  ...(rc11ReusableBlank === undefined
                    ? {}
                    : { sessionId: rc11ReusableBlank.id, reuseWorkspaceBlank: true as const }),
                  configuration: pending.configuration,
                },
              }),
            )
            if (typeof result?.id !== 'string' || result.id.trim() === '')
              throw new Error(translate('app.error.createSession'))
            sessionId = result.id
          }
          if (sessionId === undefined) throw new Error(translate('app.error.createSession'))
          const createdSessionId = sessionId
          setState((current) =>
            current.pendingSession?.revision === pending.revision
              ? {
                  ...current,
                  pendingSession: { ...current.pendingSession, createdSessionId },
                }
              : current,
          )
        }
        if (getState().pendingSession?.revision !== pending.revision) throw supersededSend()
        await refresh()
        if (getState().pendingSession?.revision !== pending.revision) throw supersededSend()
        await openSession(sessionId)
        if (getState().activeSessionId !== sessionId) throw supersededSend()
        await sendUserTurn(sessionId, text, attachments, mode, undefined)
      })()
      const promise = send.finally(() => {
        if (getPendingSend()?.revision === pending.revision) setPendingSend(undefined)
      })
      setPendingSend({ revision: pending.revision, promise })
      return promise
    },
    createSession: async (workspaceId, presetId) => {
      const navigationIntent = nextOpenIntent()
      const state = getState()
      const workspace =
        (workspaceId === undefined
          ? undefined
          : state.workspaces.find((entry) => entry.id === workspaceId)) ?? state.workspaces[0]
      const defaultConfiguration = createDefaultConfiguration(state, getComposerPreferences())
      const configuration =
        presetId === undefined ? defaultConfiguration : { ...defaultConfiguration, preset: presetId }
      const reusableBlank =
        presetId === undefined && workspace !== undefined
          ? findReusableBlankSession(state.sessions, state.archivedSessionIds, workspace)
          : undefined
      if (state.connectedDshVersion === DSH_RC12_VERSION && reusableBlank !== undefined) {
        await openSession(reusableBlank.id)
        return
      }
      const rc11ReusableBlank = state.connectedDshVersion === DSH_RC11_VERSION ? reusableBlank : undefined
      const result = await client.request<unknown>({
        type: 'session.create',
        requestId: requestId(),
        payload: {
          ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
          ...(rc11ReusableBlank === undefined
            ? {}
            : { sessionId: rc11ReusableBlank.id, reuseWorkspaceBlank: true as const }),
          configuration,
        },
      })
      const created = object(result)
      await refresh()
      if (navigationIntent === getOpenIntent() && typeof created?.id === 'string')
        await openSession(created.id)
    },
  }
}
