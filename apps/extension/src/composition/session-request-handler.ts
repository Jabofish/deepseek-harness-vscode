import * as vscode from 'vscode'
import { type SessionSummary } from '@dsh-vscode/domain'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import { publicList } from './public-projection.js'
import { listScopedSessions } from './session-directory.js'
import { pathExists } from './runtime.js'
import { requireCatalogOwnedSession } from './session-scope.js'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import type { TranscriptWindowService } from '../view/transcript-window.js'
import { unsupportedRequest } from './request-routing.js'

type SessionRequest = Extract<WebviewRequest, { type: `session.${string}` }>
type SessionDependencies = Pick<
  RequestGatewayDependencies,
  | 'backendService'
  | 'workspaceUseCases'
  | 'sessionUseCases'
  | 'modelUseCases'
  | 'exportUseCases'
  | 'attachmentTokens'
  | 'editorContextUseCases'
  | 'contextOwnerForSession'
  | 'currentFeatureSessionBinding'
  | 'workspaceFolderIdForSession'
  | 'currentWorkspaceFolders'
  | 'listCurrentWorkspaces'
  | 'listCurrentArchivedSessionIds'
  | 'ensureCurrentWorkspace'
  | 'requireCurrentWorkspaceSession'
  | 'requireCurrentWorkspaceId'
  | 'requireOwnedQueuedInput'
  | 'resyncView'
  | 'prepareEditorSession'
> & {
  readonly transcript: TranscriptWindowService
  readonly publicValue: (value: unknown) => unknown
}

export function isSessionRequest(request: WebviewRequest): request is SessionRequest {
  return request.type.startsWith('session.')
}

