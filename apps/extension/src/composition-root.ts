import * as vscode from 'vscode'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import {
  AppError,
  type AgentConfiguration,
  type BackendEndpoint,
  type BackendState,
  type DshBackend,
  type ExtensionSettings,
  type ExtensionSettingsSummary,
  type QuestionAnswer,
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
import {
  Rc6VersionAdapter,
  Rc7VersionAdapter,
  Rc8VersionAdapter,
  VersionedBackendFactory,
  VersionedBackendProbe,
  type ExportFileSystem,
} from '@dsh-vscode/dsh-adapter'
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
import { normalizeLoopbackUrl, VsCodeConfigurationSource } from './config/configuration-source.js'
import { DSH_DOCUMENTATION_URL, DSH_PACKAGE, OUTPUT_CHANNEL_NAME } from './constants.js'
import { WebviewMessageRouter } from './view/message-router.js'
import { DshWebviewViewProvider } from './view/dsh-webview-view-provider.js'
import { RuntimeInstaller } from './vscode/install-runtime.js'
import { DshRuntimeUpdater } from './vscode/update-runtime.js'
import { requestProviderSecret } from './vscode/credential-input.js'
import { moveOrExplainSecondarySidebar } from './vscode/secondary-sidebar.js'
import { updateContextKeys } from './vscode/context-keys.js'
import {
  AttachmentStore,
  decodeCanonicalBase64,
  isImageMimeType,
  MAX_ATTACHMENT_BYTES,
  validImageBytes,
  type StoredAttachmentInput,
} from './attachments/attachment-store.js'

const execFileAsync = promisify(execFile)
const TEMPORARY_WORKSPACE_STATE_KEY = 'dsh.temporaryWorkspace'

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
  const openMarkdownLink = async (href: string, revealInFolder = false): Promise<OpenLinkResult> => {
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
      if (revealInFolder) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath))
        return { opened: true }
      }
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
      const resolved =
        os === 'windows'
          ? resolveWindowsShim(npm, os, readTextFile, windowsShimOptions(os, process.env))
          : undefined
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
      const resolved = resolveWindowsShim(
        executable,
        platform(),
        readTextFile,
        windowsShimOptions(platform(), process.env),
      ) ?? {
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
  const adapterOptions = {
    get requestTimeoutMs() {
      return configuration.read().connection.requestTimeoutMs
    },
    get retryPolicy() {
      return { maximumAttempts: 2, baseDelayMs: 100, maximumDelayMs: 500 }
    },
    fetch: globalThis.fetch,
    samePath: sameWorkspacePath,
    exportFileSystem: createExportFileSystem(vscode),
  }
  const rc8Adapter = new Rc8VersionAdapter(adapterOptions)
  const rc7Adapter = new Rc7VersionAdapter(adapterOptions)
  const rc6Adapter = new Rc6VersionAdapter(adapterOptions)
  const adapters = [rc8Adapter, rc7Adapter, rc6Adapter] as const
  const probe = new VersionedBackendProbe(adapters)
  const factory = new VersionedBackendFactory(adapters)
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
      const resolved =
        os === 'windows'
          ? resolveWindowsShim(npm, os, readTextFile, windowsShimOptions(os, process.env))
          : undefined
      await execFileAsync(
        resolved?.executable ?? npm,
        [...(resolved?.prefixArgs ?? []), 'install', '--global', DSH_PACKAGE],
        {
          timeout: 120_000,
          maxBuffer: 32 * 1024,
          env: runtimeEnvironment(undefined, resolved?.executable ?? npm),
        },
      )
    },
    verifyInstall: async () => (await runtimeLocator.locate())?.supported === true,
    verifyExecutable: async (executable) => (await runtimeLocator.inspectExecutable(executable)).supported,
  })
  const runtimeUpdater = new DshRuntimeUpdater({
    npmExecutable: () => {
      const os = platform()
      return resolveNpmExecutable(os, runtimePathEntries(os, process.env))
    },
    locateRuntime: (signal) => runtimeLocator.locate(signal),
    execute: async (executable, args, options) => {
      const resolved =
        platform() === 'windows'
          ? resolveWindowsShim(
              executable,
              'windows',
              readTextFile,
              windowsShimOptions('windows', { ...process.env, ...(options.env ?? {}) }),
            )
          : undefined
      const resolvedExecutable = resolved?.executable ?? executable
      const result = await execFileAsync(resolvedExecutable, [...(resolved?.prefixArgs ?? []), ...args], {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
        env: runtimeEnvironment(options.env, resolvedExecutable),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      return {
        stdout: result.stdout,
        stderr: result.stderr,
      }
    },
    environment: () => runtimeEnvironment(),
  })
  const runtimeUpdateLifecycle = new AbortController()
  const runtimeUseCases = new RuntimeUseCases({
    install: () => runtimeInstaller.install(),
    selectExecutable: () => runtimeInstaller.selectExecutable(),
    copyInstallCommand: () => Promise.resolve(runtimeInstaller.copyInstallCommand()),
    openDocumentation: () => Promise.resolve(runtimeInstaller.openDocumentation()).then(() => undefined),
    checkForUpdates: (force, signal) => runtimeUpdater.checkForUpdates(force, signal),
    installVersion: (version, signal) => runtimeUpdater.installVersion(version, signal),
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
  const attachmentTokens = new AttachmentStore()
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
    const { presets } = await backendService.requireBackend().presets.list(signal)
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
    const customEndpoint =
      current.connection.mode === 'custom' ? endpointFromServerUrl(current.connection.serverUrl) : undefined
    const request: ConnectionRequest = {
      mode: current.connection.mode,
      ...(customEndpoint === undefined ? {} : { endpoint: customEndpoint }),
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
  const configureConnection = async (
    mode: 'auto' | 'custom',
    endpoint: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const settings = vscode.workspace.getConfiguration('dsh')
    if (mode === 'custom') {
      const normalized = normalizeLoopbackUrl(endpoint ?? '')
      if (normalized === undefined)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'Enter an HTTP loopback endpoint such as http://127.0.0.1:3080.',
          retryable: false,
        })
      // Write the endpoint before switching modes so the configuration is
      // never observed in a transient custom-without-endpoint state.
      await settings.update('connection.serverUrl', normalized, vscode.ConfigurationTarget.Global)
      await settings.update('connection.mode', mode, vscode.ConfigurationTarget.Global)
    } else {
      // Switch out of custom mode before clearing its endpoint for the same
      // reason. Existing attach-only/new-isolated settings remain untouched
      // until the user explicitly chooses a mode here.
      await settings.update('connection.mode', mode, vscode.ConfigurationTarget.Global)
      await settings.update('connection.serverUrl', '', vscode.ConfigurationTarget.Global)
    }
    return reconnect(signal)
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
  const requireCurrentWorkspaceId = async (workspaceId: string, signal: AbortSignal): Promise<void> => {
    const workspaces = await listCurrentWorkspaces(signal)
    if (workspaces.some((workspace) => workspace.id === workspaceId)) return
    throw new AppError({
      code: 'PERMISSION_DENIED',
      message: 'The requested workspace is not part of the current VS Code workspace.',
      retryable: false,
    })
  }
  const requireOwnedQueuedInput = async (inputId: string, signal: AbortSignal): Promise<void> => {
    const owner = backendService.requireBackend().sessions.sessionForQueuedInput?.(inputId)
    if (owner === undefined) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The queued DSH input is not owned by the current workspace.',
        retryable: false,
      })
    }
    await requireCurrentWorkspaceSession(owner, signal)
  }
  const requireOwnedGoal = async (goalId: string, signal: AbortSignal): Promise<void> => {
    const owner = backendService.requireBackend().goals.sessionForGoal?.(goalId)
    if (owner === undefined) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The requested goal is not owned by the current workspace.',
        retryable: false,
      })
    }
    await requireCurrentWorkspaceSession(owner, signal)
  }
  const requireOwnedPermission = async (requestId: string, signal: AbortSignal): Promise<void> => {
    const owner = backendService.requireBackend().interactions.sessionForPermission?.(requestId)
    if (owner === undefined) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The requested permission is not owned by the current workspace.',
        retryable: false,
      })
    }
    await requireCurrentWorkspaceSession(owner, signal)
  }
  const requireOwnedQuestion = async (questionId: string, signal: AbortSignal): Promise<void> => {
    const owner = backendService.requireBackend().interactions.sessionForQuestion?.(questionId)
    if (owner === undefined) {
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'The requested question is not owned by the current workspace.',
        retryable: false,
      })
    }
    await requireCurrentWorkspaceSession(owner, signal)
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
      if (request.payload.action === 'install' || request.payload.action === 'select') return connect(signal)
      return undefined
    }
    if (request.type === 'runtime.update.check')
      return publicValue(await runtimeUseCases.checkForUpdates(request.payload.force === true, signal))
    if (request.type === 'runtime.update.install')
      return publicValue(await runtimeUseCases.installVersion(request.payload.version, signal))
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
    if (request.type === 'workspace.rename') {
      await requireCurrentWorkspaceId(request.payload.workspaceId, signal)
      return workspaceUseCases.rename(request.payload.workspaceId, request.payload.name, signal)
    }
    if (request.type === 'workspace.remove') {
      await requireCurrentWorkspaceId(request.payload.workspaceId, signal)
      const removesTemporaryWorkspace =
        request.payload.workspaceId === temporaryWorkspace?.id ||
        request.payload.workspaceId === temporaryWorkspaceReference?.id
      const result = await workspaceUseCases.remove(request.payload.workspaceId, signal)
      if (removesTemporaryWorkspace) await forgetTemporaryWorkspace(true)
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
    if (request.type === 'session.history') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const page = await backendService
        .requireBackend()
        .sessions.history(request.payload.sessionId, request.payload.beforeSeq, signal)
      return publicValue({
        events: page.events,
        hasMore: page.hasMore,
        ...(page.beforeSequence === undefined ? {} : { beforeSeq: page.beforeSequence }),
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
    if (request.type === 'session.rename') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return backendService
        .requireBackend()
        .sessions.rename(request.payload.sessionId, request.payload.title, signal)
    }
    if (request.type === 'session.remove') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return sessionUseCases.remove(request.payload.sessionId, signal)
    }
    if (request.type === 'session.fork') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(await sessionUseCases.fork(request.payload.sessionId, request.payload.atSeq, signal))
    }
    if (request.type === 'session.archive') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return sessionUseCases.setArchived(request.payload.sessionId, request.payload.archived, signal)
    }
    if (request.type === 'session.sendPrompt') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const attachments = attachmentTokens.resolve(request.payload.attachments)
      const result = await sessionUseCases.sendPrompt(
        { sessionId: request.payload.sessionId, text: request.payload.text, attachments },
        request.payload.mode ?? 'queue',
        signal,
      )
      // The Webview keeps the chips after a failed send so the user can retry;
      // retain their opaque handles on that path as well. Successful admission
      // consumes them exactly once.
      attachmentTokens.release(request.payload.attachments)
      return result
    }
    if (request.type === 'session.enqueuePrompt') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const attachments = attachmentTokens.resolve(request.payload.attachments)
      const queued = await sessionUseCases.enqueuePrompt(
        { sessionId: request.payload.sessionId, text: request.payload.text, attachments },
        request.payload.mode,
        signal,
      )
      attachmentTokens.release(request.payload.attachments)
      return publicValue(queued)
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
        attachment: attachmentTokens.remember({
          name: path.basename(uri.fsPath),
          mimeType,
          dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
        }),
      }
    }
    if (request.type === 'attachment.ingest') {
      const { name, mimeType, dataBase64 } = request.payload
      const bytes = decodeCanonicalBase64(dataBase64)
      return {
        cancelled: false,
        attachment: attachmentTokens.remember(prepareAttachment(name, bytes, mimeType)),
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
        attachment: attachmentTokens.remember(attachment),
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
      const files = backend.references
        .listFiles(request.payload.sessionId, request.payload.query, signal)
        .catch(() => [])
      const sessions =
        request.payload.quoted === true
          ? Promise.resolve([])
          : backend.references
              .listSessions(request.payload.sessionId, request.payload.query, signal)
              .catch(() => [])
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
    if (request.type === 'extensionSettings.read')
      return publicValue(publicExtensionSettings(configuration.read()))
    if (request.type === 'settings.update')
      return settingsUseCases.update(request.payload.path, request.payload.value, signal)
    if (request.type === 'settings.unset') return settingsUseCases.unset(request.payload.path, signal)
    if (request.type === 'settings.replace')
      return backendService.requireBackend().settings.replace(request.payload.values, signal)
    if (request.type === 'goal.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(await advancedUseCases.listGoals(request.payload.sessionId, signal))
    }
    if (request.type === 'goal.create') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(
        await backendService
          .requireBackend()
          .goals.create(request.payload.sessionId, request.payload.title, signal),
      )
    }
    if (request.type === 'goal.update') {
      await requireOwnedGoal(request.payload.goalId, signal)
      return backendService.requireBackend().goals.update(
        request.payload.goalId,
        {
          ...(request.payload.title === undefined ? {} : { title: request.payload.title }),
          ...(request.payload.status === undefined ? {} : { status: request.payload.status }),
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
    if (request.type === 'subagent.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(await advancedUseCases.listSubagents(request.payload.sessionId, signal))
    }
    if (request.type === 'subagent.history') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(await advancedUseCases.listSubagentHistory(request.payload.sessionId, signal))
    }
    if (request.type === 'subagent.send') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return advancedUseCases.execute('subagent.send', request.payload, signal)
    }
    if (request.type === 'subagent.interrupt') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return advancedUseCases.execute('subagent.interrupt', request.payload, signal)
    }
    if (request.type === 'skill.list') {
      if (request.payload.sessionId !== undefined)
        await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(await advancedUseCases.listSkills(request.payload.sessionId, signal))
    }
    if (request.type === 'skill.refresh') {
      if (request.payload.sessionId !== undefined)
        await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(await advancedUseCases.listSkills(request.payload.sessionId, signal))
    }
    if (request.type === 'skill.execute') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return advancedUseCases.execute('skill.execute', request.payload, signal)
    }
    if (request.type === 'command.list') {
      if (request.payload.sessionId !== undefined)
        await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicList(await advancedUseCases.listCommands(request.payload.sessionId, signal))
    }
    if (request.type === 'command.execute') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const attachments = attachmentTokens.resolve(request.payload.attachments ?? [])
      return publicValue(
        await advancedUseCases.execute('command.execute', { ...request.payload, attachments }, signal),
      )
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
    if (request.type === 'preset.select') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return advancedUseCases.selectPreset(request.payload.sessionId, request.payload.presetId, signal)
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
          'dsh.openSettings': async () => {
            const delivered = await postEvent('ui.settings.toggle', {})
            if (!delivered)
              await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:Direwolf.deepseek-harness-client',
              )
          },
          'dsh.openWebUi': async () => {
            const state = coordinator.getState()
            if (state.kind !== 'connected') {
              void vscode.window.showInformationMessage(
                'Connect to a local DSH instance before opening its Web UI.',
              )
              return
            }
            const opened = await vscode.env.openExternal(vscode.Uri.parse(state.backend.endpoint.baseUrl))
            if (!opened)
              void vscode.window.showWarningMessage('Unable to open the DSH Web UI in your browser.')
          },
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
      // Check once per Extension Host activation. This is independent of
      // connection startup and only probes the runtime/npm registry; the
      // Webview receives the cached, safe version snapshot when it opens.
      void runtimeUpdater.checkForUpdates(false, runtimeUpdateLifecycle.signal).catch(() => undefined)
      return Promise.resolve()
    },
    dispose: async () => {
      runtimeUpdateLifecycle.abort()
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

function endpointFromServerUrl(serverUrl: string | undefined): BackendEndpoint | undefined {
  if (serverUrl === undefined) return undefined
  try {
    const parsed = new URL(serverUrl)
    const host = parsed.hostname
    const port = Number(parsed.port)
    if (
      parsed.protocol !== 'http:' ||
      (host !== '127.0.0.1' && host !== 'localhost') ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    )
      return undefined
    return { host, port, baseUrl: `http://${host}:${port}` }
  } catch {
    return undefined
  }
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

function windowsShimOptions(
  os: 'windows' | 'linux' | 'macos',
  environment: NodeJS.ProcessEnv,
): {
  readonly pathEntries: readonly string[]
  readonly processExecutable: string
} {
  return {
    pathEntries: runtimePathEntries(os, environment),
    processExecutable: process.execPath,
  }
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

function createExportFileSystem(api: typeof vscode): ExportFileSystem {
  const uri = (filePath: string): vscode.Uri => api.Uri.file(filePath)
  return {
    stat: async (filePath) => {
      const info = await api.workspace.fs.stat(uri(filePath))
      return { isDirectory: () => (info.type & api.FileType.Directory) !== 0 }
    },
    rename: async (source, destination, overwrite = false) => {
      await api.workspace.fs.rename(uri(source), uri(destination), { overwrite })
    },
    unlink: async (filePath) => {
      await api.workspace.fs.delete(uri(filePath), { recursive: false, useTrash: false })
    },
    writeFile: async (filePath, data) => {
      await api.workspace.fs.writeFile(uri(filePath), data)
    },
  }
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
  const childEnvironment = { ...process.env, ...(environment ?? {}) }
  const resolved = resolveWindowsShim(
    executable,
    platform(),
    readTextFile,
    windowsShimOptions(platform(), childEnvironment),
  )
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
    ...(state.kind === 'connected'
      ? {
          dshVersion: state.backend.capabilities.dshVersion,
          ...(state.backend.capabilities.compatibilityWarning === undefined
            ? {}
            : { compatibilityWarning: state.backend.capabilities.compatibilityWarning }),
        }
      : {}),
    ...(state.kind === 'failed'
      ? { message: safeStateMessage(state.message), retryable: state.retryable }
      : {}),
    ...(state.kind === 'port-conflict'
      ? { message: 'The configured DSH port is unavailable.', retryable: state.retryable, port: state.port }
      : {}),
    ...(state.kind === 'runtime-missing'
      ? { searchedLocations: publicRuntimeLocations(state.searchedLocations) }
      : {}),
  }
}

function publicRuntimeLocations(locations: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const location of locations) {
    const normalized = path.normalize(location)
    const name = path.basename(normalized)
    const parent = path.basename(path.dirname(normalized))
    const label = parent === '' || parent === '.' ? name : `${parent}/${name}`
    if (label === '' || seen.has(label)) continue
    seen.add(label)
    result.push(label)
  }
  return result
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
): Promise<StoredAttachmentInput | undefined> {
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

function prepareAttachment(name: string, bytes: Buffer, hintMimeType?: string): StoredAttachmentInput {
  if (bytes.length > MAX_ATTACHMENT_BYTES)
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The current file is too large to attach.',
      retryable: false,
    })
  let mimeType = attachmentMimeType(name, bytes)
  // Pasted clipboard images often carry no filename extension. The declared
  // hint only fills that gap and is still verified against the image magic
  // numbers below, so a spoofed hint cannot smuggle unsupported bytes.
  if (mimeType === undefined && hintMimeType !== undefined && isImageMimeType(hintMimeType))
    mimeType = hintMimeType
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
  const compact = message.replace(/\s+/gu, ' ').trim()
  if (compact === '') return 'The DSH connection operation failed.'
  const redacted = compact.replace(
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|private[_ -]?key|token)\b\s*[:=]\s*[^\s,;]+/giu,
    (match) => match.replace(/[:=].*$/u, ': [redacted]'),
  )
  return redacted.slice(0, 320)
}

