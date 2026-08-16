import * as vscode from 'vscode'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import {
  AppError,
  type AgentConfiguration,
  type BackendState,
  type DshBackend,
  type PromptAttachment,
  type SessionDetail,
  type WorkspaceSummary,
} from '@dsh-vscode/domain'
import {
  AdvancedAgentUseCases,
  BackendService,
  DshConnectionCoordinator,
  ExportUseCases,
  InteractionUseCases,
  ModelSettingsUseCases,
  RuntimeUseCases,
  SessionUseCases,
  SettingsUseCases,
  WorkspaceUseCases,
  type ConnectionRequest,
} from '@dsh-vscode/application'
import { Rc6VersionAdapter, VersionedBackendFactory, VersionedBackendProbe } from '@dsh-vscode/dsh-adapter'
import {
  hostEnvelopeSchema,
  hostMessageSchema,
  type HostMessage,
  type WebviewRequest,
} from '@dsh-vscode/webview-protocol'

import { registerCommands } from './commands/register-commands.js'
import { RedactedDiagnostics } from './backend/diagnostics.js'
import { CompanionRegistryDiscoveryProvider } from './backend/discovery/companion-provider.js'
import { ConfiguredPortDiscoveryProvider } from './backend/discovery/configured-provider.js'
import { DefaultPortDiscoveryProvider } from './backend/discovery/default-port-provider.js'
import { CompositeInstanceDiscovery } from './backend/discovery/instance-discovery.js'
import { KnownInstanceDiscoveryProvider } from './backend/discovery/known-instance-provider.js'
import { LinuxProcessDiscoveryProvider } from './backend/discovery/linux-process-provider.js'
import { MacOsProcessDiscoveryProvider } from './backend/discovery/macos-process-provider.js'
import { WindowsProcessDiscoveryProvider } from './backend/discovery/windows-process-provider.js'
import { DshProcessSupervisor, type SpawnedChild } from './backend/process-supervisor.js'
import { DshRuntimeLocator } from './backend/runtime-locator.js'
import { resolveNpmExecutable, runtimePathEntries } from './backend/runtime-paths.js'
import { resolveWindowsShim } from './backend/windows-shim.js'
import { VsCodeConfigurationSource } from './config/configuration-source.js'
import { DSH_DOCUMENTATION_URL, DSH_PACKAGE, OUTPUT_CHANNEL_NAME } from './constants.js'
import { WebviewMessageRouter } from './view/message-router.js'
import { DshWebviewViewProvider } from './view/dsh-webview-view-provider.js'
import { RuntimeInstaller } from './vscode/install-runtime.js'
import { requestProviderSecret } from './vscode/credential-input.js'
import { moveOrExplainSecondarySidebar } from './vscode/secondary-sidebar.js'
import { updateContextKeys } from './vscode/context-keys.js'

const execFileAsync = promisify(execFile)
const TEMPORARY_WORKSPACE_STATE_KEY = 'dsh.temporaryWorkspace'
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

interface StoredTemporaryWorkspace {
  readonly id: string
  readonly path: string
}

interface OpenLinkResult {
  readonly opened: boolean
  readonly message?: string
}

export interface CompositionRoot extends vscode.Disposable {
  start(): Promise<void>
}