export function createSessionRequestHandler(
  deps: SessionDependencies,
): (request: SessionRequest, signal: AbortSignal) => Promise<unknown> {
  const {
    backendService,
    workspaceUseCases,
    sessionUseCases,
    modelUseCases,
    exportUseCases,
    attachmentTokens,
    editorContextUseCases,
    contextOwnerForSession,
    currentFeatureSessionBinding,
    workspaceFolderIdForSession,
    currentWorkspaceFolders,
    listCurrentWorkspaces,
    ensureCurrentWorkspace,
    requireCurrentWorkspaceSession,
    requireCurrentWorkspaceId,
    requireOwnedQueuedInput,
    publicValue,
  } = deps

  /**
   * State the VS Code folder that guards a session's paths. Only this id is
   * accepted by feature routes, and the DSH workspace id is a different
   * namespace, so the Webview reads the ownership here instead of inferring it.
   */
  const withSessionWorkspaceScope = <T extends Pick<SessionSummary, 'cwd'>>(
    session: T,
  ): T & { readonly workspaceFolderId?: string } => {
    const folderId = workspaceFolderIdForSession(session)
    return folderId === undefined ? session : { ...session, workspaceFolderId: folderId }
  }
  return async (request: SessionRequest, signal: AbortSignal): Promise<unknown> => {
    if (request.type === 'session.move') {
      await requireCurrentWorkspaceId(request.payload.workspaceId, signal)
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return workspaceUseCases.insertSessionBefore(
        request.payload.workspaceId,
        request.payload.sessionId,
        request.payload.beforeSessionId,
        signal,
      )
    }

    if (request.type === 'session.list') {
      const { workspaceId, search, archived, cursor, limit } = request.payload
      const page = await listScopedSessions(
        deps,
        {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(search === undefined ? {} : { search }),
          ...(archived === undefined ? {} : { archived }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        },
        signal,
      )
      return publicValue({ ...page, items: page.items.map(withSessionWorkspaceScope) })
    }

    if (request.type === 'session.open') {
      const generation = deps.transcript.begin(request.payload.sessionId)
      try {
        let detail = await requireCurrentWorkspaceSession(request.payload.sessionId, signal, { fresh: true })
        for (let retry = 0; retry < 3 && deps.transcript.needsRefresh(generation); retry++) {
          deps.transcript.restart(generation)
          detail = await requireCurrentWorkspaceSession(request.payload.sessionId, signal, { fresh: true })
        }
        const transcript = deps.transcript.install(detail, generation)
        return publicValue(
          withSessionWorkspaceScope({
            ...detail,
            history: [],
            transcript,
            historyHasMore: transcript.hasMore,
            historyBeforeSequence: transcript.beforeSequence,
          }),
        )
      } finally {
        deps.transcript.cancel(generation)
      }
    }

    if (request.type === 'session.transcript.navigate') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return deps.transcript.navigate(
        request.payload.sessionId,
        request.payload.direction,
        request.payload.revision,
        signal,
      )
    }
    if (request.type === 'session.transcript.ack') {
      deps.transcript.acknowledge(request.payload.sessionId, request.payload.revision)
      return {}
    }
    if (request.type === 'session.transcript.resync') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      await deps.resyncView?.()
      return {}
    }
    if (request.type === 'session.transcript.openContent') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const content = await deps.transcript.content(
        request.payload.sessionId,
        request.payload.nodeId,
        request.payload.revision,
        signal,
      )
      const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' })
      signal.throwIfAborted()
      await vscode.window.showTextDocument(document, { preview: true })
      return { opened: true }
    }
    if (request.type === 'session.transcript.content') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const content = await deps.transcript.content(
        request.payload.sessionId,
        request.payload.nodeId,
        request.payload.revision,
        signal,
        false,
      )
      return { content }
    }
    if (request.type === 'session.transcript.node') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return {
        node: deps.transcript.fullNode(
          request.payload.sessionId,
          request.payload.nodeId,
          request.payload.revision,
          signal,
        ),
      }
    }

    if (request.type === 'session.create') {
      const workspace = await ensureCurrentWorkspace(request.payload.workspaceId, signal)
      const resolvedConfiguration = await modelUseCases.resolveSessionConfiguration(
        request.payload.configuration,
        signal,
      )
      return publicValue(
        withSessionWorkspaceScope(
          await sessionUseCases.create(
            {
              workspaceId: workspace.id,
              ...(request.payload.sessionId === undefined ? {} : { sessionId: request.payload.sessionId }),
              ...(request.payload.reuseWorkspaceBlank === true ? { reuseWorkspaceBlank: true as const } : {}),
              ...(request.payload.title === undefined ? {} : { title: request.payload.title }),
              configuration: resolvedConfiguration,
            },
            signal,
          ),
        ),
      )
    }

    if (request.type === 'session.rename') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      // The host normalizes the stored title and returns what it accepted; the
      // Webview shows that value so the row never claims a title the session
      // log does not hold.
      return {
        title: await backendService
          .requireBackend()
          .sessions.rename(request.payload.sessionId, request.payload.title, signal),
      }
    }

    if (request.type === 'session.remove') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal, { allowArchived: true })
      return sessionUseCases.remove(request.payload.sessionId, signal)
    }

    if (request.type === 'session.fork') {
      await requireCatalogOwnedSession(
        backendService.requireBackend(),
        request.payload.sessionId,
        await listCurrentWorkspaces(signal),
        currentWorkspaceFolders(),
        signal,
      )
      return publicValue(
        withSessionWorkspaceScope(
          await sessionUseCases.fork(request.payload.sessionId, request.payload.atSeq, signal),
        ),
      )
    }

    if (request.type === 'session.archive') {
      // Restoring is the one archiving direction that must reach an archived
      // session; archiving an archived session stays refused like any other
      // route to it.
      await requireCurrentWorkspaceSession(
        request.payload.sessionId,
        signal,
        request.payload.archived === false ? { allowArchived: true } : {},
      )
      return sessionUseCases.setArchived(request.payload.sessionId, request.payload.archived, signal)
    }

    if (request.type === 'session.sendPrompt') {
      const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      // A restored/editor-tab session may send before an open/selection event.
      // Prepare optional editor access before the model can issue its first tool.
      await deps.prepareEditorSession?.(session.id, signal)
      const attachments = attachmentTokens.resolve(request.payload.attachments)
      const contextRefs = request.payload.contextRefs ?? []
      const contextOwner = contextOwnerForSession(
        session,
        request.payload.contextWorkspaceFolderId,
        contextRefs.length > 0,
      )
      const resolvedContext =
        contextRefs.length === 0
          ? []
          : await editorContextUseCases.resolveForPrompt(
              {
                ...contextOwner,
                ...currentFeatureSessionBinding(request.payload.sessionId),
                contextRefs,
              },
              signal,
            )
      const result = await sessionUseCases.sendPrompt(
        {
          requestId: request.requestId,
          sessionId: request.payload.sessionId,
          text: request.payload.text,
          attachments: [...attachments, ...resolvedContext.map((entry) => entry.attachment)],
        },
        request.payload.mode ?? 'queue',
        signal,
      )
      // The Webview keeps the chips after a failed send so the user can retry;
      // retain their opaque handles on that path as well. Successful admission
      // consumes them exactly once.
      attachmentTokens.release(request.payload.attachments)
      if (contextRefs.length > 0) await editorContextUseCases.release(contextRefs, contextOwner)
      deps.transcript.showLatest(request.payload.sessionId)
      return result
    }

    if (request.type === 'session.cancel') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal, { controlOnly: true })
      return sessionUseCases.cancel(request.payload.sessionId, signal)
    }

    if (request.type === 'session.queue.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(
        await backendService.requireBackend().sessions.listQueue(request.payload.sessionId, signal),
      )
    }

    if (request.type === 'session.queue.update') {
      await requireOwnedQueuedInput(request.payload.inputId, signal)
      return backendService
        .requireBackend()
        .sessions.updateQueuedInput(request.payload.inputId, request.payload.text, signal)
    }

    if (request.type === 'session.queue.remove') {
      await requireOwnedQueuedInput(request.payload.inputId, signal)
      return backendService.requireBackend().sessions.removeQueuedInput(request.payload.inputId, signal)
    }

    if (request.type === 'session.queue.steer') {
      await requireOwnedQueuedInput(request.payload.inputId, signal)
      return backendService
        .requireBackend()
        .sessions.convertQueuedInputToSteer(request.payload.inputId, signal)
    }

    if (request.type === 'session.configure') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return modelUseCases.setSessionConfiguration(
        request.payload.sessionId,
        request.payload.configuration,
        signal,
      )
    }

    if (request.type === 'session.export') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const uri = await vscode.window.showSaveDialog({ saveLabel: 'Export DSH session' })
      if (uri === undefined) return { cancelled: true }
      const destinationExists = await pathExists(uri.fsPath)
      if (destinationExists) {
        const choice = await vscode.window.showWarningMessage(
          'The selected export file already exists. Replace it?',
          { modal: true, detail: 'The existing file will be recoverably replaced only after confirmation.' },
          'Overwrite',
        )
        if (choice !== 'Overwrite') return { cancelled: true }
      }
      return exportUseCases.exportSession(request.payload, uri.fsPath, signal, destinationExists)
    }
    return unsupportedRequest(request)
  }
}