function publicList(value: readonly unknown[]): readonly unknown[] {
  return value.map(publicValue)
}
function publicValue(value: unknown): unknown {
  return sanitize(value)
}

function publicExtensionSettings(settings: ExtensionSettings): ExtensionSettingsSummary {
  return {
    connection: {
      mode: settings.connection.mode,
      customEndpointConfigured: settings.connection.serverUrl !== undefined,
    },
    runtime: {
      customExecutableConfigured: settings.runtime.executablePath !== undefined,
      autoStart: settings.runtime.autoStart,
    },
    security: { defaultPermissionPreset: settings.security.defaultPermissionPreset },
    defaultAgent: settings.defaultAgent,
  }
}

/** Zod-inferred optional fields carry `| undefined`; the domain's
 * exactOptionalPropertyTypes contracts require it stripped before the
 * parsed payload reaches application use cases. */
function questionResponse(
  response:
    | string
    | readonly string[]
    | readonly {
        readonly id: string
        readonly response: string | string[]
        readonly custom?: string | undefined
      }[],
): string | readonly string[] | readonly QuestionAnswer[] {
  if (typeof response === 'string') return response
  const labels: string[] = []
  const answers: QuestionAnswer[] = []
  for (const entry of response) {
    if (typeof entry === 'string') labels.push(entry)
    else
      answers.push({
        id: entry.id,
        response: entry.response,
        ...(entry.custom === undefined ? {} : { custom: entry.custom }),
      })
  }
  return answers.length > 0 ? answers : labels
}