export function createCompositionRoot(context: vscode.ExtensionContext): CompositionRoot {
  const configuration = new VsCodeConfigurationSource(vscode.workspace)
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
  const diagnostics = new RedactedDiagnostics(channel)
  const currentWorkspaceFolders = (): readonly vscode.WorkspaceFolder[] => {
    const folders = vscode.workspace.workspaceFolders
    if (folders !== undefined && folders.length > 0) return folders
    const activeEditor = vscode.window.activeTextEditor
    const activeFolder =
      activeEditor === undefined ? undefined : vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
    return activeFolder === undefined ? [] : [activeFolder]
  }
  const currentWorkspaceFolder = (): vscode.WorkspaceFolder | undefined => {
    const activeEditor = vscode.window.activeTextEditor
    const activeFolder =
      activeEditor === undefined ? undefined : vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
    return activeFolder ?? currentWorkspaceFolders()[0]
  }
  const openMarkdownLink = async (href: string): Promise<OpenLinkResult> => {
    const target = href.trim()
    if (target === '' || target.startsWith('#'))
      return { opened: false, message: 'This Markdown link does not contain a file target.' }

    let parsed: URL | undefined
    try {
      parsed = new URL(target)
    } catch {
      parsed = undefined
    }
    if (parsed?.protocol === 'http:' || parsed?.protocol === 'https:') {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(target))
      return opened ? { opened: true } : { opened: false, message: 'Unable to open the external link.' }
    }

    const fileUri = target.toLowerCase().startsWith('file:') ? vscode.Uri.parse(target) : undefined
    if (parsed?.protocol !== undefined && fileUri === undefined && !isAbsoluteFilePath(target))
      return { opened: false, message: 'Only workspace files and http(s) links can be opened.' }

    const roots = [
      ...currentWorkspaceFolders().map((folder) => folder.uri.fsPath),
      ...(temporaryWorkspace?.path === undefined ? [] : [temporaryWorkspace.path]),
      ...(temporaryWorkspaceReference?.path === undefined ? [] : [temporaryWorkspaceReference.path]),
    ]
    const basePath = currentWorkspaceFolder()?.uri.fsPath ?? roots[0]
    if (basePath === undefined)
      return { opened: false, message: 'Open a workspace before opening a relative file link.' }

    let filePath: string
    try {
      if (fileUri !== undefined) filePath = fileUri.fsPath
      else {
        const separator = target.search(/[?#]/)
        const pathPart = separator === -1 ? target : target.slice(0, separator)
        const decoded = decodeURIComponent(pathPart).replace(/^[/\\]+/, '')
        if (decoded === '') return { opened: false, message: 'The file link is empty.' }
        filePath = isAbsoluteFilePath(decoded) ? path.resolve(decoded) : path.resolve(basePath, decoded)
      }
    } catch {
      return { opened: false, message: 'The file link is not valid.' }
    }

    if (!roots.some((root) => isPathWithin(root, filePath)))
      return { opened: false, message: 'Only files inside the current workspace can be opened.' }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
      await vscode.window.showTextDocument(document, { preview: true })
      return { opened: true }
    } catch {
      return { opened: false, message: 'The linked workspace file could not be opened.' }
    }
  }
  const runtimeLocator = new DshRuntimeLocator({
    os: platform(),
    configuredPath: () => configuration.read().runtime.executablePath,
    pathEntries: () => runtimePathEntries(platform(), process.env),
    npmGlobalPrefix: async (signal) => {
      const os = platform()
      const npm = resolveNpmExecutable(os, runtimePathEntries(os, process.env))
      const resolved = os === 'windows' ? resolveWindowsShim(npm, os, readTextFile) : undefined
      try {
        const result = await execFileAsync(
          resolved?.executable ?? npm,
          [...(resolved?.prefixArgs ?? []), 'prefix', '-g'],
          {
            timeout: 3_000,
            maxBuffer: 8 * 1024,
            signal,
            env: runtimeEnvironment(undefined, resolved?.executable ?? npm),
          },
        )
        return result.stdout.trim() || undefined
      } catch {
        return undefined
      }
    },
    fileExists: async (candidate) =>
      access(candidate).then(
        () => true,
        () => false,
      ),
    executeVersion: async (executable, signal) => {
      const resolved = resolveWindowsShim(executable, platform(), readTextFile) ?? {
        executable,
        prefixArgs: [],
      }
      const result = await execFileAsync(resolved.executable, [...resolved.prefixArgs, '--version'], {
        timeout: 3_000,
        maxBuffer: 8 * 1024,
        signal,
        env: runtimeEnvironment(undefined, resolved.executable),
      })
      return result.stdout.trim()
    },
  })
  const discovery = new CompositeInstanceDiscovery([
    new ConfiguredPortDiscoveryProvider(
      () => configuration.read().connection.attachPorts,
      () => configuration.read().connection.serverUrl,
    ),
    new KnownInstanceDiscoveryProvider(context.workspaceState),
    new DefaultPortDiscoveryProvider(),
    new CompanionRegistryDiscoveryProvider(),
    new WindowsProcessDiscoveryProvider(),
    new LinuxProcessDiscoveryProvider(),
    new MacOsProcessDiscoveryProvider(),
  ])
  const adapter = new Rc6VersionAdapter({
    get requestTimeoutMs() {
      return configuration.read().connection.requestTimeoutMs
    },
    get retryPolicy() {
      return { maximumAttempts: 2, baseDelayMs: 100, maximumDelayMs: 500 }
    },
    fetch: globalThis.fetch,
  })
  const probe = new VersionedBackendProbe([adapter])
  const factory = new VersionedBackendFactory([adapter])
  const supervisor = new DshProcessSupervisor({
    managedPort: () => configuration.read().connection.managedPort,
    workingDirectory: () => currentWorkspaceFolder()?.uri.fsPath ?? process.cwd(),
    toolMode: () => configuration.read().defaultAgent.toolMode,
    spawn: spawnManagedChild,
  })
  const coordinator = new DshConnectionCoordinator({
    runtimeLocator,
    discovery,
    probe,
    backendFactory: factory,
    processSupervisor: supervisor,
  })
  const backendService = new BackendService()
  const runtimeInstaller = new RuntimeInstaller({
    tasks: vscode.tasks,
    window: vscode.window,
    env: vscode.env,
    Uri: vscode.Uri,
    workspace: vscode.workspace,
    runInstall: async () => {
      const os = platform()
      const npm = resolveNpmExecutable(os, runtimePathEntries(os, process.env))
      await execFileAsync(npm, ['install', '--global', DSH_PACKAGE], {
        timeout: 120_000,
        maxBuffer: 32 * 1024,
        env: runtimeEnvironment(undefined, npm),
      })
    },
    verifyInstall: async () => (await runtimeLocator.locate())?.supported === true,
    verifyExecutable: async (executable) => (await runtimeLocator.inspectExecutable(executable)).supported,
  })
  const runtimeUseCases = new RuntimeUseCases({
    install: () => runtimeInstaller.install(),
    selectExecutable: () => runtimeInstaller.selectExecutable(),
    copyInstallCommand: () => Promise.resolve(runtimeInstaller.copyInstallCommand()),
    openDocumentation: () => Promise.resolve(runtimeInstaller.openDocumentation()).then(() => undefined),
  })
  const workspaceUseCases = new WorkspaceUseCases(backendService)
  const sessionUseCases = new SessionUseCases(backendService)
  const modelUseCases = new ModelSettingsUseCases(backendService)
  const interactionUseCases = new InteractionUseCases(backendService)
  const settingsUseCases = new SettingsUseCases(backendService)
  const advancedUseCases = new AdvancedAgentUseCases(backendService)
  const exportUseCases = new ExportUseCases(backendService)
  let temporaryWorkspace: WorkspaceSummary | undefined
  let temporaryWorkspaceReference = readStoredTemporaryWorkspace(
    context.globalState.get<unknown>(TEMPORARY_WORKSPACE_STATE_KEY),
  )
  const rememberTemporaryWorkspace = async (
    workspace: WorkspaceSummary,
    fallbackPath?: string,
  ): Promise<WorkspaceSummary> => {
    const workspacePath = workspace.path ?? fallbackPath ?? temporaryWorkspaceReference?.path
    const remembered = workspacePath === undefined ? workspace : { ...workspace, path: workspacePath }
    temporaryWorkspace = remembered
    if (workspacePath !== undefined) {
      const nextReference: StoredTemporaryWorkspace = { id: remembered.id, path: workspacePath }
      if (
        temporaryWorkspaceReference === undefined ||
        temporaryWorkspaceReference.id !== nextReference.id ||
        !sameWorkspacePath(temporaryWorkspaceReference.path, nextReference.path)
      ) {
        temporaryWorkspaceReference = nextReference
        await context.globalState.update(TEMPORARY_WORKSPACE_STATE_KEY, nextReference)
      }
    }
    return remembered
  }
  const forgetTemporaryWorkspace = async (removeDirectory: boolean): Promise<void> => {
    const temporaryPath = temporaryWorkspace?.path ?? temporaryWorkspaceReference?.path
    temporaryWorkspace = undefined
    temporaryWorkspaceReference = undefined
    await context.globalState.update(TEMPORARY_WORKSPACE_STATE_KEY, undefined)
    if (removeDirectory && temporaryPath !== undefined)
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined)
  }
  const attachmentTokens = new Map<string, StoredAttachment>()
  const listCurrentWorkspaces = async (signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> => {
    const folders = currentWorkspaceFolders()
    const workspaces = await workspaceUseCases.list(signal)
    if (folders.length === 0) {
      const reference =
        temporaryWorkspaceReference ??
        (temporaryWorkspace?.path === undefined
          ? undefined
          : { id: temporaryWorkspace.id, path: temporaryWorkspace.path })
      if (reference === undefined) return []
      const refreshed = workspaces.find(
        (workspace) =>
          workspace.id === reference.id ||
          (workspace.path !== undefined && sameWorkspacePath(workspace.path, reference.path)),
      )
      if (refreshed === undefined) return []
      return [await rememberTemporaryWorkspace(refreshed, reference.path)]
    }
    const matching = workspaces.filter(
      (workspace) =>
        workspace.path !== undefined &&
        folders.some((folder) => sameWorkspacePath(workspace.path as string, folder.uri.fsPath)),
    )
    if (matching.length > 0) return matching

    // Sessions created directly by DSH may already carry this folder in their
    // durable cwd while the workspace registry has not been registered yet.
    // Registering is idempotent in rc.6 and gives the UI a stable workspace
    // anchor for those sessions instead of treating the folder as temporary.
    const registered: WorkspaceSummary[] = []
    for (const folder of folders) {
      try {
        registered.push(
          await workspaceUseCases.create(
            {
              name: path.basename(path.normalize(folder.uri.fsPath)) || 'Workspace',
              path: folder.uri.fsPath,
            },
            signal,
          ),
        )
      } catch {
        // A read-only/virtual folder can still be matched by session cwd in
        // the request filters below; registration is only a UI anchor.
      }
    }
    return registered
  }
  const listCurrentArchivedSessionIds = async (
    workspaces: readonly WorkspaceSummary[],
    signal?: AbortSignal,
  ): Promise<readonly string[]> => {
    if (workspaces.length === 0 && currentWorkspaceFolders().length === 0) return []
    const backend = backendService.requireBackend()
    // rc.6 defines this as a registry-global snapshot. Returning it directly
    // avoids a second session.list race while a workspace attach/archive is
    // being committed; the session list itself is still scoped below.
    return backend.workspaces.listArchivedSessionIds(signal)
  }
  const ensureCurrentWorkspace = async (
    requestedWorkspaceId: string | undefined,
    signal?: AbortSignal,
  ): Promise<WorkspaceSummary> => {
    const current = await listCurrentWorkspaces(signal)
    const requested = current.find((workspace) => workspace.id === requestedWorkspaceId)
    if (requested !== undefined) return requested
    const existing = current[0]
    if (existing !== undefined) return existing

    const folder = currentWorkspaceFolder()
    if (folder !== undefined) {
      return workspaceUseCases.create(
        {
          name: path.basename(path.normalize(folder.uri.fsPath)) || 'Workspace',
          path: folder.uri.fsPath,
        },
        signal,
      )
    }

    if (temporaryWorkspaceReference !== undefined) {
      await mkdir(temporaryWorkspaceReference.path, { recursive: true })
      const reused = await workspaceUseCases.create(
        { name: 'Temporary Workspace', path: temporaryWorkspaceReference.path },
        signal,
      )
      return rememberTemporaryWorkspace(reused, temporaryWorkspaceReference.path)
    }
    if (temporaryWorkspace !== undefined) return temporaryWorkspace
    await mkdir(context.globalStorageUri.fsPath, { recursive: true })
    const temporaryPath = await mkdtemp(path.join(context.globalStorageUri.fsPath, 'workspace-'))
    try {
      const created = await workspaceUseCases.create(
        { name: 'Temporary Workspace', path: temporaryPath },
        signal,
      )
      return rememberTemporaryWorkspace(created, temporaryPath)
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
  const resolveSessionConfiguration = async (
    requested: AgentConfiguration,
    signal?: AbortSignal,
  ): Promise<AgentConfiguration> => {
    const presets = await backendService.requireBackend().presets.list(signal)
    if (presets.length === 0)
      // A valid rc.6 deployment may compose no preset roster.  In that case
      // the omitted agentPreset tells DSH to use its host composition.
      return { ...requested, preset: '' }

    const usable = presets.filter((preset) => preset.broken === undefined)
    const candidates = usable.length > 0 ? usable : presets
    const selected =
      candidates.find((preset) => preset.id === requested.preset) ??
      candidates.find((preset) => preset.isDefault) ??
      candidates[0]
    return { ...requested, preset: selected?.id ?? '' }
  }
  let sequence = 0
  const post = (message: HostMessage): Thenable<boolean> => {
    const parsed = hostMessageSchema.safeParse(message)
    if (!parsed.success) {
      diagnostics.log('warn', 'host-message-rejected', { code: 'PROTOCOL_ERROR' })
      return Promise.resolve(false)
    }
    return provider.postMessage(hostEnvelopeSchema.parse({ protocolVersion: 1, message: parsed.data }))
  }
  let eventPostQueue = Promise.resolve()
  const postEvent = (name: string, payload: unknown): Promise<boolean> => {
    const task = eventPostQueue.then(async () => {
      const nextSequence = sequence + 1
      const delivered = await post({ type: 'event', name, sequence: nextSequence, payload })
      if (delivered) sequence = nextSequence
      return delivered
    })
    eventPostQueue = task.then(
      () => undefined,
      () => undefined,
    )
    return task.catch(() => false)
  }
  const publishState = (state: BackendState): void => {
    void updateContextKeys(vscode.commands, state)
    const payload = publicState(state)
    void postEvent('connection.snapshot', payload)
  }
  const attach = (backend: DshBackend): void => {
    backendService.attach(backend, (event) => {
      void postEvent(event.type, sanitize(event))
    })
  }
  const connect = async (signal?: AbortSignal): Promise<unknown> => {
    const current = configuration.read()
    const hasWorkspaceFolder = currentWorkspaceFolders().length > 0
    const request: ConnectionRequest = {
      mode: current.connection.mode,
      // A workspace that has not been trusted may attach to an existing
      // loopback host. An empty window is safe to isolate in a temporary
      // workspace, but an untrusted project folder must never auto-start DSH.
      autoStart: current.runtime.autoStart && (vscode.workspace.isTrusted || !hasWorkspaceFolder),
    }
    const result = await coordinator.connect(request, signal)
    await context.workspaceState.update('dsh.lastEndpoint', {
      endpoint: result.backend.connection.endpoint,
    })
    attach(result.backend)
    // Commands may connect before the Webview exists. app.ready must always
    // receive a fresh authoritative snapshot even when the initial publish
    // had no recipient.
    publishState(result.state)
    return { connected: true }
  }
  const reconnect = async (signal?: AbortSignal): Promise<unknown> => {
    await coordinator.disconnect()
    return connect(signal)
  }
  const requireCurrentWorkspaceSession = async (
    sessionId: string,
    signal: AbortSignal,
  ): Promise<SessionDetail> => {
    let workspaces: readonly WorkspaceSummary[]
    try {
      workspaces = await listCurrentWorkspaces(signal)
    } catch (error) {
      throw sessionOpenFailure('workspace discovery', error)
    }

    let archivedSessionIds: readonly string[]
    try {
      archivedSessionIds = await backendService.requireBackend().workspaces.listArchivedSessionIds(signal)
    } catch (error) {
      throw sessionOpenFailure('archive state lookup', error)
    }
    if (archivedSessionIds.includes(sessionId))
      throw sessionOpenFailure(
        'archive state lookup',
        new AppError({
          code: 'PERMISSION_DENIED',
          message: 'The requested session is archived.',
          retryable: false,
        }),
      )

    let detail: SessionDetail
    try {
      detail = await backendService.requireBackend().sessions.get(sessionId, signal)
    } catch (error) {
      throw sessionOpenFailure('session summary and history read', error)
    }
    if (!sessionBelongsToWorkspaces(detail, workspaces, currentWorkspaceFolders()))
      throw sessionOpenFailure(
        'current workspace ownership check',
        new AppError({
          code: 'PERMISSION_DENIED',
          message: 'The requested session is not part of the current VS Code workspace.',
          retryable: false,
        }),
      )
    return detail
  }
  const handleRequest = async (request: WebviewRequest, signal: AbortSignal): Promise<unknown> => {
    if (request.type === 'app.ready') return connect(signal)
    if (request.type === 'connection.retry') return reconnect(signal)
    if (request.type === 'view.openLink') return openMarkdownLink(request.payload.href)
    if (request.type === 'runtime.action') {
      await runtimeUseCases.execute(request.payload.action)
      if (request.payload.action === 'install' || request.payload.action === 'select') return connect(signal)
      return undefined
    }
    if (request.type === 'view.moveRightGuide')
      return moveOrExplainSecondarySidebar(vscode.commands, vscode.window)
    if (request.type === 'diagnostics.show') {
      diagnostics.show()
      return { shown: true }
    }
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
      return publicValue({ items: workspaces, archivedSessionIds })
    }
    if (request.type === 'workspace.create') {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Use workspace folder',
      })
      const uri = selected?.[0]
      if (uri === undefined) return { cancelled: true }
      return publicValue(
        await workspaceUseCases.create({ name: request.payload.name, path: uri.fsPath }, signal),
      )
    }
    if (request.type === 'workspace.rename')
      return workspaceUseCases.rename(request.payload.workspaceId, request.payload.name, signal)
    if (request.type === 'workspace.remove') {
      const removesTemporaryWorkspace =
        request.payload.workspaceId === temporaryWorkspace?.id ||
        request.payload.workspaceId === temporaryWorkspaceReference?.id
      const result = await workspaceUseCases.remove(request.payload.workspaceId, signal)
      if (removesTemporaryWorkspace) await forgetTemporaryWorkspace(true)
      return result
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
        items: page.items.filter((session) => {
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
        }),
      })
    }
    if (request.type === 'session.open') {
      return publicValue(await requireCurrentWorkspaceSession(request.payload.sessionId, signal))
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
        await sessionUseCases.create(
          {
            workspaceId: workspace.id,
            ...(request.payload.title === undefined ? {} : { title: request.payload.title }),
            configuration: resolvedConfiguration,
          },
          signal,
        ),
      )
    }
    if (request.type === 'session.rename')
      return backendService
        .requireBackend()
        .sessions.rename(request.payload.sessionId, request.payload.title, signal)
    if (request.type === 'session.remove') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return sessionUseCases.remove(request.payload.sessionId, signal)
    }
    if (request.type === 'session.fork')
      return publicValue(await sessionUseCases.fork(request.payload.sessionId, request.payload.atSeq, signal))
    if (request.type === 'session.archive') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return sessionUseCases.setArchived(request.payload.sessionId, request.payload.archived, signal)
    }
    if (request.type === 'session.sendPrompt') {
      const attachments = resolveAttachments(request.payload.attachments, attachmentTokens)
      await sessionUseCases.sendPrompt(
        { sessionId: request.payload.sessionId, text: request.payload.text, attachments },
        signal,
      )
      releaseAttachments(request.payload.attachments, attachmentTokens)
      return undefined
    }
    if (request.type === 'session.enqueuePrompt') {
      const attachments = resolveAttachments(request.payload.attachments, attachmentTokens)
      const queued = await sessionUseCases.enqueuePrompt(
        { sessionId: request.payload.sessionId, text: request.payload.text, attachments },
        request.payload.mode,
        signal,
      )
      releaseAttachments(request.payload.attachments, attachmentTokens)
      return publicValue(queued)
    }
    if (request.type === 'session.cancel') return sessionUseCases.cancel(request.payload.sessionId, signal)
    if (request.type === 'session.queue.list')
      return publicList(
        await backendService.requireBackend().sessions.listQueue(request.payload.sessionId, signal),
      )
    if (request.type === 'session.queue.update')
      return backendService
        .requireBackend()
        .sessions.updateQueuedInput(request.payload.inputId, request.payload.text, signal)
    if (request.type === 'session.queue.remove')
      return backendService.requireBackend().sessions.removeQueuedInput(request.payload.inputId, signal)
    if (request.type === 'session.queue.steer')
      return backendService
        .requireBackend()
        .sessions.convertQueuedInputToSteer(request.payload.inputId, signal)
    if (request.type === 'session.configure') {
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
      if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large or is not a regular file.',
          retryable: false,
        })
      const bytes = await readFile(uri.fsPath)
      if (bytes.length > MAX_ATTACHMENT_BYTES)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The selected file is too large.',
          retryable: false,
        })
      const mimeType = attachmentMimeType(uri.fsPath, bytes)
      if (mimeType === undefined)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message:
            'This DSH integration supports images and text-based files; this binary file is not supported.',
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
        attachment: rememberAttachment(attachmentTokens, {
          name: path.basename(uri.fsPath),
          mimeType,
          dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
        }),
      }
    }
    if (request.type === 'attachment.open.list') {
      const candidates = listOpenFileCandidates()
      return {
        items: candidates.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          ...(candidate.mimeType === undefined ? {} : { mimeType: candidate.mimeType }),
          active: candidate.active,
          supported: candidate.mimeType !== undefined,
        })),
      }
    }
    if (request.type === 'attachment.open.attach') {
      const candidate = listOpenFileCandidates().find((item) => item.id === request.payload.candidateId)
      if (candidate === undefined || candidate.mimeType === undefined) return { cancelled: true }
      const attachment = await readOpenFileAttachment(candidate)
      if (attachment === undefined) return { cancelled: true }
      return {
        cancelled: false,
        attachment: rememberAttachment(attachmentTokens, attachment),
      }
    }
    if (request.type === 'attachment.read') {
      const attachment = await sessionUseCases.readAttachment(
        request.payload.sessionId,
        request.payload.attachmentId,
        signal,
      )
      return {
        attachment: rememberAttachment(attachmentTokens, {
          name: attachment.name,
          ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
          dataUri: attachment.uri,
        }),
      }
    }
    if (request.type === 'models.list')
      return publicList(await modelUseCases.listModels(request.payload.providerId, signal))
    if (request.type === 'models.session.list')
      return publicValue(await modelUseCases.listSessionModels(request.payload.sessionId, signal))
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
    if (request.type === 'interaction.permission.respond')
      return interactionUseCases.respondToPermission(
        request.payload.interactionId,
        request.payload.optionId,
        signal,
      )
    if (request.type === 'interaction.question.respond')
      return interactionUseCases.respondToQuestion(
        request.payload.questionId,
        request.payload.response,
        signal,
      )
    if (request.type === 'settings.read') return publicValue(await settingsUseCases.read(signal))
    if (request.type === 'settings.update')
      return settingsUseCases.update(request.payload.path, request.payload.value, signal)
    if (request.type === 'settings.replace')
      return backendService.requireBackend().settings.replace(request.payload.values, signal)
    if (request.type === 'goal.list')
      return publicList(await advancedUseCases.listGoals(request.payload.sessionId, signal))
    if (request.type === 'goal.create')
      return publicValue(
        await backendService
          .requireBackend()
          .goals.create(request.payload.sessionId, request.payload.title, signal),
      )
    if (request.type === 'goal.update')
      return backendService.requireBackend().goals.update(
        request.payload.goalId,
        {
          ...(request.payload.title === undefined ? {} : { title: request.payload.title }),
          ...(request.payload.status === undefined ? {} : { status: request.payload.status }),
        },
        signal,
      )
    if (request.type === 'goal.clear') return advancedUseCases.clearGoal(request.payload.goalId, signal)
    if (request.type === 'job.list')
      return publicList(await advancedUseCases.listJobs(request.payload.sessionId, signal))
    if (request.type === 'job.cancel') return advancedUseCases.execute('job.cancel', request.payload, signal)
    if (request.type === 'subagent.list')
      return publicList(await advancedUseCases.listSubagents(request.payload.sessionId, signal))
    if (request.type === 'subagent.history')
      return publicValue(await advancedUseCases.listSubagentHistory(request.payload.sessionId, signal))
    if (request.type === 'subagent.send')
      return advancedUseCases.execute('subagent.send', request.payload, signal)
    if (request.type === 'subagent.interrupt')
      return advancedUseCases.execute('subagent.interrupt', request.payload, signal)
    if (request.type === 'workflow.list')
      return publicList(await advancedUseCases.listWorkflows(request.payload.sessionId, signal))
    if (request.type === 'workflow.start')
      return advancedUseCases.execute('workflow.start', request.payload, signal)
    if (request.type === 'workflow.cancel')
      return advancedUseCases.execute('workflow.cancel', request.payload, signal)
    if (request.type === 'skill.list')
      return publicList(await advancedUseCases.listSkills(request.payload.sessionId, signal))
    if (request.type === 'skill.refresh')
      return publicList(await advancedUseCases.listSkills(request.payload.sessionId, signal))
    if (request.type === 'skill.execute')
      return advancedUseCases.execute('skill.execute', request.payload, signal)
    if (request.type === 'command.list')
      return publicList(await advancedUseCases.listCommands(request.payload.sessionId, signal))
    if (request.type === 'command.execute') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return advancedUseCases.execute('command.execute', request.payload, signal)
    }
    if (request.type === 'plugin.list') return publicList(await advancedUseCases.listPlugins(signal))
    if (request.type === 'plugin.configure')
      return advancedUseCases.execute('plugin.configure', request.payload, signal)
    if (request.type === 'preset.list') return publicList(await advancedUseCases.listPresets(signal))
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
    if (request.type === 'preset.select')
      return advancedUseCases.selectPreset(request.payload.sessionId, request.payload.presetId, signal)
    if (request.type === 'session.export') {
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
    return { accepted: true }
  }
  const router = new WebviewMessageRouter({ postMessage: post, handleRequest })
  const provider = new DshWebviewViewProvider({
    extensionUri: context.extensionUri,
    onMessage: (message) => router.handle(message),
  })
  const stateSubscription = coordinator.subscribe(publishState)
  const subscriptions: vscode.Disposable[] = [
    stateSubscriptionDisposable(stateSubscription),
    provider,
    diagnostics,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void postEvent('workspace.changed', {})
    }),
  ]
  const root: CompositionRoot = {
    start: () => {
      subscriptions.push(
        vscode.window.registerWebviewViewProvider(DshWebviewViewProvider.viewType, provider, {
          // Keep the React tree and scroll position alive while the user
          // changes VS Code views. The Webview store also persists the last
          // session for a full Webview recreation.
          webviewOptions: { retainContextWhenHidden: true },
        }),
      )
      registerCommands({
        commands: vscode.commands,
        subscriptions: context.subscriptions,
        handlers: {
          'dsh.connect': () => reconnect(),
          'dsh.reconnect': () => reconnect(),
          'dsh.newSession': () => postEvent('ui.sessions.toggle', {}),
          'dsh.openSettings': () =>
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:Direwolf.deepseek-harness-vscode',
            ),
          'dsh.installRuntime': () => runtimeInstaller.install(),
          'dsh.selectExecutable': () => runtimeInstaller.selectExecutable(),
          'dsh.copyInstallCommand': () => runtimeInstaller.copyInstallCommand(),
          'dsh.openDocumentation': () => vscode.env.openExternal(vscode.Uri.parse(DSH_DOCUMENTATION_URL)),
          'dsh.openInSecondarySidebar': () => moveOrExplainSecondarySidebar(vscode.commands, vscode.window),
          'dsh.showDiagnostics': () => diagnostics.show(),
        },
      })
      context.subscriptions.push(...subscriptions)
      context.subscriptions.push(
        configuration.onDidChange(() => {
          // Adapter timeout, endpoint and managed-process settings are
          // captured by long-lived objects. Treat those changes as a
          // reconnect boundary so the new configuration cannot appear in the
          // UI while requests still use stale transport state.
          void coordinator.disconnect().then(
            () => publishState(coordinator.getState()),
            () =>
              publishState({ kind: 'failed', message: 'DSH configuration reload failed.', retryable: true }),
          )
        }),
      )
      return Promise.resolve()
    },
    dispose: async () => {
      router.cancelAll()
      stateSubscription()
      provider.dispose()
      await backendService.detach()
      await coordinator.disconnect()
      attachmentTokens.clear()
      channel.dispose()
    },
  }
  return root
}

