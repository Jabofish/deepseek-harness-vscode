import {
  parseSlashCommand,
  resolvePromptMode,
  type AgentConfiguration,
  type PromptAttachment,
  type PromptMode,
  type RunningInputMode,
} from '@dsh-vscode/domain'

import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { hasDynamicCommand } from './agent-config.js'
import { requestId } from './ids.js'
import type { ActiveSubagent, AppState, StateSetter } from './types.js'

export interface SessionActionDependencies {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
  readonly executeCommandRequest: (
    sessionId: string,
    command: string,
    attachments?: readonly PromptAttachment[],
  ) => Promise<'executed' | 'unknown'>
  readonly sendUserTurn: (
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
    subagent: ActiveSubagent | undefined,
  ) => Promise<void>
  readonly refreshCommands: (sessionId: string) => Promise<void>
  readonly refreshSessionModelDirectoryForSession: (sessionId: string) => Promise<void>
  readonly rememberComposerConfiguration: (configuration: AgentConfiguration) => void
  readonly rememberPromptMode: (mode: PromptMode) => void
  readonly rememberOpenFileId: (openFileId: string) => void
  readonly nextConfigurationGeneration: () => number
  readonly isConfigurationGenerationCurrent: (generation: number) => boolean
}

export interface SessionActions {
  configureSession(sessionId: string, configuration: AgentConfiguration): Promise<void>
  executeCommand(
    sessionId: string,
    command: string,
    attachments?: readonly PromptAttachment[],
  ): Promise<boolean>
  sendPrompt(
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
  ): Promise<void>
  cancelSession(sessionId: string): Promise<void>
  setPromptMode(mode: PromptMode): Promise<boolean>
  rememberOpenFile(candidateId: string): void
}

export function createSessionActions(dependencies: SessionActionDependencies): SessionActions {
  const {
    client,
    getState,
    setState,
    executeCommandRequest,
    sendUserTurn,
    refreshCommands,
    refreshSessionModelDirectoryForSession,
    rememberComposerConfiguration,
    rememberPromptMode,
    rememberOpenFileId,
    nextConfigurationGeneration,
    isConfigurationGenerationCurrent,
  } = dependencies

  const activeSubagentFor = (sessionId: string): ActiveSubagent | undefined => {
    const state = getState()
    return state.activeSessionId === sessionId && state.activeSubagent?.entry.id === sessionId
      ? state.activeSubagent
      : undefined
  }

  const configureSession = async (sessionId: string, configuration: AgentConfiguration): Promise<void> => {
    const generation = nextConfigurationGeneration()
    const previousProvider = getState().configuration?.model.providerId
    await client.request<unknown>({
      type: 'session.configure',
      requestId: requestId(),
      payload: { sessionId, configuration },
    })
    if (!isConfigurationGenerationCurrent(generation)) return
    rememberComposerConfiguration(configuration)
    setState((current) => (current.activeSessionId === sessionId ? { ...current, configuration } : current))
    // Only the provider decides whether an adapter serves the selection, so
    // only its change can move `routable`. Re-read after the write: a stale
    // `false` would keep the composer inert for a selection the host now
    // serves, and a stale `true` would unlock one it no longer does.
    if (previousProvider === configuration.model.providerId) return
    await refreshSessionModelDirectoryForSession(sessionId)
  }

  const executeCommand = async (
    sessionId: string,
    command: string,
    attachments: readonly PromptAttachment[] = [],
  ): Promise<boolean> => {
    if ((await executeCommandRequest(sessionId, command, attachments)) === 'executed') return true
    // The palette hands the picked line to the command surface; a skill row
    // has no command behind it, so the same line is submitted as the prompt
    // gesture it spells.
    await sendUserTurn(sessionId, command, attachments, 'queue', undefined)
    return true
  }

  const sendPrompt = async (
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
  ): Promise<void> => {
    const subagent = activeSubagentFor(sessionId)
    if (subagent === undefined && parseSlashCommand(text) !== undefined) {
      // Slash commands are control-plane operations.  Sending them through
      // session.prompt turns /plan, /permission, /compact, and every plugin
      // command into a visible model request.  The official WebUI routes
      // the complete line through commands.execute instead, and that route
      // accepts the composer's image attachments.  Editor-context chips are
      // not part of the command payload; they stay attached to the composer
      // for the next message, exactly as they do on the Composer's own
      // command path.  A line DSH answers as unknown is not a command at all
      // and is submitted below as the prompt gesture it spells.
      if ((await executeCommandRequest(sessionId, text, attachments)) === 'executed') return
    }
    await sendUserTurn(sessionId, text, attachments, mode, subagent)
  }

  const cancelSession = async (sessionId: string): Promise<void> => {
    const subagent = activeSubagentFor(sessionId)
    if (subagent?.entry.mode === 'one-shot') throw new Error(translate('app.error.subagentInterrupt'))
    await client.request<unknown>(
      subagent === undefined
        ? { type: 'session.cancel', requestId: requestId(), payload: { sessionId } }
        : { type: 'subagent.interrupt', requestId: requestId(), payload: { sessionId } },
    )
  }

  const setPromptMode = async (mode: PromptMode): Promise<boolean> => {
    const sessionId = getState().activeSessionId
    const configuration = getState().configuration
    if (sessionId === undefined || configuration === undefined) return false
    // The command directory is advisory for session visibility, but it is
    // authoritative for exposing the semantic Plan toggle. If the user
    // reaches this action before the background directory read completes,
    // join that in-flight read instead of treating a temporary empty list
    // as an unsupported upstream capability.
    if (mode === 'plan' && !hasDynamicCommand(getState().commands, 'plan')) await refreshCommands(sessionId)
    const resolution = resolvePromptMode(mode, {
      planCommandAvailable: hasDynamicCommand(getState().commands, 'plan'),
    })
    if (!resolution.supported) throw new Error(resolution.reason ?? translate('app.error.promptMode'))
    if (resolution.planEnabled !== configuration.planMode)
      await executeCommandRequest(sessionId, resolution.planEnabled ? '/plan' : '/plan off')
    if (getState().activeSessionId !== sessionId) return false
    setState((current) =>
      current.activeSessionId === sessionId ? { ...current, promptMode: mode } : current,
    )
    rememberPromptMode(mode)
    return true
  }

  const rememberOpenFile = (candidateId: string): void => {
    const normalized = candidateId.trim()
    if (normalized === '') return
    setState((current) => ({ ...current, preferredOpenFileId: normalized }))
    rememberOpenFileId(normalized)
  }

  return { configureSession, executeCommand, sendPrompt, cancelSession, setPromptMode, rememberOpenFile }
}