function requiresTrustedWorkspace(type: WebviewRequest['type']): boolean {
  switch (type) {
    case 'workspace.create':
    case 'workspace.rename':
    case 'workspace.remove':
    case 'workspace.move':
    case 'session.move':
    case 'session.create':
    case 'session.rename':
    case 'session.remove':
    case 'session.fork':
    case 'session.archive':
    case 'session.open':
    case 'session.history':
    case 'session.sendPrompt':
    case 'session.enqueuePrompt':
    case 'session.queue.list':
    case 'session.queue.update':
    case 'session.queue.remove':
    case 'session.queue.steer':
    case 'session.cancel':
    case 'session.configure':
    case 'attachment.pick':
    case 'attachment.ingest':
    case 'attachment.preview':
    case 'attachment.open.list':
    case 'attachment.open.attach':
    case 'attachment.read':
    case 'reference.list':
    case 'feedback.list':
    case 'feedback.toggle':
    case 'feedback.note':
    case 'feedback.remove':
    case 'provider.secret.configure':
    case 'provider.secret.remove':
    case 'interaction.permission.respond':
    case 'interaction.question.respond':
    case 'interaction.question.cancel':
    case 'settings.update':
    case 'settings.unset':
    case 'settings.replace':
    case 'settings.openDocument':
    case 'goal.create':
    case 'goal.list':
    case 'goal.update':
    case 'goal.clear':
    case 'subagent.send':
    case 'subagent.interrupt':
    case 'subagent.list':
    case 'subagent.history':
    case 'skill.list':
    case 'skill.refresh':
    case 'skill.execute':
    case 'command.list':
    case 'command.execute':
    case 'job.list':
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath))
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'FileNotFound')
    )
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
  'processid',
  'process_id',
  'executable',
  'executablepath',
  'executable_path',
  'managedport',
  'managed_port',
  'attachports',
  'attach_ports',
  'serverurl',
  'server_url',
  'commandline',
  'stack',
  'body',
  'response',
])