function platform(): 'windows' | 'linux' | 'macos' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
}

function runtimeEnvironment(overrides?: NodeJS.ProcessEnv, executable?: string): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...(overrides ?? {}) }
  const entries = runtimePathEntries(platform(), environment)
  const executableDirectory = executable === undefined ? undefined : path.dirname(executable)
  const prefix =
    executableDirectory === undefined || executableDirectory === '.' ? undefined : executableDirectory
  environment.PATH = [prefix, ...entries]
    .filter((entry): entry is string => entry !== undefined)
    .join(path.delimiter)
  return environment
}

function readStoredTemporaryWorkspace(value: unknown): StoredTemporaryWorkspace | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = record.id
  const workspacePath = record.path
  if (
    typeof id !== 'string' ||
    id.trim() === '' ||
    typeof workspacePath !== 'string' ||
    workspacePath.trim() === '' ||
    !isAbsoluteWorkspacePath(workspacePath)
  )
    return undefined
  return { id, path: workspacePath }
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function isAbsoluteFilePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(path.resolve(value))
    let canonical = resolved
    try {
      canonical = realpathSync.native(resolved)
    } catch {
      // The linked file may not exist yet; compare its normalized path while
      // preserving the workspace boundary check.
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  }
  const relative = path.relative(normalize(root), normalize(candidate))
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(path.resolve(value))
    let canonical = resolved
    try {
      canonical = realpathSync.native(resolved)
    } catch {
      // A workspace can be published before a remote/virtual path is
      // readable locally. The normalized spelling remains the safe fallback.
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  }
  return normalize(left) === normalize(right)
}

