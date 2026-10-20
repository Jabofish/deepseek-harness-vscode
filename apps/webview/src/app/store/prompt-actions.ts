import type { MessageAttachment, PromptAttachment, QueuedInput, RunningInputMode } from '@dsh-vscode/domain'
import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { applyKnownCommand, promptModeAfterCommand } from './agent-config.js'
import type { ActiveSubagent, AppState, StateSetter } from './types.js'
import type { PendingPromptReceipt } from './pending-prompts.js'
import { object } from './unknown-record.js'

type CommandPromptMode = NonNullable<ReturnType<typeof promptModeAfterCommand>>

export interface PromptActionDependencies {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly rememberPromptMode: (mode: CommandPromptMode) => void
  readonly setState: StateSetter
}

export function createPromptActions(deps: PromptActionDependencies): {
  readonly executeCommandRequest: (
    sessionId: string,
    command: string,
    attachments?: readonly PromptAttachment[],
    signal?: AbortSignal,
  ) => Promise<'executed' | 'unknown'>
  readonly sendUserTurn: (
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
    subagent: ActiveSubagent | undefined,
    signal?: AbortSignal,
  ) => Promise<void>
} {
  const { client, getState, rememberPromptMode, setState } = deps
  const executeCommandRequest = async (
    sessionId: string,
    command: string,
    attachments: readonly PromptAttachment[] = [],
    signal?: AbortSignal,
  ): Promise<'executed' | 'unknown'> => {
    const result = object(
      await client.request<unknown>(
        {
          type: 'command.execute',
          requestId: requestId(),
          payload: { sessionId, command, attachments: [...attachments] },
        },
        signal,
      ),
    )
    if (result?.kind === 'error')
      throw new Error(typeof result.text === 'string' ? result.text : translate('app.error.dshMode'))
    // A line outside DSH's command directory is not a command. The official
    // client lets it fall to the default sink, where the host injects a
    // user-invocable skill (the `/skill-name args` gesture) and any other line
    // reaches the model as ordinary text.
    if (result?.kind === 'unknown') return 'unknown'
    if (result !== undefined && result?.kind !== 'success') throw new Error(translate('app.error.dshMode'))
    setState((current) => {
      if (current.activeSessionId !== sessionId || current.configuration === undefined) return current
      const nextConfiguration = applyKnownCommand(current.configuration, command)
      const nextPromptMode = promptModeAfterCommand(current.promptMode, command)
      return {
        ...current,
        configuration: nextConfiguration,
        ...(nextPromptMode === undefined ? {} : { promptMode: nextPromptMode }),
      }
    })
    const nextPromptMode = promptModeAfterCommand(getState().promptMode, command)
    if (nextPromptMode !== undefined) rememberPromptMode(nextPromptMode)
    return 'executed'
  }

  /** Admit one ordinary turn (or subagent message) addressed to this session. */
  const sendUserTurn = async (
    sessionId: string,
    text: string,
    attachments: readonly PromptAttachment[],
    mode: RunningInputMode,
    subagent: ActiveSubagent | undefined,
    signal?: AbortSignal,
  ): Promise<void> => {
    const rpcRequestId = requestId()
    const optimisticId = `optimistic:user:${rpcRequestId}`
    const pendingId = `pending:${rpcRequestId}`
    const state = getState()
    signal?.throwIfAborted()
    const status = state.sessions.find((session) => session.id === sessionId)?.status
    // Only an idle Agent admits a follow-up immediately. A missing status and
    // awaiting-input both mean the prompt may be queued upstream, so they must
    // not be treated as a direct turn.
    const idle = status === 'idle' || status === 'completed' || status === 'failed'
    const direct = subagent === undefined && idle && state.queue.length === 0
    if (direct) {
      const receipt: PendingPromptReceipt = {
        id: pendingId,
        sessionId,
        text,
        attachments: [...attachments],
        textOnly: attachments.length === 0,
        mode,
        createdAt: new Date().toISOString(),
        rpcId: rpcRequestId,
        queueIdsBefore: state.queue.map((item) => item.id),
      }
      setState((current) => ({
        ...current,
        directPromptRequestIds: [...(current.directPromptRequestIds ?? []), rpcRequestId].slice(-64),
        directPromptReceipts: [...(current.directPromptReceipts ?? []), receipt].slice(-64),
      }))
    }
    // Only the panel that shows this session's queue can consume a local
    // receipt; a background send has no dock to reconcile it against.
    if (!direct && subagent === undefined && mode === 'queue' && state.activeSessionId === sessionId) {
      const pendingEntry: PendingPromptReceipt = {
        id: pendingId,
        sessionId,
        text,
        attachments: [...attachments],
        textOnly: attachments.length === 0,
        mode,
        createdAt: new Date().toISOString(),
        rpcId: rpcRequestId,
        queueIdsBefore: state.queue.map((item) => item.id),
      }
      setState((current) => ({
        ...current,
        pendingPrompts: [...(current.pendingPrompts ?? []), pendingEntry].slice(-32),
      }))
    }
    const contextRefs = state.editorContext.map((item) => item.ref.contextRef)
    const contextWorkspaceIds = new Set(
      state.editorContext
        .filter((item) => contextRefs.includes(item.ref.contextRef))
        .map((item) => item.ref.workspaceFolderId),
    )
    const contextWorkspaceFolderId = contextWorkspaceIds.size === 1 ? [...contextWorkspaceIds][0] : undefined
    // A queued prompt is not a conversation turn yet. DSH publishes the
    // durable `message.user` event only when the queue admits it; rendering
    // a local preview here makes the same text appear both in the timeline
    // and in the queue dock. Subagent sends bypass the session queue, and
    // steer is already admitted to the running turn, so those retain the
    // optimistic preview.
    const showOptimisticPreview = subagent !== undefined || (mode === 'steer' && !direct)
    if (subagent !== undefined) {
      if (subagent.entry.mode !== 'continuable') throw new Error(translate('app.error.subagentReadOnly'))
      if (!subagent.parentAvailable) throw new Error(translate('app.error.subagentParentUnavailable'))
      if (attachments.length > 0 && state.subagentImagePrompts !== true)
        throw new Error(translate('app.error.subagentAttachments'))
      if (text.trim() === '') throw new Error(translate('app.error.subagentMessageRequired'))
    }
    const messageAttachments: readonly MessageAttachment[] = attachments.map((attachment) => ({
      name: attachment.name,
      ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
    }))
    const showPreview = (): void => {
      if (text === '' && messageAttachments.length === 0) return
      setState((current) => {
        if (current.activeSessionId !== sessionId) return current
        return {
          ...current,
          timeline: {
            ...current.timeline,
            nodeChangeBase: current.timeline.nodes,
            nodeChangeStart: current.timeline.nodes.length,
            nodes: [
              ...current.timeline.nodes,
              {
                kind: 'user-message',
                id: optimisticId,
                markdown: text,
                ...(messageAttachments.length === 0 ? {} : { attachments: messageAttachments }),
              },
            ],
          },
        }
      })
    }
    if (showOptimisticPreview) showPreview()
    try {
      if (subagent === undefined)
        await client.request<unknown>(
          {
            type: 'session.sendPrompt',
            requestId: rpcRequestId,
            payload: {
              sessionId,
              text,
              attachments: [...attachments],
              ...(contextRefs.length === 0 ? {} : { contextRefs }),
              ...(contextWorkspaceFolderId === undefined ? {} : { contextWorkspaceFolderId }),
              mode,
            },
          },
          signal,
        )
      else
        await client.request<unknown>(
          {
            type: 'subagent.send',
            requestId: rpcRequestId,
            payload: {
              sessionId,
              message: text,
              mode,
              ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
            },
          },
          signal,
        )
      // The Extension Host released exactly the handles this snapshot named.
      // A chip captured while the request was in flight is a different handle
      // that is still live on the host, so only the admitted refs drop out —
      // mirroring how in-flight attachment drafts are kept.
      if (subagent === undefined && contextRefs.length > 0) {
        const admitted = new Set(contextRefs)
        setState((current) => ({
          ...current,
          editorContext: current.editorContext.filter((item) => !admitted.has(item.ref.contextRef)),
        }))
      }
    } catch (reason) {
      // Keep the identity after an abort: the RPC may already have committed,
      // and the caller uses it to watch for a late durable message.
      if (direct && signal?.aborted !== true)
        setState((current) => ({
          ...current,
          directPromptRequestIds: (current.directPromptRequestIds ?? []).filter((id) => id !== rpcRequestId),
          directPromptReceipts: (current.directPromptReceipts ?? []).filter(
            (entry) => entry.rpcId !== rpcRequestId,
          ),
        }))
      if (signal?.aborted !== true && subagent === undefined && mode === 'queue' && !direct)
        setState((current) => ({
          ...current,
          pendingPrompts: (current.pendingPrompts ?? []).filter((prompt) => prompt.id !== pendingId),
        }))
      if (signal?.aborted === true && !direct && subagent === undefined) {
        // The local projection may predate this prompt. Read the authoritative
        // queue before deciding there is nothing to revoke.
        void (async () => {
          const listed = await client
            .request<unknown>({
              type: 'session.queue.list',
              requestId: requestId(),
              payload: { sessionId },
            })
            .catch(() => undefined)
          if (!Array.isArray(listed)) return
          const queued = (listed as readonly QueuedInput[]).find((item) => item.rpcId === rpcRequestId)
          if (queued === undefined) return
          await client
            .request({
              type: 'session.queue.remove',
              requestId: requestId(),
              payload: { inputId: queued.id },
            })
            .catch(() => undefined)
          setState((current) => ({
            ...current,
            pendingPrompts: (current.pendingPrompts ?? []).filter((prompt) => prompt.id !== pendingId),
          }))
        })()
      }
      if (showOptimisticPreview)
        setState((current) => ({
          ...current,
          timeline: {
            ...current.timeline,
            nodeChangeBase: current.timeline.nodes,
            nodeChangeStart: 0,
            nodes: current.timeline.nodes.filter((node) => node.id !== optimisticId),
          },
        }))
      throw reason
    }
  }

  return { executeCommandRequest, sendUserTurn }
}
