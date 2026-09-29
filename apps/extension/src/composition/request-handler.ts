import * as vscode from 'vscode'
import { stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentConfiguration,
  EditorContextOwner,
  SessionDetail,
  SessionSummary,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'
import type {
  AdvancedAgentUseCases,
  BackendService,
  DshConnectionCoordinator,
  EditorContextUseCases,
  ExportUseCases,
  InteractionUseCases,
  ModelSettingsUseCases,
  ProviderSettingsUseCases,
  RuntimeUseCases,
  SessionUseCases,
  SettingsUseCases,
  WorkspaceUseCases,
} from '@dsh-vscode/application'
import type { WebviewRequest, FeatureRequest } from '@dsh-vscode/webview-protocol'
import { WebviewMessageRouter } from '../view/message-router.js'
import { DshWebviewViewProvider } from '../view/dsh-webview-view-provider.js'
import { publicWorkspaceSummary } from '../view/public-value.js'
import type { DshRuntimeLocator } from '../backend/runtime-locator.js'
import type { TemporaryWorkspaceManager } from '../backend/temporary-workspace.js'
import type { VsCodeConfigurationSource } from '../config/configuration-source.js'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'
import type { EditorContextProvider } from '../editor/editor-context-provider.js'
import { openSkillDocument, publicSkills } from '../backend/skill-documents.js'
import { requestOptionalProviderApiKey, requestProviderSecret } from '../vscode/credential-input.js'
import {
  decodeCanonicalBase64,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  type AttachmentStore,
  type StoredAttachmentInput,
} from '../attachments/attachment-store.js'
import {
  attachmentMimeType,
  isImageMimeType,
  prepareAttachment,
  isAttachmentSupported,
  assertAttachmentSupported,
  validImageBytes,
} from '../attachments/attachment-codec.js'
import { requiresTrustedWorkspace } from './workspace-guards.js'
import {
  publicDiagnosticsSnapshot,
  publicExtensionSettings,
  publicList,
  publicValue,
} from './public-projection.js'
import { questionResponse } from './session-payload.js'
import { featureContextItem, listOpenFileCandidates, readOpenFileAttachment } from './editor-files.js'
import { pathExists } from './runtime.js'
import { sameWorkspacePath } from './workspace-state.js'
import { resolveLinkTarget } from '../navigation/link-target.js'
import type { SessionScope } from './session-scope.js'
import type { PostHostMessage } from './host-event-pipeline.js'

export interface OpenLinkResult {
  readonly opened: boolean
  readonly message?: string
}

export interface RequestGatewayDependencies {
  readonly post: PostHostMessage
  readonly handleFeatureRequest: (request: FeatureRequest, signal: AbortSignal) => Promise<unknown>
  readonly diagnostics: RedactedDiagnostics
  readonly context: vscode.ExtensionContext
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
  readonly currentWorkspaceFolder: () => vscode.WorkspaceFolder | undefined
  readonly connect: (signal?: AbortSignal) => Promise<unknown>
  readonly reconnect: (signal?: AbortSignal) => Promise<unknown>
  readonly configureConnection: (
    mode: 'auto' | 'custom',
    endpoint: string | undefined,
    signal?: AbortSignal,
  ) => Promise<unknown>
  readonly runtimeUseCases: RuntimeUseCases
  readonly runtimeLocator: DshRuntimeLocator
  readonly coordinator: DshConnectionCoordinator
  readonly extensionVersion: string
  readonly configuration: VsCodeConfigurationSource
  readonly backendService: BackendService
  readonly listCurrentWorkspaces: SessionScope['listCurrentWorkspaces']
  readonly listCurrentArchivedSessionIds: SessionScope['listCurrentArchivedSessionIds']
  readonly ensureCurrentWorkspace: SessionScope['ensureCurrentWorkspace']
  readonly requireCurrentWorkspaceSession: SessionScope['requireCurrentWorkspaceSession']
  readonly requireCurrentWorkspaceId: SessionScope['requireCurrentWorkspaceId']
  readonly requireOwnedQueuedInput: SessionScope['requireOwnedQueuedInput']
  readonly requireOwnedGoal: SessionScope['requireOwnedGoal']
  readonly requireOwnedPermission: SessionScope['requireOwnedPermission']
  readonly requireOwnedQuestion: SessionScope['requireOwnedQuestion']
  readonly workspaceUseCases: WorkspaceUseCases
  readonly sessionUseCases: SessionUseCases
  readonly modelUseCases: ModelSettingsUseCases
  readonly interactionUseCases: InteractionUseCases
  readonly settingsUseCases: SettingsUseCases
  readonly providerSettingsUseCases: ProviderSettingsUseCases
  readonly advancedUseCases: AdvancedAgentUseCases
  readonly exportUseCases: ExportUseCases
  readonly temporaryWorkspaceManager: TemporaryWorkspaceManager
  readonly attachmentTokens: AttachmentStore
  readonly editorContextUseCases: EditorContextUseCases
  readonly contextOwnerForSession: (
    session: SessionDetail,
    requestedWorkspaceFolderId: string | undefined,
    hasContext: boolean,
  ) => EditorContextOwner
  readonly currentFeatureSessionBinding: (sessionId: string) => {
    readonly sessionId: string
    readonly backendInstanceId: string
    readonly connectionGeneration: number
  }
  readonly workspaceFolderIdForSession: (session: Pick<SessionSummary, 'cwd'>) => string | undefined
  readonly resolveSessionConfiguration: (
    requested: AgentConfiguration,
    signal?: AbortSignal,
  ) => Promise<AgentConfiguration>
  readonly startJobFollow: (
    sessionId: string,
    jobId: string,
    followId: string,
    requestedFrom: number | undefined,
    signal: AbortSignal,
  ) => Promise<{ readonly started: boolean }>
  readonly stopJobFollow: (sessionId: string, jobId: string, followId: string) => boolean
  readonly stopAllJobFollows: (this: void) => void
  readonly editorContextProvider: EditorContextProvider
}

export interface RequestGateway {
  readonly router: WebviewMessageRouter
  readonly provider: DshWebviewViewProvider
}

/** Every Webview request route plus the router and view provider that feed it. */
export function createRequestGateway(deps: RequestGatewayDependencies): RequestGateway {
  const {
    post,
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
    resolveSessionConfiguration,
    startJobFollow,
    stopJobFollow,
    stopAllJobFollows,
    editorContextProvider,
  } = deps
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
  const supportsBinaryAttachments = (): boolean => {
    try {
      return backendService.requireBackend().sessions.supportsFileUploads === true
    } catch {
      return false
    }
  }
  const rememberSupportedAttachment = (
    input: StoredAttachmentInput,
  ): ReturnType<typeof attachmentTokens.remember> => {
    assertAttachmentSupported(input, supportsBinaryAttachments())
    return attachmentTokens.remember(input)
  }
  const handleRequest = async (request: WebviewRequest, signal: AbortSignal): Promise<unknown> => {
    if (request.type === 'app.ready') return connect(signal)
    if (request.type === 'connection.configure')
      return configureConnection(request.payload.mode, request.payload.endpoint, signal)
    if (request.type === 'connection.retry') return reconnect(signal)
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
    if (!vscode.workspace.isTrusted && requiresTrustedWorkspace(request.type) && !isTemporarySessionCreate)
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'Trust this workspace before running DSH operations that access files or execute tools.',
        retryable: false,
      })
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
      const folders = currentWorkspaceFolders()
      const workspaces = await listCurrentWorkspaces(signal)
      const archivedSessionIds = new Set(await listCurrentArchivedSessionIds(workspaces, signal))
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
      const sessionIds = new Set(workspaces.flatMap((workspace) => workspace.sessionIds ?? []))
      const workspaceId = request.payload.workspaceId
      const includeArchived = request.payload.archived ?? false
      if (workspaceId !== undefined && !workspaceIds.has(workspaceId)) return publicValue({ items: [] })
      const page = await sessionUseCases.list(
        {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(request.payload.search === undefined ? {} : { search: request.payload.search }),
          // The normal conversation list is the active, recoverable surface.
          // Archived sessions remain in DSH for recovery but must not stay in
          // the switcher after the user archives one.
          archived: includeArchived,
          ...(request.payload.cursor === undefined ? {} : { cursor: request.payload.cursor }),
          ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
        },
        signal,
      )
      return publicValue({
        ...page,
        items: page.items
          .filter((session) => {
            const belongsToCurrentWorkspace =
              (workspaceId === undefined
                ? workspaceIds.has(session.workspaceId)
                : session.workspaceId === workspaceId) || sessionIds.has(session.id)
            const sessionCwd = session.cwd
            const belongsByCwd =
              sessionCwd !== undefined &&
              folders.some((folder) => sameWorkspacePath(sessionCwd, folder.uri.fsPath))
            return (
              (belongsToCurrentWorkspace || belongsByCwd) &&
              archivedSessionIds.has(session.id) === includeArchived
            )
          })
          .map((session) => withSessionWorkspaceScope(session)),
      })
    }
    if (request.type === 'session.open') {
      const detail = await requireCurrentWorkspaceSession(request.payload.sessionId, signal, {
        fresh: true,
      })
      return publicValue(withSessionWorkspaceScope(detail))
    }
    if (request.type === 'session.history') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const page = await backendService
        .requireBackend()
        .sessions.history(request.payload.sessionId, request.payload.beforeSeq, signal, {
          ...(request.payload.maxMessages === undefined ? {} : { pageSize: request.payload.maxMessages }),
          ...(request.payload.pagePurpose === undefined ? {} : { pagePurpose: request.payload.pagePurpose }),
        })
      return publicValue({
        events: page.events,
        hasMore: page.hasMore,
        ...(page.beforeSequence === undefined ? {} : { beforeSeq: page.beforeSequence }),
        ...(page.coveredSequenceRanges === undefined ? {} : { coveredSeqRanges: page.coveredSequenceRanges }),
        ...(page.projection === undefined ? {} : { projection: page.projection }),
      })
    }
    if (request.type === 'session.create') {
      const workspace = await ensureCurrentWorkspace(request.payload.workspaceId, signal)
      const source = request.payload.configuration
      const requestedConfiguration: AgentConfiguration = {
        preset: source.preset,
        toolMode: source.toolMode,
        permissionPreset: source.permissionPreset,
        planMode: source.planMode,
        ...(source.sandboxMode === undefined ? {} : { sandboxMode: source.sandboxMode }),
        ...(source.approvalPolicy === undefined ? {} : { approvalPolicy: source.approvalPolicy }),
        model:
          source.model.reasoningLevel === undefined
            ? { providerId: source.model.providerId, modelId: source.model.modelId }
            : {
                providerId: source.model.providerId,
                modelId: source.model.modelId,
                reasoningLevel: source.model.reasoningLevel,
              },
      }
      const resolvedConfiguration = await resolveSessionConfiguration(requestedConfiguration, signal)
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
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
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
      return result
    }
    if (request.type === 'session.cancel') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
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
      const source = request.payload.configuration
      const requestedConfiguration: AgentConfiguration = {
        preset: source.preset,
        toolMode: source.toolMode,
        permissionPreset: source.permissionPreset,
        planMode: source.planMode,
        ...(source.sandboxMode === undefined ? {} : { sandboxMode: source.sandboxMode }),
        ...(source.approvalPolicy === undefined ? {} : { approvalPolicy: source.approvalPolicy }),
        model:
          source.model.reasoningLevel === undefined
            ? { providerId: source.model.providerId, modelId: source.model.modelId }
            : {
                providerId: source.model.providerId,
                modelId: source.model.modelId,
                reasoningLevel: source.model.reasoningLevel,
              },
      }
      const resolvedConfiguration = await resolveSessionConfiguration(requestedConfiguration, signal)
      return backendService
        .requireBackend()
        .sessions.setConfiguration(request.payload.sessionId, resolvedConfiguration, signal)
    }
    if (request.type === 'attachment.pick') {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Attach file',
      })
      const uri = selected?.[0]
      if (uri === undefined) return { cancelled: true }
      const info = await stat(uri.fsPath)
      if (!info.isFile() || info.size > MAX_IMAGE_ATTACHMENT_BYTES)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large or is not a regular file.',
          retryable: false,
        })
      const bytes = await readFile(uri.fsPath)
      if (bytes.length > MAX_IMAGE_ATTACHMENT_BYTES)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large.',
          retryable: false,
        })
      const mimeType = attachmentMimeType(uri.fsPath, bytes)
      if (mimeType === undefined)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file contents do not match its declared text type.',
          retryable: false,
        })
      const maximumBytes = isImageMimeType(mimeType) ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES
      if (bytes.length > maximumBytes)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large.',
          retryable: false,
        })
      if (isImageMimeType(mimeType) && !validImageBytes(mimeType, bytes))
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file contents do not match its declared image type.',
          retryable: false,
        })
      return {
        cancelled: false,
        attachment: rememberSupportedAttachment({
          name: path.basename(uri.fsPath),
          mimeType,
          dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
        }),
      }
    }
    if (request.type === 'attachment.ingest') {
      const { name, mimeType, dataBase64 } = request.payload
      const bytes = decodeCanonicalBase64(dataBase64, MAX_IMAGE_ATTACHMENT_BYTES)
      return {
        cancelled: false,
        attachment: rememberSupportedAttachment(prepareAttachment(name, bytes, mimeType)),
      }
    }
    if (request.type === 'attachment.preview') {
      const dataUri = attachmentTokens.preview(request.payload.uri)
      return dataUri === undefined ? { cancelled: true } : { cancelled: false, dataUri }
    }
    if (request.type === 'attachment.release') {
      attachmentTokens.releaseUris(request.payload.uris)
      return undefined
    }
    if (request.type === 'attachment.open.list') {
      const candidates = listOpenFileCandidates()
      return {
        items: candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          ...(candidate.mimeType === undefined ? {} : { mimeType: candidate.mimeType }),
          active: candidate.active,
          supported: isAttachmentSupported(candidate.mimeType, supportsBinaryAttachments()),
        })),
      }
    }
    if (request.type === 'attachment.open.attach') {
      const candidate = listOpenFileCandidates().find((item) => item.id === request.payload.candidateId)
      if (candidate === undefined || !isAttachmentSupported(candidate.mimeType, supportsBinaryAttachments()))
        return { cancelled: true }
      const attachment = await readOpenFileAttachment(candidate)
      if (attachment === undefined) return { cancelled: true }
      if (
        candidate.uri.scheme === 'file' &&
        attachment.mimeType !== undefined &&
        attachment.mimeType !== 'application/octet-stream' &&
        !isImageMimeType(attachment.mimeType)
      ) {
        const context = await editorContextProvider
          .captureOpenFile(candidate.uri, signal)
          .catch((error: unknown) => {
            if (error instanceof AppError && error.code === 'CONTEXT_LIMIT') return undefined
            throw error
          })
        if (context !== undefined) return { kind: 'editor.context', items: [featureContextItem(context)] }
      }
      return {
        cancelled: false,
        attachment: rememberSupportedAttachment(attachment),
      }
    }
    if (request.type === 'attachment.read') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const attachment = await sessionUseCases.readAttachment(
        request.payload.sessionId,
        request.payload.attachmentId,
        signal,
      )
      return {
        cancelled: false,
        attachment: {
          name: attachment.name,
          ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
        },
        // The adapter has already validated this as a bounded image data URI.
        // It is display data, not an endpoint or credential, so historical
        // images do not need a second opaque-handle round trip.
        dataUri: attachment.uri,
      }
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
      return interactionUseCases.respondToPermission(
        request.payload.interactionId,
        request.payload.optionId,
        signal,
      )
    }
    if (request.type === 'interaction.question.respond') {
      await requireOwnedQuestion(request.payload.questionId, signal)
      return interactionUseCases.respondToQuestion(
        request.payload.questionId,
        questionResponse(request.payload.response),
        signal,
      )
    }
    if (request.type === 'interaction.question.cancel') {
      await requireOwnedQuestion(request.payload.questionId, signal)
      return interactionUseCases.cancelQuestion(request.payload.questionId, signal)
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
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const page = await advancedUseCases.listSubagentHistory(
        request.payload.sessionId,
        {
          ...(request.payload.beforeSeq === undefined ? {} : { beforeSequence: request.payload.beforeSeq }),
          ...(request.payload.maxMessages === undefined ? {} : { pageSize: request.payload.maxMessages }),
        },
        signal,
      )
      return publicValue({
        events: page.events,
        hasMore: page.hasMore,
        ...(page.beforeSequence === undefined ? {} : { beforeSeq: page.beforeSequence }),
        ...(page.projection === undefined ? {} : { projection: page.projection }),
      })
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
    postMessage: post,
    handleRequest,
    handleFeatureRequest,
    // Unexpected (non-AppError) handler failures must stay diagnosable: the
    // Webview only sees a generic INTERNAL_ERROR, so keep the redacted cause
    // in the output channel the error message points users at.
    logUnexpectedError: (entry) => diagnostics.log('error', 'request-unexpected', { ...entry }),
  })
  const provider = new DshWebviewViewProvider({
    extensionUri: context.extensionUri,
    onMessage: (message) => router.handle(message),
    onViewDisposed: () => {
      router.cancelAll()
      stopAllJobFollows()
      editorContextProvider.dispose()
    },
    onMessageError: (error) => {
      diagnostics.log('error', 'webview-message-unhandled', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    },
  })
  return { router, provider }
}