function sessionOpenFailure(stage: string, error: unknown): AppError {
  const source = error instanceof AppError ? error : undefined
  return new AppError({
    code: source?.code ?? 'INTERNAL_ERROR',
    message: `Opening the DSH session failed during ${stage}.`,
    retryable: source?.retryable ?? true,
    cause: error,
    context: {
      operation: 'session.open',
      stage,
      ...(source?.context?.rpcMethod === undefined ? {} : { rpcMethod: source.context.rpcMethod }),
      ...(source?.context?.rpcCode === undefined ? {} : { rpcCode: source.context.rpcCode }),
    },
  })
}

function sessionBelongsToWorkspaces(
  session: { readonly id: string; readonly workspaceId: string; readonly cwd?: string },
  workspaces: readonly WorkspaceSummary[],
  folders: readonly vscode.WorkspaceFolder[] = [],
): boolean {
  return (
    workspaces.some(
      (workspace) =>
        session.workspaceId === workspace.id ||
        workspace.sessionIds?.includes(session.id) === true ||
        (workspace.path !== undefined &&
          session.cwd !== undefined &&
          sameWorkspacePath(workspace.path, session.cwd)),
    ) ||
    (session.cwd !== undefined &&
      folders.some((folder) => sameWorkspacePath(session.cwd as string, folder.uri.fsPath)))
  )
}

