import { AppError } from '@dsh-vscode/domain'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import * as vscode from 'vscode'
import { openSkillDocument, publicSkills } from '../backend/skill-documents.js'
import { resolveLinkTarget } from '../navigation/link-target.js'
import { SIDEBAR_SURFACE_ID, VIEW_ID } from '../constants.js'
import { DshWebviewViewProvider } from '../view/dsh-webview-view-provider.js'
import { EditorChatSurfaceManager } from '../view/editor-chat-surface-manager.js'
import { WebviewMessageRouter } from '../view/message-router.js'
import { publicWorkspaceSummary } from '../view/public-value.js'
import { requestOptionalProviderApiKey, requestProviderSecret } from '../vscode/credential-input.js'
import { createAttachmentRequestHandler, isAttachmentRequest } from './attachment-request-handler.js'
import {
  publicValue as projectPublicValue,
  publicDiagnosticsSnapshot,
  publicExtensionSettings,
  publicList,
  publicState,
} from './public-projection.js'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import { questionResponse } from './session-payload.js'
import { createSessionRequestHandler, isSessionRequest } from './session-request-handler.js'
import { requiresTrustedWorkspace } from './workspace-guards.js'
import { createSessionNavigation, type SessionNavigation } from './session-navigation.js'
export type { RequestGatewayDependencies } from './request-gateway-dependencies.js'

export interface OpenLinkResult {
  readonly opened: boolean
  readonly message?: string
}

export interface RequestGateway {
  readonly sessionNavigation: SessionNavigation
  readonly router: WebviewMessageRouter
  readonly provider: DshWebviewViewProvider
  /** Editor-area chat surfaces; the composition root owns their lifecycle. */
  readonly editorSurfaces: EditorChatSurfaceManager
  readonly openDroppedSession: (
    sessionId: string,
    column: vscode.ViewColumn | undefined,
    signal: AbortSignal,
  ) => Promise<void>
  readonly moveChatToSidebar: (surfaceId?: string, signal?: AbortSignal) => Promise<void>
}

function workspaceTrustRequired(): AppError {
  return new AppError({
    code: 'PERMISSION_DENIED',
    message: 'Trust this workspace before running DSH operations that access files or execute tools.',
    retryable: false,
  })
}

/** Editor tab labels come from the Webview: bound them and strip control text. */
function editorTabTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined
  const printable = [...title]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f ? ' ' : character
    })
    .join('')
  const cleaned = printable.replace(/\s+/gu, ' ').trim()
  return cleaned === '' ? undefined : cleaned.slice(0, 120)
}