function readTextFile(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

function spawnManagedChild(
  executable: string,
  args: readonly string[],
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): SpawnedChild {
  const resolved = resolveWindowsShim(executable, platform(), readTextFile)
  const childEnvironment = { ...process.env, ...(environment ?? {}) }
  const resolvedExecutable = resolved?.executable ?? executable
  const executableDirectory = path.dirname(resolvedExecutable)
  const prefix = executableDirectory === '.' ? undefined : executableDirectory
  childEnvironment.PATH = [prefix, ...runtimePathEntries(platform(), childEnvironment)]
    .filter((entry): entry is string => entry !== undefined)
    .join(path.delimiter)
  const child = spawn(
    resolved?.executable ?? executable,
    resolved ? [...resolved.prefixArgs, ...args] : [...args],
    {
      shell: false,
      windowsHide: true,
      ...(cwd === undefined ? {} : { cwd }),
      env: childEnvironment,
    },
  )
  return {
    pid: child.pid ?? -1,
    stdout: textStream(child.stdout),
    stderr: textStream(child.stderr),
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal)
    },
    exited: new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
  }
}

async function* textStream(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) return
  for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
}

function stateSubscriptionDisposable(unsubscribe: () => void): vscode.Disposable {
  return { dispose: unsubscribe }
}

function publicState(state: BackendState): unknown {
  return {
    kind: state.kind,
    ...(state.kind === 'failed'
      ? { message: safeStateMessage(state.message), retryable: state.retryable }
      : {}),
    ...(state.kind === 'port-conflict'
      ? { message: 'The configured DSH port is unavailable.', retryable: state.retryable, port: state.port }
      : {}),
    ...(state.kind === 'runtime-missing'
      ? { searchedLocations: state.searchedLocations.map((location) => path.basename(location)) }
      : {}),
  }
}

interface OpenFileCandidate {
  readonly id: string
  readonly uri: vscode.Uri
  readonly name: string
  readonly mimeType?: string
  readonly active: boolean
}

function listOpenFileCandidates(): readonly OpenFileCandidate[] {
  const activeEditor = vscode.window.activeTextEditor
  const activeTabUri = currentTabUri(vscode.window.tabGroups.activeTabGroup.activeTab?.input)
  const activeUri = activeEditor?.document.uri.toString() ?? activeTabUri?.toString()
  const seen = new Set<string>()
  const candidates: OpenFileCandidate[] = []
  const add = (uri: vscode.Uri): void => {
    if (!isOpenFileUri(uri)) return
    const uriKey = uri.toString()
    if (seen.has(uriKey)) return
    seen.add(uriKey)
    const document = openDocumentForUri(uri)
    const name = fileNameForUri(uri, document)
    const mimeType = attachmentMimeType(name, Buffer.alloc(0))
    candidates.push({
      id: openFileCandidateId(uri),
      uri,
      name,
      ...(mimeType === undefined ? {} : { mimeType }),
      active: uriKey === activeUri,
    })
  }

  for (const group of vscode.window.tabGroups.all)
    for (const tab of group.tabs) {
      for (const uri of tabInputUris(tab.input)) add(uri)
    }
  if (activeEditor !== undefined) add(activeEditor.document.uri)

  return candidates.sort((left, right) => Number(right.active) - Number(left.active))
}