/** Every Webview request route plus the router and view provider that feed it. */
export function createRequestGateway(deps: RequestGatewayDependencies): RequestGateway {
  const {
    post,
    postTo,
    postEvent,
    postEventTo,
    surfaces,
    handleFeatureRequest,
    diagnostics,
    context,
    currentWorkspaceFolders,
    currentWorkspaceFolder,
    connect,
    reconnect,
    configureConnection,
    runtimeUseCases,
    runtimeLocator,
    coordinator,
    extensionVersion,
    configuration,
    backendService,
    listCurrentWorkspaces,
    listCurrentArchivedSessionIds,
    ensureCurrentWorkspace,
    requireCurrentWorkspaceSession,
    requireCurrentWorkspaceId,
    requireOwnedQueuedInput,
    requireOwnedGoal,
    requireOwnedPermission,
    requireOwnedQuestion,
    workspaceUseCases,
    sessionUseCases,
    modelUseCases,
    interactionUseCases,
    settingsUseCases,
    providerSettingsUseCases,
    advancedUseCases,
    exportUseCases,
    temporaryWorkspaceManager,
    attachmentTokens,
    editorContextUseCases,
    contextOwnerForSession,
    currentFeatureSessionBinding,
    workspaceFolderIdForSession,
    startJobFollow,
    stopJobFollow,
    stopAllJobFollows,
    editorContextProvider,
    sessionWatch,
  } = deps
  const publicValue = (value: unknown): unknown =>
    projectPublicValue(value, [
      ...currentWorkspaceFolders().map((folder) => folder.uri.fsPath),
      ...(temporaryWorkspaceManager.current?.path === undefined
        ? []
        : [temporaryWorkspaceManager.current.path]),
      ...(temporaryWorkspaceManager.reference?.path === undefined
        ? []
        : [temporaryWorkspaceManager.reference.path]),
    ])
  const openMarkdownLink = async (href: string, revealInFolder = false): Promise<OpenLinkResult> => {
    const target = href.trim()
    const fileUri = target.toLowerCase().startsWith('file:') ? vscode.Uri.parse(target) : undefined
    const roots = [
      ...currentWorkspaceFolders().map((folder) => folder.uri.fsPath),
      ...(temporaryWorkspaceManager.current?.path === undefined
        ? []
        : [temporaryWorkspaceManager.current.path]),
      ...(temporaryWorkspaceManager.reference?.path === undefined
        ? []
        : [temporaryWorkspaceManager.reference.path]),
    ]
    const resolved = resolveLinkTarget({
      href: target,
      roots,
      basePath: currentWorkspaceFolder()?.uri.fsPath ?? roots[0],
      ...(fileUri === undefined ? {} : { fileUrlPath: fileUri.fsPath }),
    })
    if (resolved.kind === 'rejected') return { opened: false, message: resolved.message }
    if (resolved.kind === 'external') {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(resolved.url))
      return opened ? { opened: true } : { opened: false, message: 'Unable to open the external link.' }
    }

    try {
      if (revealInFolder) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolved.path))
        return { opened: true }
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.path))
      await vscode.window.showTextDocument(document, { preview: true })
      return { opened: true }
    } catch {
      return { opened: false, message: 'The linked workspace file could not be opened.' }
    }
  }
  const sessionRequestFor = (surfaceId: string | undefined): ReturnType<typeof createSessionRequestHandler> =>
    createSessionRequestHandler({
      ...(deps.prepareEditorSession === undefined ? {} : { prepareEditorSession: deps.prepareEditorSession }),
      transcript: deps.transcript.forSurface(surfaceId ?? SIDEBAR_SURFACE_ID),
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
      listCurrentArchivedSessionIds,
      ensureCurrentWorkspace,
      requireCurrentWorkspaceSession,
      requireCurrentWorkspaceId,
      requireOwnedQueuedInput,
      publicValue,
    })
  const handleAttachmentRequest = createAttachmentRequestHandler({
    backendService,
    sessionUseCases,
    attachmentTokens,
    editorContextProvider,
    requireCurrentWorkspaceSession,
  })

  // Assigned after the router exists (the manager routes panel messages through
  // it); no request can arrive before the gateway has finished composing.
  const editorChatSurfaces: { current?: EditorChatSurfaceManager } = {}
  const selectionRequests = new Map<string, object>()
  const syncSessionDisplay = (surfaceId: string): void => {
    const surface = surfaces.get(surfaceId)
    sessionWatch.surfaceVisibilityChanged(surfaceId, surface?.visible === true && surface.isReady)
  }
  const selectDisplayedSession = (surfaceId: string, sessionId: string): void => {
    const surface = surfaces.get(surfaceId)
    if (surface === undefined) return
    sessionWatch.surfaceDisplaysSession(surfaceId, sessionId, surface.visible && surface.isReady)
  }
  const surfaceRoutesUnavailable = (): AppError =>
    new AppError({
      code: 'FEATURE_DISABLED',
      message: 'The editor chat surface is not available in this extension build.',
      retryable: false,
    })
  const moveChatToSidebar = async (surfaceId?: string, signal?: AbortSignal): Promise<void> => {
    const manager = editorChatSurfaces.current
    if (manager === undefined) throw surfaceRoutesUnavailable()
    const source =
      surfaceId === undefined || surfaceId === SIDEBAR_SURFACE_ID
        ? (manager.surfacesById.find((surface) => surface.panel.active) ?? manager.mostRecent)
        : surfaces.get(surfaceId)
    const sessionId = source?.sessionId
    if (sessionId !== undefined)
      await requireCurrentWorkspaceSession(sessionId, signal ?? new AbortController().signal)
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`)
    if (!(await provider.waitUntilReady()) || signal?.aborted === true) throw surfaceRoutesUnavailable()
    if (
      sessionId !== undefined &&
      !(await postEventTo(SIDEBAR_SURFACE_ID, 'ui.surface.openInSidebar', { sessionId }))
    )
      throw surfaceRoutesUnavailable()
    // Preserve the source if the target could not be shown or delivered to.
    if (surfaceId !== undefined && surfaceId !== SIDEBAR_SURFACE_ID) manager.close(surfaceId)
    else manager.closeAll()
  }

  let openingConnection: { readonly abort: AbortController; readonly promise: Promise<unknown> } | undefined
  const handleRequest = async (
    request: WebviewRequest,
    signal: AbortSignal,
    surfaceId: string | undefined,
  ): Promise<unknown> => {
    if (request.type === 'ui.events.ack') {
      if (surfaceId !== undefined) deps.acknowledgeHostEvents?.(surfaceId, request.payload.sequence)
      return {}
    }
    if (request.type === 'surface.titlebarLayout') {
      // Editor tabs have different widths and cannot change the sidebar's chrome.
      if (surfaceId !== SIDEBAR_SURFACE_ID) return { updated: false }
      signal.throwIfAborted()
      await vscode.commands.executeCommand('setContext', 'dsh.chatTitlebarLayout', request.payload.layout)
      return { updated: true }
    }
    if (request.type === 'app.ready') {
      if (surfaceId !== undefined) deps.forgetHostSurface?.(surfaceId)
      const opening = openingConnection
      if (request.payload?.snapshotOnly === true) {
        // Delivery recovery rereads authority; it never starts or reconnects DSH.
      } else if (opening !== undefined && !opening.abort.signal.aborted) {
        try {
          await opening.promise
        } finally {
          if (openingConnection === opening) openingConnection = undefined
        }
      } else if (coordinator.getState().kind !== 'connected') await connect(signal)
      signal.throwIfAborted()
      const current = coordinator.getState()
      const surface = surfaceId === undefined ? undefined : surfaces.get(surfaceId)
      if (surface !== undefined) {
        await announceSurface(
          surface.surfaceId,
          {
            kind: surface.kind,
            ...(surface.sessionId === undefined ? {} : { sessionId: surface.sessionId }),
          },
          () => !signal.aborted && surfaces.get(surface.surfaceId) === surface,
        )
      } else {
        await postEvent('connection.snapshot', publicState(current, diagnostics.connectionOutput?.()))
      }
      // Joining a surface must not reattach shared services, stop Job follows
      // or broadcast a connection transition to existing chats.
      if (current.kind === 'connected')
        for (const event of backendService.replayEvents()) {
          signal.throwIfAborted()
          if (surfaceId === undefined) await postEvent(event.type, publicValue(event))
          else await postEventTo(surfaceId, event.type, publicValue(event))
        }
      return { connected: current.kind === 'connected' }
    }
    if (request.type === 'connection.configure') {
      openingConnection?.abort.abort()
      openingConnection = undefined
      return configureConnection(request.payload.mode, request.payload.endpoint, signal)
    }
    if (request.type === 'connection.retry') {
      openingConnection?.abort.abort()
      openingConnection = undefined
      return reconnect(signal)
    }
    if (request.type === 'view.openLink') return openMarkdownLink(request.payload.href)
    if (request.type === 'view.showInFolder') return openMarkdownLink(request.payload.href, true)
    if (request.type === 'runtime.action') {
      await runtimeUseCases.execute(request.payload.action)
      if (request.payload.action === 'install' || request.payload.action === 'select') {
        // Install or select may move or replace the executable; the memoized
        // lookup and its persisted hint must not outlive that change.
        runtimeLocator.invalidate()
        return connect(signal)
      }
      return undefined
    }
    if (request.type === 'runtime.update.check')
      return publicValue(await runtimeUseCases.checkForUpdates(request.payload.force === true, signal))
    if (request.type === 'runtime.update.install') {
      const snapshot = await runtimeUseCases.installVersion(request.payload.version, signal)
      // The global install replaced the executable behind the same path; drop
      // the memoized version so the next connection reports the new one.
      runtimeLocator.invalidate()
      return publicValue(snapshot)
    }
    if (request.type === 'diagnostics.show') {
      diagnostics.show()
      return { shown: true }
    }
    if (request.type === 'diagnostics.snapshot')
      return publicValue(
        publicDiagnosticsSnapshot(
          coordinator.getState(),
          extensionVersion,
          diagnostics.recentEvents(),
          configuration.read().connection.mode,
        ),
      )
    const isTemporarySessionCreate =
      request.type === 'session.create' && currentWorkspaceFolders().length === 0
    if (
      !vscode.workspace.isTrusted &&
      requiresTrustedWorkspace(request.type) &&
      !isTemporarySessionCreate &&
      request.type !== 'interaction.permission.respond'
    )
      throw workspaceTrustRequired()
    if (request.type === 'surface.openInEditor') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      if (signal.aborted)
        throw new AppError({
          code: 'REQUEST_CANCELLED',
          message: 'The originating chat was closed or the operation was cancelled.',
          retryable: false,
        })
      const manager = editorChatSurfaces.current
      if (manager === undefined) throw surfaceRoutesUnavailable()
      if (request.payload.replaceCurrent === true) {
        if (surfaceId === undefined || surfaces.get(surfaceId)?.kind !== 'editor')
          throw surfaceRoutesUnavailable()
        manager.bind(surfaceId, request.payload.sessionId, editorTabTitle(request.payload.title))
        selectDisplayedSession(surfaceId, request.payload.sessionId)
      } else {
        const surface = manager.open(request.payload.sessionId, editorTabTitle(request.payload.title))
        selectDisplayedSession(surface.surfaceId, request.payload.sessionId)
      }
      return { surface: 'editor' as const }
    }
    if (request.type === 'surface.moveToSidebar') {
      await moveChatToSidebar(surfaceId, signal)
      return { surface: 'sidebar' as const }
    }
    if (isSessionRequest(request)) {
      const selection = ['session.open', 'session.create', 'session.fork'].includes(request.type)
        ? {}
        : undefined
      const targetSurface = surfaceId ?? SIDEBAR_SURFACE_ID
      if (selection !== undefined) selectionRequests.set(targetSurface, selection)
      const result = await sessionRequestFor(surfaceId)(request, signal)
      // A rename is the one session mutation that changes a tab label while the
      // tab is open; the Host applies the accepted title so a second Webview
      // (the editor tab) does not have to observe the catalog change.
      if (request.type === 'session.rename') {
        const title = (result as { readonly title?: unknown } | undefined)?.title
        const accepted = typeof title === 'string' ? editorTabTitle(title) : undefined
        if (accepted !== undefined) {
          editorChatSurfaces.current?.retitle(request.payload.sessionId, accepted)
        }
        if (typeof title === 'string')
          void postEvent('session.title', { sessionId: request.payload.sessionId, title })
      }
      // Only an accepted current selection owns display demand; an obsolete
      // open reply must not replace the session a rapid switch already chose.
      const currentSelection =
        selection !== undefined &&
        selectionRequests.get(targetSurface) === selection &&
        !signal.aborted &&
        surfaces.get(targetSurface) !== undefined
      if (request.type === 'session.open' && currentSelection) {
        selectDisplayedSession(targetSurface, request.payload.sessionId)
        sessionNavigation.select(request.payload.sessionId)
      }
      if (
        (request.type === 'session.create' || request.type === 'session.fork') &&
        typeof result === 'object' &&
        result !== null &&
        'id' in result &&
        typeof result.id === 'string'
      ) {
        if (currentSelection) {
          selectDisplayedSession(targetSurface, result.id)
          sessionNavigation.select(result.id)
        }
      }
      if (
        [
          'session.create',
          'session.fork',
          'session.archive',
          'session.remove',
          'session.move',
          'session.rename',
        ].includes(request.type)
      )
        sessionNavigation.invalidate()
      return result
    }
    if (isAttachmentRequest(request)) return handleAttachmentRequest(request, signal)

    if (request.type === 'workspace.list') {
      const workspaces = await listCurrentWorkspaces(signal)
      const archivedSessionIds = await listCurrentArchivedSessionIds(workspaces, signal)
      return publicValue({ items: workspaces.map(publicWorkspaceSummary), archivedSessionIds })
    }
    if (request.type === 'workspace.addFolder') {
      signal.throwIfAborted()
      // VS Code owns directory selection, workspace trust, remote URIs and
      // persistence. Its folder-change event refreshes the DSH registration.
      await vscode.commands.executeCommand('workbench.action.addRootFolder')
      return { opened: true }
    }
    if (request.type === 'workspace.rename') {
      await requireCurrentWorkspaceId(request.payload.workspaceId, signal)
      return workspaceUseCases.rename(request.payload.workspaceId, request.payload.name, signal)
    }
    if (request.type === 'workspace.remove') {
      await requireCurrentWorkspaceId(request.payload.workspaceId, signal)
      const removesTemporaryWorkspace =
        request.payload.workspaceId === temporaryWorkspaceManager.current?.id ||
        request.payload.workspaceId === temporaryWorkspaceManager.reference?.id
      const result = await workspaceUseCases.remove(request.payload.workspaceId, signal)
      if (removesTemporaryWorkspace) await temporaryWorkspaceManager.forget(true)
      return result
    }
    if (request.type === 'workspace.move') {
      await requireCurrentWorkspaceId(request.payload.workspaceId, signal)
      return workspaceUseCases.insertBefore(
        request.payload.workspaceId,
        request.payload.beforeWorkspaceId,
        signal,
      )
    }
    if (request.type === 'reference.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const backend = backendService.requireBackend()
      const files = backend.references.listFiles(request.payload.sessionId, request.payload.query, signal)
      const sessions =
        request.payload.quoted === true
          ? Promise.resolve([])
          : backend.references.listSessions(request.payload.sessionId, request.payload.query, signal)
      const [fileCandidates, sessionCandidates] = await Promise.all([files, sessions])
      return publicValue({ files: fileCandidates, sessions: sessionCandidates })
    }
    if (request.type === 'feedback.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(
        await backendService.requireBackend().feedback.list(request.payload.sessionId, signal),
      )
    }
    if (request.type === 'feedback.toggle') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(
        await backendService
          .requireBackend()
          .feedback.put(
            request.payload.sessionId,
            request.payload.messageId,
            request.payload.rating,
            request.payload.note,
            request.payload.category,
            signal,
          ),
      )
    }
    if (request.type === 'feedback.note') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(
        await backendService
          .requireBackend()
          .feedback.put(
            request.payload.sessionId,
            request.payload.messageId,
            request.payload.rating,
            request.payload.note,
            request.payload.category,
            signal,
          ),
      )
    }
    if (request.type === 'feedback.remove') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return backendService
        .requireBackend()
        .feedback.remove(request.payload.sessionId, request.payload.messageId, signal)
    }
    if (request.type === 'models.list')
      return publicList(await modelUseCases.listModels(request.payload.providerId, signal))
    if (request.type === 'models.session.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(await modelUseCases.listSessionModels(request.payload.sessionId, signal))
    }
    if (request.type === 'models.discover')
      return publicList(
        await modelUseCases.discoverModels(
          {
            settingsNamespace: request.payload.settingsNamespace,
            ...(request.payload.providerId === undefined ? {} : { providerId: request.payload.providerId }),
            ...(request.payload.baseUrl === undefined ? {} : { baseUrl: request.payload.baseUrl }),
            ...(request.payload.api === undefined ? {} : { api: request.payload.api }),
          },
          signal,
        ),
      )
    if (request.type === 'models.discover.custom') {
      backendService.requireBackend()
      const apiKey = await requestOptionalProviderApiKey(
        vscode.window,
        request.payload.providerId ?? 'custom provider',
      )
      return publicList(
        await modelUseCases.discoverModels(
          {
            settingsNamespace: request.payload.settingsNamespace,
            ...(request.payload.providerId === undefined ? {} : { providerId: request.payload.providerId }),
            ...(request.payload.baseUrl === undefined ? {} : { baseUrl: request.payload.baseUrl }),
            ...(request.payload.api === undefined ? {} : { api: request.payload.api }),
            ...(apiKey === undefined ? {} : { apiKey }),
          },
          signal,
        ),
      )
    }
    if (request.type === 'permissions.presets.list')
      return publicValue(await modelUseCases.readPermissionCatalog(signal))
    if (request.type === 'providers.list') return publicList(await modelUseCases.listProviders(signal))
    if (request.type === 'provider.secret.configure') {
      const backend = backendService.requireBackend()
      const value = await requestProviderSecret(
        vscode.window,
        request.payload.providerId,
        request.payload.field,
      )
      if (value === undefined) return { configured: false, cancelled: true }
      await backend.credentials.setSecret(request.payload.providerId, request.payload.field, value, signal)
      return { configured: true }
    }
    if (request.type === 'provider.secret.remove')
      return backendService
        .requireBackend()
        .credentials.removeSecret(request.payload.providerId, request.payload.field, signal)
    if (request.type === 'provider.custom.create') {
      backendService.requireBackend()
      const apiKey = await requestOptionalProviderApiKey(vscode.window, request.payload.providerId)
      return publicValue(
        await providerSettingsUseCases.createCustomProvider(
          {
            settingsNamespace: request.payload.settingsNamespace,
            collectionPath: request.payload.collectionPath,
            providerId: request.payload.providerId,
            ...(request.payload.displayName === undefined
              ? {}
              : { displayName: request.payload.displayName }),
            api: request.payload.api,
            baseUrl: request.payload.baseUrl,
            models: request.payload.models,
            expectedRevision: request.payload.expectedRevision,
          },
          apiKey,
          signal,
        ),
      )
    }
    if (request.type === 'plugin.credential.configure') {
      const value = await requestProviderSecret(vscode.window, 'plugin', request.payload.ref)
      if (value === undefined) return { configured: false, cancelled: true }
      await backendService.requireBackend().credentials.setReference(request.payload.ref, value, signal)
      return { configured: true }
    }
    if (request.type === 'plugin.credential.remove')
      return backendService.requireBackend().credentials.unsetReference(request.payload.ref, signal)
    if (request.type === 'interaction.permission.respond') {
      await requireOwnedPermission(request.payload.interactionId, signal)
      if (
        !vscode.workspace.isTrusted &&
        backendService
          .requireBackend()
          .interactions.permissionOptionKind?.(request.payload.interactionId, request.payload.optionId) !==
          'deny'
      )
        throw workspaceTrustRequired()
      return interactionUseCases.respondToPermission(
        request.payload.interactionId,
        request.payload.optionId,
        signal,
      )
    }
    if (request.type === 'interaction.question.respond') {
      const backend = backendService.requireBackend()
      await requireOwnedQuestion(request.payload.questionId, signal, request.payload.identity)
      if (backendService.requireBackend().interactions !== backend.interactions)
        throw new AppError({
          code: 'STALE_INTERACTION',
          message: 'The DSH question connection changed.',
          retryable: true,
        })
      return interactionUseCases.respondToQuestion(
        request.payload.questionId,
        questionResponse(request.payload.response),
        signal,
        request.payload.identity,
      )
    }
    if (request.type === 'interaction.question.cancel') {
      const backend = backendService.requireBackend()
      await requireOwnedQuestion(request.payload.questionId, signal, request.payload.identity)
      if (backendService.requireBackend().interactions !== backend.interactions)
        throw new AppError({
          code: 'STALE_INTERACTION',
          message: 'The DSH question connection changed.',
          retryable: true,
        })
      return interactionUseCases.cancelQuestion(request.payload.questionId, signal, request.payload.identity)
    }
    if (request.type === 'settings.read') return publicValue(await settingsUseCases.read(signal))
    if (request.type === 'settings.openDocument') return settingsUseCases.openDocument(signal)
    if (request.type === 'settings.openKeyboardShortcuts') {
      await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings')
      return undefined
    }
    if (request.type === 'extensionSettings.read')
      return publicValue(publicExtensionSettings(configuration.read(), extensionVersion))
    if (request.type === 'settings.update')
      return settingsUseCases.update(
        request.payload.path,
        request.payload.value,
        request.payload.expectedRevision,
        signal,
      )
    if (request.type === 'settings.unset')
      return settingsUseCases.unset(request.payload.path, request.payload.expectedRevision, signal)
    if (request.type === 'settings.mutate')
      return settingsUseCases.mutate(
        request.payload.namespace,
        request.payload.operations,
        request.payload.expectedRevision,
        signal,
      )
    if (request.type === 'goal.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(await advancedUseCases.listGoals(request.payload.sessionId, signal))
    }
    if (request.type === 'goal.update') {
      await requireOwnedGoal(request.payload.goalId, signal)
      return backendService.requireBackend().goals.update(
        request.payload.goalId,
        {
          ...(request.payload.title === undefined ? {} : { title: request.payload.title }),
          ...(request.payload.status === undefined ? {} : { status: request.payload.status }),
          ...(request.payload.maxGoalRounds === undefined
            ? {}
            : { maxGoalRounds: request.payload.maxGoalRounds }),
        },
        signal,
      )
    }
    if (request.type === 'goal.clear') {
      await requireOwnedGoal(request.payload.goalId, signal)
      return advancedUseCases.clearGoal(request.payload.goalId, signal)
    }
    if (request.type === 'job.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(await advancedUseCases.listJobs(request.payload.sessionId, signal))
    }
    if (request.type === 'job.kill') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const currentJobs = await advancedUseCases.listJobs(request.payload.sessionId, signal)
      if (!currentJobs.some((job) => job.id === request.payload.jobId))
        throw new AppError({
          code: 'DSH_NOT_FOUND',
          message: 'This job is no longer visible in the selected session.',
          retryable: false,
        })
      return {
        outcome: await advancedUseCases.killJob(request.payload.sessionId, request.payload.jobId, signal),
      }
    }
    if (request.type === 'job.follow.start')
      return startJobFollow(
        request.payload.sessionId,
        request.payload.jobId,
        request.payload.followId,
        request.payload.from,
        signal,
      )
    if (request.type === 'job.follow.stop') {
      // Start already validated session ownership. Stop only closes the exact
      // Host-owned observer; rechecking workspace membership could strand it
      // after the session has been removed from the current workspace.
      return {
        stopped: stopJobFollow(request.payload.sessionId, request.payload.jobId, request.payload.followId),
      }
    }
    if (request.type === 'subagent.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(await advancedUseCases.listSubagents(request.payload.sessionId, signal))
    }
    if (request.type === 'subagent.history') {
      const detail = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const surfaceTranscript = deps.transcript.forSurface(surfaceId ?? SIDEBAR_SURFACE_ID)
      const generation = surfaceTranscript.begin(request.payload.sessionId, true)
      try {
        const page = await advancedUseCases.listSubagentHistory(request.payload.sessionId, {}, signal)
        const transcript = surfaceTranscript.installPage(
          request.payload.sessionId,
          page,
          generation,
          detail.cwd,
        )
        return publicValue({
          transcript,
          ...(page.projection === undefined ? {} : { projection: page.projection }),
        })
      } finally {
        surfaceTranscript.cancel(generation)
      }
    }
    if (request.type === 'subagent.send') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const attachments = attachmentTokens.resolve(request.payload.attachments ?? [])
      const result = await advancedUseCases.execute(
        'subagent.send',
        { ...request.payload, attachments },
        signal,
      )
      attachmentTokens.release(request.payload.attachments ?? [])
      return result
    }
    if (request.type === 'subagent.interrupt') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return advancedUseCases.execute('subagent.interrupt', request.payload, signal)
    }
    if (request.type === 'skill.list') {
      if (request.payload.sessionId !== undefined)
        await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(publicSkills(await advancedUseCases.listSkills(request.payload.sessionId, signal)))
    }
    if (request.type === 'skill.openDocument') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const documentPath = await advancedUseCases.skillDocumentPath(
        request.payload.sessionId,
        request.payload.skillId,
        signal,
      )
      await openSkillDocument(
        documentPath,
        async (target, lifetime) => {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target))
          lifetime.throwIfAborted()
          await vscode.window.showTextDocument(document, {
            preview: true,
            viewColumn: vscode.ViewColumn.Beside,
          })
        },
        signal,
      )
      return { opened: true }
    }
    if (request.type === 'command.list') {
      if (request.payload.sessionId !== undefined)
        await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(await advancedUseCases.listCommands(request.payload.sessionId, signal))
    }
    if (request.type === 'command.execute') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const attachments = attachmentTokens.resolve(request.payload.attachments ?? [])
      const result = await advancedUseCases.execute(
        'command.execute',
        { ...request.payload, attachments },
        signal,
      )
      // Keep attachment chips available for retry after a failed command, but
      // consume the opaque Host handles once command admission succeeds.
      attachmentTokens.release(request.payload.attachments ?? [])
      return publicValue(result)
    }
    if (request.type === 'plugin.inventory')
      return publicValue(await advancedUseCases.pluginInventory(signal))
    if (request.type === 'preset.list') return publicValue(await advancedUseCases.listPresets(signal))
    if (request.type === 'preset.read')
      return publicValue(await advancedUseCases.readPreset(request.payload.presetId, signal))
    if (request.type === 'preset.copy')
      return advancedUseCases.copyPreset(
        request.payload.from,
        request.payload.presetId,
        request.payload.name,
        signal,
      )
    if (request.type === 'preset.openDocument')
      return advancedUseCases.openPresetDocument(request.payload.presetId, signal)
    if (request.type === 'preset.remove')
      return advancedUseCases.removePreset(request.payload.presetId, signal)
    // Every declared route returns above, so this branch is unreachable while
    // the protocol and the host agree. A request the host cannot dispatch must
    // still fail: an invented success would hide the drift from the user.
    throw new AppError({
      code: 'FEATURE_DISABLED',
      message: 'The Webview request has no host route in this extension build.',
      retryable: false,
    })
  }
  const router = new WebviewMessageRouter({
    // One router serves every surface: answers go back to the surface that
    // asked, and only a caller without surface identity is broadcast.
    postMessage: (message, targetSurfaceId) =>
      targetSurfaceId === undefined ? post(message) : postTo(targetSurfaceId, message),
    handleRequest,
    handleFeatureRequest,
    // Unexpected (non-AppError) handler failures must stay diagnosable: the
    // Webview only sees a generic INTERNAL_ERROR, so keep the redacted cause
    // in the output channel the error message points users at.
    logUnexpectedError: (entry) => diagnostics.log('error', 'request-unexpected', { ...entry }),
  })
  const logWebviewMessageError = (error: unknown): void => {
    diagnostics.log('error', 'webview-message-unhandled', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
  // Shared teardown is decided by readiness, not by whichever surface happened
  // to disappear: as long as one surface can still receive messages, another
  // surface's job follows and editor context must survive its sibling closing.
  const runSharedSurfaceTeardownIfIdle = (): void => {
    if (surfaces.list().some((surface) => surface.isReady)) return
    stopAllJobFollows()
    editorContextProvider.dispose()
  }
  const onSurfaceWorkCancelled = (disposedSurfaceId: string): void => {
    selectionRequests.delete(disposedSurfaceId)
    sessionWatch.surfaceReleased(disposedSurfaceId)
    deps.forgetHostSurface?.(disposedSurfaceId)
    deps.transcript.remove(disposedSurfaceId)
    router.cancelSurface(disposedSurfaceId)
    runSharedSurfaceTeardownIfIdle()
  }
  // A surface that becomes ready after a handoff broadcast never saw it, so the
  // current editor-tab count is re-announced together with the surface identity.
  const announceSurface = async (
    surfaceId: string,
    assigned: { readonly kind: 'sidebar' | 'editor'; readonly sessionId?: string },
    isCurrent: () => boolean,
  ): Promise<void> => {
    // Send the existing connection before the assignment starts session.open.
    // A new editor should immediately show its chat instead of startup UI.
    await postEventTo(
      surfaceId,
      'connection.snapshot',
      publicState(coordinator.getState(), diagnostics.connectionOutput?.()),
      isCurrent,
    )
    await postEventTo(surfaceId, 'ui.surface.assigned', assigned, isCurrent)
    await postEventTo(surfaceId, 'ui.surface.handoff', { editorChats: surfaces.editorCount }, isCurrent)
  }
  const provider = new DshWebviewViewProvider({
    extensionUri: context.extensionUri,
    onMessage: (message) => router.handle(message, SIDEBAR_SURFACE_ID),
    onViewOpened: () => {
      if (
        openingConnection !== undefined ||
        !['idle', 'failed', 'runtime-missing', 'port-conflict'].includes(coordinator.getState().kind)
      )
        return
      const abort = new AbortController()
      const promise = connect(abort.signal)
      openingConnection = { abort, promise }
      void promise.catch(() => undefined)
    },
    onBecameReady: () => {
      deps.transcript.setVisible(SIDEBAR_SURFACE_ID, provider.visible)
      syncSessionDisplay(SIDEBAR_SURFACE_ID)
    },
    onViewDisposed: () => {
      openingConnection?.abort.abort()
      openingConnection = undefined
      onSurfaceWorkCancelled(SIDEBAR_SURFACE_ID)
    },
    onSurfaceClosed: () => {
      surfaces.unregister(SIDEBAR_SURFACE_ID)
      sessionWatch.surfaceReleased(SIDEBAR_SURFACE_ID)
    },
    onVisibilityChanged: (visible) => {
      deps.transcript.setVisible(SIDEBAR_SURFACE_ID, visible)
      syncSessionDisplay(SIDEBAR_SURFACE_ID)
    },
    onMessageError: logWebviewMessageError,
  })
  const editorSurfaceManager = new EditorChatSurfaceManager({
    surfaces,
    extensionUri: context.extensionUri,
    onMessage: (surfaceId, message) => router.handle(message, surfaceId),
    onMessageError: logWebviewMessageError,
    onBecameReady: (surface) => {
      deps.transcript.setVisible(surface.surfaceId, surface.visible)
      syncSessionDisplay(surface.surfaceId)
    },
    onDisposed: (surface) => onSurfaceWorkCancelled(surface.surfaceId),
    onVisibilityChanged: (surface) => {
      deps.transcript.setVisible(surface.surfaceId, surface.visible && surface.isReady)
      syncSessionDisplay(surface.surfaceId)
    },
    onCountChanged: (count) => {
      // Tab counts are advisory and never take over sidebar navigation.
      void postEvent('ui.surface.handoff', { editorChats: count })
    },
  })
  editorChatSurfaces.current = editorSurfaceManager
  surfaces.register(provider)
  const openDroppedSession = async (
    sessionId: string,
    column: vscode.ViewColumn | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!vscode.workspace.isTrusted) throw workspaceTrustRequired()
    if (coordinator.getState().kind !== 'connected') await connect(signal)
    const session = await requireCurrentWorkspaceSession(sessionId, signal)
    if (signal.aborted) return
    const surface = editorSurfaceManager.open(sessionId, editorTabTitle(session.title), column)
    selectDisplayedSession(surface.surfaceId, sessionId)
  }
  const sessionNavigation = createSessionNavigation(
    {
      ...deps,
      retitleEditorTab: (sessionId, title) => {
        const accepted = editorTabTitle(title)
        if (accepted !== undefined) editorSurfaceManager.retitle(sessionId, accepted)
      },
    },
    provider,
    (request, signal) => handleRequest(request, signal, undefined),
    openDroppedSession,
  )
  return {
    router,
    provider,
    editorSurfaces: editorSurfaceManager,
    moveChatToSidebar,
    openDroppedSession,
    sessionNavigation,
  }
}