async function readOpenFileAttachment(
  candidate: OpenFileCandidate,
): Promise<Omit<StoredAttachment, 'expiresAt'> | undefined> {
  const openDocument = openDocumentForUri(candidate.uri)
  if (openDocument !== undefined)
    return prepareAttachment(candidate.name, Buffer.from(openDocument.getText(), 'utf8'))
  if (candidate.uri.scheme !== 'file') return undefined
  const info = await stat(candidate.uri.fsPath).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  return prepareAttachment(candidate.name, await readFile(candidate.uri.fsPath))
}

function openDocumentForUri(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
}

function isOpenFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'untitled'
}

function fileNameForUri(uri: vscode.Uri, document: vscode.TextDocument | undefined): string {
  const source = document?.fileName || (uri.scheme === 'file' ? uri.fsPath : uri.path)
  const name = path.basename(source)
  return name === '' || name === '.' || name === path.sep
    ? `Untitled-${document?.languageId || 'file'}`
    : name
}

function openFileCandidateId(uri: vscode.Uri): string {
  return `dsh-open-file-${createHash('sha256').update(uri.toString(), 'utf8').digest('hex').slice(0, 32)}`
}

function currentTabUri(input: vscode.Tab['input']): vscode.Uri | undefined {
  return tabInputUris(input)[0]
}

function tabInputUris(input: vscode.Tab['input']): readonly vscode.Uri[] {
  if (input instanceof vscode.TabInputText) return [input.uri]
  if (input instanceof vscode.TabInputTextDiff) return [input.modified, input.original]
  if (input instanceof vscode.TabInputCustom) return [input.uri]
  if (input instanceof vscode.TabInputNotebook) return [input.uri]
  if (input instanceof vscode.TabInputNotebookDiff) return [input.modified, input.original]
  return []
}

function prepareAttachment(name: string, bytes: Buffer): Omit<StoredAttachment, 'expiresAt'> {
  if (bytes.length > MAX_ATTACHMENT_BYTES)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The current file is too large to attach.',
      retryable: false,
    })
  const mimeType = attachmentMimeType(name, bytes)
  if (mimeType === undefined)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The current file is not supported; attach an image or a text-based file instead.',
      retryable: false,
    })
  if (isImageMimeType(mimeType) && !validImageBytes(mimeType, bytes))
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The current file contents do not match its declared image type.',
      retryable: false,
    })
  return {
    name,
    mimeType,
    dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
  }
}

function safeStateMessage(message: string): string {
  void message
  return 'The DSH connection operation failed.'
}

function publicList(value: readonly unknown[]): readonly unknown[] {
  return value.map(publicValue)
}
function publicValue(value: unknown): unknown {
  return sanitize(value)
}

interface StoredAttachment {
  readonly dataUri: string
  readonly name: string
  readonly mimeType?: string
  readonly expiresAt: number
}

interface AttachmentHandle {
  readonly uri: string
  readonly name: string
  readonly mimeType?: string | undefined
}

function rememberAttachment(
  store: Map<string, StoredAttachment>,
  input: Omit<StoredAttachment, 'expiresAt'>,
): AttachmentHandle {
  pruneAttachments(store)
  while (store.size >= 8) {
    const oldest = store.keys().next().value
    if (typeof oldest !== 'string') break
    store.delete(oldest)
  }
  const token = `dsh-attachment:${randomUUID()}`
  store.set(token, { ...input, expiresAt: Date.now() + 10 * 60 * 1000 })
  return {
    uri: token,
    name: input.name,
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
  }
}

function resolveAttachments(
  attachments: readonly AttachmentHandle[],
  store: Map<string, StoredAttachment>,
): readonly PromptAttachment[] {
  pruneAttachments(store)
  return attachments.map((attachment) => {
    const stored = store.get(attachment.uri)
    if (stored === undefined)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment is no longer available. Select it again.',
        retryable: false,
      })
    return {
      uri: stored.dataUri,
      name: stored.name,
      ...(stored.mimeType === undefined ? {} : { mimeType: stored.mimeType }),
    }
  })
}

function releaseAttachments(
  attachments: readonly AttachmentHandle[],
  store: Map<string, StoredAttachment>,
): void {
  for (const attachment of attachments) store.delete(attachment.uri)
}

function pruneAttachments(store: Map<string, StoredAttachment>): void {
  const now = Date.now()
  for (const [token, attachment] of store) if (attachment.expiresAt <= now) store.delete(token)
}

function requiresTrustedWorkspace(type: WebviewRequest['type']): boolean {
  switch (type) {
    case 'workspace.create':
    case 'workspace.rename':
    case 'workspace.remove':
    case 'session.create':
    case 'session.rename':
    case 'session.remove':
    case 'session.fork':
    case 'session.archive':
    case 'session.sendPrompt':
    case 'session.enqueuePrompt':
    case 'session.queue.update':
    case 'session.queue.remove':
    case 'session.queue.steer':
    case 'session.cancel':
    case 'session.configure':
    case 'attachment.pick':
    case 'attachment.open.list':
    case 'attachment.open.attach':
    case 'attachment.read':
    case 'provider.secret.configure':
    case 'provider.secret.remove':
    case 'settings.update':
    case 'settings.replace':
    case 'goal.create':
    case 'goal.update':
    case 'job.cancel':
    case 'subagent.send':
    case 'subagent.interrupt':
    case 'workflow.start':
    case 'workflow.cancel':
    case 'skill.refresh':
    case 'skill.execute':
    case 'command.execute':
    case 'plugin.configure':
    case 'preset.select':
    case 'preset.read':
    case 'preset.copy':
    case 'preset.openDocument':
    case 'preset.remove':
    case 'session.export':
      return true
    default:
      return false
  }
}

function imageMimeType(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase()
  switch (extension) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return undefined
  }
}

function attachmentMimeType(filePath: string, bytes: Buffer): string | undefined {
  const imageType = imageMimeType(filePath)
  if (imageType !== undefined) return imageType

  const fileName = path.basename(filePath).toLowerCase()
  const extension = path.extname(fileName)
  if (BINARY_ATTACHMENT_EXTENSIONS.has(extension)) return undefined
  const knownTextType =
    TEXT_ATTACHMENT_MIME_TYPES[extension] ?? (fileName === '.env' ? 'text/plain' : undefined)
  if (knownTextType !== undefined) return validTextBytes(bytes) ? knownTextType : undefined
  return validTextBytes(bytes) ? 'text/plain' : undefined
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

function validTextBytes(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  return !bytes.toString('utf8').includes('\ufffd')
}

const TEXT_ATTACHMENT_MIME_TYPES: Readonly<Record<string, string>> = {
  '.c': 'text/x-c',
  '.cc': 'text/x-c++',
  '.cpp': 'text/x-c++',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.go': 'text/x-go',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ini': 'text/plain',
  '.java': 'text/x-java-source',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.jsx': 'text/javascript',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.mjs': 'text/javascript',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.scss': 'text/x-scss',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.svelte': 'text/html',
  '.toml': 'application/toml',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.txt': 'text/plain',
  '.vue': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zsh': 'application/x-sh',
}

const BINARY_ATTACHMENT_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.bin',
  '.bz2',
  '.dll',
  '.doc',
  '.docx',
  '.exe',
  '.flac',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mp3',
  '.mp4',
  '.mov',
  '.pdf',
  '.ppt',
  '.pptx',
  '.psd',
  '.rar',
  '.tar',
  '.ttf',
  '.wav',
  '.webm',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip',
])

function validImageBytes(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (mimeType === 'image/webp')
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  return false
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return false
    throw new AppError({
      code: 'EXPORT_FAILED',
      message: 'The export destination could not be inspected.',
      retryable: false,
      cause: error,
    })
  }
}

function sanitize(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, parentKey))
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitivePublicField(parentKey, key)) continue
    result[key] = sanitize(entry, key)
  }
  return result
}

function isSensitivePublicField(parentKey: string | undefined, key: string): boolean {
  const normalizedParent = parentKey?.toLocaleLowerCase()
  const normalizedKey = key.toLocaleLowerCase()

  // These counters are intentionally public UI telemetry. The previous
  // broad `/token|input|output/` filter silently removed the DSH token meter
  // and tool summaries before they reached the Webview.
  if (normalizedParent === 'usage' || normalizedParent === 'tokenusage')
    return !SAFE_USAGE_FIELDS.has(normalizedKey) && isExactSensitiveField(normalizedKey)
  if (normalizedParent === 'contextpressure')
    return !SAFE_CONTEXT_FIELDS.has(normalizedKey) && isExactSensitiveField(normalizedKey)

  return isExactSensitiveField(normalizedKey)
}

const SAFE_USAGE_FIELDS = new Set([
  'inputtokens',
  'uncachedinputtokens',
  'outputtokens',
  'cachereadtokens',
  'cachewritetokens',
  'reasoningtokens',
])

const SAFE_CONTEXT_FIELDS = new Set(['pressuretokens', 'projectedtokens', 'contextwindow'])

function isExactSensitiveField(key: string): boolean {
  return SENSITIVE_PUBLIC_FIELDS.has(key)
}

const SENSITIVE_PUBLIC_FIELDS = new Set([
  'endpoint',
  'baseurl',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'password',
  'secret',
  'secretkey',
  'privatekey',
  'token',
  'pid',
  'executable',
  'commandline',
  'stack',
  'body',
  'response',
])
