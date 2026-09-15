import * as vscode from 'vscode'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import {
  AppError,
  type CheckpointPreview,
  type CheckpointSummary,
  type DiagnosticsSnapshot,
  FEATURE_CAPABILITY_IDS,
  type AgentConfiguration,
  type BackendEvent,
  type ChangeSetFile,
  type BackendEndpoint,
  type BackendState,
  type DshBackend,
  type DshRuntimeUpdateProgress,
  type ExtensionSettings,
  type ExtensionSettingsSummary,
  type FeatureCapabilityProfile,
  type EditorContextOwner,
  type EditorContextAvailability,
  type EditorContextKind,
  type PromptTemplateSummary,
  type QuestionAnswer,
  type EditorContextItem,
  type SessionDetail,
  type SessionSummary,
  type TaskListSnapshot,
  type TaskListScope,
  type TaskSummary,
  type WorkspaceSummary,
} from '@dsh-vscode/domain'
import {
  AdvancedAgentUseCases,
  BackendService,
  ChangeUseCases,
  CheckpointUseCases,
  DshConnectionCoordinator,
  EditorContextUseCases,
  ExportUseCases,
  InteractionUseCases,
  ModelSettingsUseCases,
  NavigationUseCases,
  PromptTemplateUseCases,
  ProviderSettingsUseCases,
  RuntimeUseCases,
  SessionUseCases,
  SettingsUseCases,
  TaskUseCases,
  WorkspaceUseCases,
  type ConnectionRequest,
} from '@dsh-vscode/application'
import {
  Alpha151VersionAdapter,
  Alpha152VersionAdapter,
  Alpha161VersionAdapter,
  Alpha132VersionAdapter,
  Alpha13VersionAdapter,
  Alpha5VersionAdapter,
  Alpha4VersionAdapter,
  Alpha3VersionAdapter,
  Alpha2VersionAdapter,
  Alpha1VersionAdapter,
  LegacyRc1VersionAdapter,
  LegacyRc2VersionAdapter,
  LegacyRc5VersionAdapter,
  Rc02VersionAdapter,
  Rc03VersionAdapter,
  Rc6VersionAdapter,
  Rc7VersionAdapter,
  Rc8VersionAdapter,
  Rc11VersionAdapter,
  Rc12VersionAdapter,
  Rc13VersionAdapter,
  Rc151VersionAdapter,
  Rc152VersionAdapter,
  VersionedBackendFactory,
  VersionedBackendProbe,
  redactText,
  type ExportFileSystem,
} from '@dsh-vscode/dsh-adapter'
import {
  hostEnvelopeSchema,
  hostMessageSchema,
  featureHostEnvelopeSchema,
  featureHostMessageSchema,
  type FeatureHostEvent,
  type FeatureHostMessage,
  type FeatureRequest,
  type FeatureResponse,
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
import { isManagedTemporaryWorkspacePath, isPathWithin } from './backend/path-safety.js'
import { DshRuntimeLocator, readStoredRuntimePath } from './backend/runtime-locator.js'
import { isAbsoluteFilePath, resolveNpmExecutable, runtimePathEntries } from './backend/runtime-paths.js'
import { TemporaryWorkspaceManager, type StoredTemporaryWorkspace } from './backend/temporary-workspace.js'
import { resolveWindowsShim } from './backend/windows-shim.js'
import { normalizeLoopbackUrl, VsCodeConfigurationSource } from './config/configuration-source.js'
import { DSH_DOCUMENTATION_URL, DSH_PACKAGE, OUTPUT_CHANNEL_NAME } from './constants.js'
import { WebviewMessageRouter } from './view/message-router.js'
import { DshWebviewViewProvider } from './view/dsh-webview-view-provider.js'
import {
  publicWorkspaceRelativePath,
  publicWorkspaceSummary,
  sanitizePublicValue,
} from './view/public-value.js'
import { RuntimeInstaller } from './vscode/install-runtime.js'
import { DshRuntimeUpdater } from './vscode/update-runtime.js'
import { requestOptionalProviderApiKey, requestProviderSecret } from './vscode/credential-input.js'
import { moveOrExplainSecondarySidebar } from './vscode/secondary-sidebar.js'
import { updateContextKeys, updateEditorContextAvailabilityKeys } from './vscode/context-keys.js'
import { DSH_CHAT_VIEW_OWNER_ID, EditorContextProvider } from './editor/editor-context-provider.js'
import { NavigationService } from './navigation/navigation-service.js'
import { ChangeSetTracker } from './changes/change-set-tracker.js'
import { CheckpointStore } from './checkpoints/checkpoint-store.js'
import {
  createVscodeCheckpointStorage,
  createVscodeCheckpointWorkspace,
} from './checkpoints/vscode-checkpoint-adapter.js'
import { TaskCenterRegistry } from './tasks/task-center-registry.js'
import { PromptTemplateStore } from './prompts/prompt-template-store.js'
import {
  createVscodePromptTemplateStorage,
  createVscodeWorkspacePromptTemplateStorage,
} from './prompts/vscode-prompt-template-adapter.js'
import { workspaceFolderId, WorkspacePathGuard } from './editor/workspace-path-guard.js'
import {
  AttachmentStore,
  decodeCanonicalBase64,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  type StoredAttachmentInput,
} from './attachments/attachment-store.js'
import {
  attachmentMimeType,
  isImageMimeType,
  prepareAttachment,
  validImageBytes,
} from './attachments/attachment-codec.js'

type FeatureResponsePayload = Extract<FeatureResponse, { readonly ok: true }>['payload']
type FeatureContextKind = 'selection' | 'open-document' | 'diagnostic' | 'symbol'

const execFileAsync = promisify(execFile)
const TEMPORARY_WORKSPACE_STATE_KEY = 'dsh.temporaryWorkspace'
const RUNTIME_PATH_STATE_KEY = 'dsh.runtime.lastKnownPath'
const TRANSPORT_CONFIGURATION_KEYS = [
  'dsh.connection.mode',
  'dsh.connection.serverUrl',
  'dsh.connection.managedPort',
  'dsh.connection.attachPorts',
  'dsh.connection.discoveryTimeoutMs',
  'dsh.connection.requestTimeoutMs',
] as const

interface OpenLinkResult {
  readonly opened: boolean
  readonly message?: string
}

export interface CompositionRoot extends vscode.Disposable {
  start(): Promise<void>
}

export function createCompositionRoot(context: vscode.ExtensionContext): CompositionRoot {
  const configuration = new VsCodeConfigurationSource(vscode.workspace)
  const extensionVersion = readExtensionVersion(context)
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
      ...(temporaryWorkspaceManager.current?.path === undefined
        ? []
        : [temporaryWorkspaceManager.current.path]),
      ...(temporaryWorkspaceManager.reference?.path === undefined
        ? []
        : [temporaryWorkspaceManager.reference.path]),
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
    pathEntries: () => extensionRuntimePathEntries(platform(), process.env),
    lastKnownRuntimePath: () =>
      readStoredRuntimePath(context.globalState.get<unknown>(RUNTIME_PATH_STATE_KEY)),
    rememberRuntimePath: (hint) => {
      void context.globalState.update(RUNTIME_PATH_STATE_KEY, hint)
    },
    npmGlobalPrefix: async (signal) => {
      const os = platform()
      const npm = resolveNpmExecutable(os, extensionRuntimePathEntries(os, process.env))
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
  const endpointCookies = new Map<string, string>()
  // Keep the process launch URL in the Extension Host so the browser can
  // perform its own cookie exchange. The URL is never included in Webview
  // state or messages.
  const endpointLaunchUrls = new Map<string, string>()
  const rememberReadyEndpoint = async (endpoint: BackendEndpoint, launchUrl?: string): Promise<void> => {
    // A managed port can be reused by a fresh DSH process. Never let a cookie
    // from the previous process authorize the new endpoint.
    endpointCookies.delete(endpoint.baseUrl)
    endpointLaunchUrls.delete(endpoint.baseUrl)
    if (launchUrl === undefined) return
    let response: Response
    try {
      response = await globalThis.fetch(launchUrl, { method: 'GET', redirect: 'manual' })
    } catch {
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The managed DSH web login could not be completed.',
        retryable: true,
      })
    }
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const setCookies = headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? '']
    const cookie = setCookies
      .map((value) => value.split(';', 1)[0]?.trim() ?? '')
      .find((value) => /^[^=;\s]+=[^;\r\n]+$/u.test(value))
    if (response.status < 300 || response.status >= 400 || cookie === undefined) {
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The managed DSH web login returned no session cookie.',
        retryable: true,
      })
    }
    endpointCookies.set(endpoint.baseUrl, cookie)
    endpointLaunchUrls.set(endpoint.baseUrl, launchUrl)
  }
  const alpha2Adapter = new Alpha2VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha132Adapter = new Alpha132VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha151Adapter = new Alpha151VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha152Adapter = new Alpha152VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const rc151Adapter = new Rc151VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const rc152Adapter = new Rc152VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha161Adapter = new Alpha161VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha13Adapter = new Alpha13VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const rc13Adapter = new Rc13VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha3Adapter = new Alpha3VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha5Adapter = new Alpha5VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha4Adapter = new Alpha4VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const alpha1Adapter = new Alpha1VersionAdapter({
    ...adapterOptions,
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const rc12Adapter = new Rc12VersionAdapter(adapterOptions)
  const rc11Adapter = new Rc11VersionAdapter(adapterOptions)
  const rc8Adapter = new Rc8VersionAdapter(adapterOptions)
  const rc7Adapter = new Rc7VersionAdapter(adapterOptions)
  const rc6Adapter = new Rc6VersionAdapter(adapterOptions)
  const rc03Adapter = new Rc03VersionAdapter(adapterOptions)
  const rc02Adapter = new Rc02VersionAdapter(adapterOptions)
  const legacyRc5Adapter = new LegacyRc5VersionAdapter(adapterOptions)
  const legacyRc2Adapter = new LegacyRc2VersionAdapter(adapterOptions)
  const legacyRc1Adapter = new LegacyRc1VersionAdapter(adapterOptions)
  const adapters = [
    alpha161Adapter,
    rc152Adapter,
    rc151Adapter,
    alpha152Adapter,
    alpha151Adapter,
    alpha132Adapter,
    alpha13Adapter,
    rc13Adapter,
    alpha5Adapter,
    alpha4Adapter,
    alpha3Adapter,
    alpha2Adapter,
    alpha1Adapter,
    rc12Adapter,
    rc11Adapter,
    rc8Adapter,
    rc7Adapter,
    rc6Adapter,
    rc03Adapter,
    rc02Adapter,
    legacyRc5Adapter,
    legacyRc2Adapter,
    legacyRc1Adapter,
  ] as const
  const probe = new VersionedBackendProbe(adapters, { fetch: globalThis.fetch })
  const factory = new VersionedBackendFactory(adapters)
  const supervisor = new DshProcessSupervisor({
    managedPort: () => configuration.read().connection.managedPort,
    workingDirectory: () => currentWorkspaceFolder()?.uri.fsPath ?? process.cwd(),
    toolMode: () => configuration.read().defaultAgent.toolMode,
    spawn: spawnManagedChild,
    onReadyEndpoint: rememberReadyEndpoint,
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
      const npm = resolveNpmExecutable(os, extensionRuntimePathEntries(os, process.env))
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
    verifyInstall: async () => (await runtimeLocator.locate()).runtime?.supported === true,
    verifyExecutable: async (executable) => (await runtimeLocator.inspectExecutable(executable)).supported,
  })
  let postRuntimeUpdateProgress: (progress: DshRuntimeUpdateProgress) => void = () => undefined
  const runtimeUpdater = new DshRuntimeUpdater({
    npmExecutable: () => {
      const os = platform()
      return resolveNpmExecutable(os, extensionRuntimePathEntries(os, process.env))
    },
    locateRuntime: async (signal) => (await runtimeLocator.locate(signal)).runtime,
    onProgress: (progress) => postRuntimeUpdateProgress(progress),
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
  const providerSettingsUseCases = new ProviderSettingsUseCases(backendService)
  const advancedUseCases = new AdvancedAgentUseCases(backendService)
  const exportUseCases = new ExportUseCases(backendService)
  const initialTemporaryWorkspaceReference = readStoredTemporaryWorkspace(
    context.globalState.get<unknown>(TEMPORARY_WORKSPACE_STATE_KEY),
  )
  const temporaryWorkspaceManager = new TemporaryWorkspaceManager({
    rootPath: context.globalStorageUri.fsPath,
    ...(initialTemporaryWorkspaceReference === undefined
      ? {}
      : { initialReference: initialTemporaryWorkspaceReference }),
    createWorkspace: (input, signal) => workspaceUseCases.create(input, signal),
    ensureDirectory: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true })
    },
    createTemporaryDirectory: (prefix) => mkdtemp(prefix),
    removeDirectory: (directoryPath) => rm(directoryPath, { recursive: true, force: true }),
    isManagedPath: (candidatePath) =>
      isManagedTemporaryWorkspacePath(context.globalStorageUri.fsPath, candidatePath),
    samePath: sameWorkspacePath,
    persistReference: async (reference) => {
      await context.globalState.update(TEMPORARY_WORKSPACE_STATE_KEY, reference)
    },
  })
  const attachmentTokens = new AttachmentStore()
  const editorContextProvider = new EditorContextProvider({ commands: vscode.commands })
  const editorContextUseCases = new EditorContextUseCases(editorContextProvider)
  const navigationService = new NavigationService()
  const navigationUseCases = new NavigationUseCases(navigationService)
  const featureOwner = (): EditorContextOwner => ({
    ownerId: DSH_CHAT_VIEW_OWNER_ID,
    ownerViewId: DSH_CHAT_VIEW_OWNER_ID,
    contextStoreGeneration: 1,
  })
  const listCurrentWorkspaces = async (signal?: AbortSignal): Promise<readonly WorkspaceSummary[]> => {
    const folders = currentWorkspaceFolders()
    const workspaces = await workspaceUseCases.list(signal)
    if (folders.length === 0) {
      return [await temporaryWorkspaceManager.resolve(workspaces, signal)]
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
  // Opening one session fans out into several advisory reads (queue, goals,
  // jobs, feedback, subagents, commands, and model settings). They all need
  // the same workspace ownership check, but each request used to repeat the
  // full workspace/archive/session-history chain. Keep one validated detail
  // per current backend generation and share in-flight reads across those
  // requests. `session.open` can opt into a fresh read below.
  const currentWorkspaceSessionDetails = new Map<
    string,
    { readonly generation: number; readonly detail: SessionDetail }
  >()
  const currentWorkspaceSessionLoads = new Map<string, Promise<SessionDetail>>()
  let currentWorkspaceSessionGeneration = 0
  const invalidateCurrentWorkspaceSessionDetails = (): void => {
    currentWorkspaceSessionGeneration += 1
    currentWorkspaceSessionDetails.clear()
    currentWorkspaceSessionLoads.clear()
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

    return temporaryWorkspaceManager.ensure(signal)
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
  const post = (message: HostMessage | FeatureHostMessage): Thenable<boolean> => {
    const legacy = hostMessageSchema.safeParse(message)
    if (legacy.success)
      return provider.postMessage(hostEnvelopeSchema.parse({ protocolVersion: 1, message: legacy.data }))
    const feature = featureHostMessageSchema.safeParse(message)
    if (feature.success)
      return provider.postMessage(
        featureHostEnvelopeSchema.parse({ protocolVersion: 1, message: feature.data }),
      )
    diagnostics.log('warn', 'host-message-rejected', { code: 'PROTOCOL_ERROR' })
    return Promise.resolve(false)
  }
  let featureLocalSequence = 0
  const postFeatureEvent = (
    name: 'editor.context.changed' | 'editor.context.availability.changed',
    payload:
      | { readonly contextRef: string; readonly action: 'added' | 'updated' | 'released' }
      | { readonly availableKinds: FeatureContextKind[] },
  ): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    const backendInstanceId = connection.backendInstanceId
    const connectionGeneration = connection.connectionGeneration
    if (backendInstanceId === undefined || connectionGeneration === undefined) return Promise.resolve(false)
    featureLocalSequence += 1
    const identity = {
      backendInstanceId,
      connectionGeneration,
      stream: 'local' as const,
      localSeq: featureLocalSequence,
    }
    const event: FeatureHostEvent =
      name === 'editor.context.changed'
        ? {
            type: 'feature.event',
            name,
            identity,
            contextRef: (payload as { readonly contextRef: string }).contextRef,
            action: (payload as { readonly action: 'added' | 'updated' | 'released' }).action,
          }
        : {
            type: 'feature.event',
            name,
            identity,
            availableKinds: (payload as { readonly availableKinds: FeatureContextKind[] }).availableKinds,
          }
    return Promise.resolve(post(event))
  }
  const postEditorContextAvailabilityEvent = async (): Promise<void> => {
    try {
      const availability = await editorContextUseCases.availability(featureOwner())
      await updateEditorContextAvailabilityKeys(vscode.commands, availability.availableKinds)
      await postFeatureEvent('editor.context.availability.changed', {
        availableKinds: featureContextKinds(availability),
      })
    } catch {
      await updateEditorContextAvailabilityKeys(vscode.commands, []).catch(() => undefined)
      // Capability refresh is best effort; the next feature list remains the
      // authoritative recovery path when the view or backend is reconnecting.
    }
  }
  const currentWorkspaceFolderId = (): string | undefined => {
    const folder = currentWorkspaceFolder()
    return folder === undefined ? undefined : workspaceFolderId(folder)
  }
  const workspaceFolderIdForSession = (session: Pick<SessionSummary, 'cwd'>): string | undefined => {
    const folders = currentWorkspaceFolders()
    if (folders.length === 0) return undefined
    if (session.cwd !== undefined) {
      const cwdFolder = folders.find((folder) => sameWorkspacePath(folder.uri.fsPath, session.cwd as string))
      if (cwdFolder !== undefined) return workspaceFolderId(cwdFolder)
    }
    return folders.length === 1 && folders[0] !== undefined ? workspaceFolderId(folders[0]) : undefined
  }
  const changePathGuard = new WorkspacePathGuard(vscode.workspace)
  const postChangeFeatureEvent = (change: ChangeSetFile): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    if (connection.backendInstanceId === undefined || connection.connectionGeneration === undefined)
      return Promise.resolve(false)
    featureLocalSequence += 1
    return Promise.resolve(
      post({
        type: 'feature.event',
        name: 'changes.updated',
        identity: {
          backendInstanceId: connection.backendInstanceId,
          connectionGeneration: connection.connectionGeneration,
          stream: 'local',
          sessionId: change.sessionId,
          localSeq: featureLocalSequence,
        },
        change: featureChangeSummary(change),
      }),
    )
  }
  const changeTracker = new ChangeSetTracker({
    resolveSessionWorkspaceFolderId: async (backend, sessionId) =>
      workspaceFolderIdForSession(await backend.sessions.get(sessionId)),
    readObservedHash: async (workspaceId, relativePath) => {
      const resolved = changePathGuard.resolve(workspaceId, relativePath)
      await changePathGuard.assertRegularFile(resolved)
      const fileStat = await vscode.workspace.fs.stat(resolved.uri)
      if (fileStat.size > 16 * 1024 * 1024) return undefined
      const bytes = await vscode.workspace.fs.readFile(resolved.uri)
      return createHash('sha256').update(bytes).digest('hex')
    },
    onChange: (change) => {
      void postChangeFeatureEvent(change)
    },
  })
  const changeUseCases = new ChangeUseCases(changeTracker)
  const checkpointStore = new CheckpointStore({
    rootPath: path.join(context.globalStorageUri.fsPath, 'dsh-checkpoints'),
    storage: createVscodeCheckpointStorage(vscode.workspace),
    workspace: createVscodeCheckpointWorkspace(vscode.workspace),
    enabled: () => vscode.workspace.getConfiguration('dsh.checkpoints').get<boolean>('enabled', false),
    contentEnabled: () =>
      vscode.workspace.getConfiguration('dsh.checkpoints').get<boolean>('storeContent', false),
  })
  const checkpointUseCases = new CheckpointUseCases(checkpointStore)
  const promptTemplateStore = new PromptTemplateStore({
    global: createVscodePromptTemplateStorage(
      path.join(context.globalStorageUri.fsPath, 'dsh-prompt-templates'),
      vscode.workspace,
    ),
    workspace: (workspaceId) => createVscodeWorkspacePromptTemplateStorage(workspaceId, vscode.workspace),
    enabled: () => vscode.workspace.getConfiguration('dsh.promptTemplates').get<boolean>('enabled', true),
    workspaceTrusted: () => vscode.workspace.isTrusted,
  })
  const promptTemplateUseCases = new PromptTemplateUseCases(promptTemplateStore)
  let taskSessionId: string | undefined
  let taskListScope: TaskListScope = 'current-session'
  const postTaskFeatureEvent = (task: TaskSummary): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    if (connection.backendInstanceId === undefined || connection.connectionGeneration === undefined)
      return Promise.resolve(false)
    featureLocalSequence += 1
    return Promise.resolve(
      post({
        type: 'feature.event',
        name: 'tasks.updated',
        identity: {
          backendInstanceId: connection.backendInstanceId,
          connectionGeneration: connection.connectionGeneration,
          stream: 'local',
          ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
          localSeq: featureLocalSequence,
        },
        task: featureTaskSummary(task),
      }),
    )
  }
  const postCheckpointFeatureEvent = (checkpoint: CheckpointSummary): Promise<boolean> => {
    let connection: DshBackend['connection']
    try {
      connection = backendService.requireBackend().connection
    } catch {
      return Promise.resolve(false)
    }
    if (connection.backendInstanceId === undefined || connection.connectionGeneration === undefined)
      return Promise.resolve(false)
    featureLocalSequence += 1
    return Promise.resolve(
      post({
        type: 'feature.event',
        name: 'checkpoint.updated',
        identity: {
          backendInstanceId: connection.backendInstanceId,
          connectionGeneration: connection.connectionGeneration,
          stream: 'local',
          sessionId: checkpoint.sessionId,
          localSeq: featureLocalSequence,
        },
        checkpoint: featureCheckpointSummary(checkpoint),
      }),
    )
  }
  const taskRegistry = new TaskCenterRegistry({
    resolveSessionWorkspaceFolderId: (session) =>
      session.cwd === undefined ? undefined : workspaceFolderIdForSession(session),
    workspaceFolderIds: () => currentWorkspaceFolders().map((folder) => workspaceFolderId(folder)),
    isWorkspaceFolderOpen: (workspaceId) =>
      currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === workspaceId),
    onChange: (sessionId) => {
      if (taskListScope === 'workspace') {
        void taskRegistry
          .listSnapshot({ scope: 'workspace', includeCompleted: true, limit: 200 })
          .then((snapshot) => Promise.all(snapshot.items.map((task) => postTaskFeatureEvent(task))))
          .catch(() => undefined)
        return
      }
      if (taskSessionId !== sessionId) return
      const workspaceId = currentWorkspaceFolderId()
      if (workspaceId === undefined) return
      void taskRegistry
        .listSnapshot({ sessionId, workspaceFolderId: workspaceId, includeCompleted: true, limit: 200 })
        .then((snapshot) => Promise.all(snapshot.items.map((task) => postTaskFeatureEvent(task))))
        .catch(() => undefined)
    },
  })
  const taskUseCases = new TaskUseCases(taskRegistry)
  let eventPostQueue = Promise.resolve()
  const enqueueEvent = (
    resolve: () => Promise<{ readonly name: string; readonly payload: unknown } | undefined>,
  ): Promise<boolean> => {
    const task = eventPostQueue.then(async () => {
      const nextEvent = await resolve()
      if (nextEvent === undefined) return true
      const nextSequence = sequence + 1
      const delivered = await post({
        type: 'event',
        name: nextEvent.name,
        sequence: nextSequence,
        payload: nextEvent.payload,
      })
      if (delivered) sequence = nextSequence
      return delivered
    })
    eventPostQueue = task.then(
      () => undefined,
      () => undefined,
    )
    return task.catch(() => false)
  }
  const postEvent = (name: string, payload: unknown): Promise<boolean> => {
    return enqueueEvent(() => Promise.resolve({ name, payload }))
  }
  const publicBackendEvent = async (backend: DshBackend, event: BackendEvent): Promise<unknown> => {
    if (event.type !== 'deliverables.presented') return sanitizePublicValue(event)
    const session = await backend.sessions.get(event.sessionId).catch(() => undefined)
    const roots = [
      ...currentWorkspaceFolders().map((folder) => folder.uri.fsPath),
      ...(temporaryWorkspaceManager.current?.path === undefined
        ? []
        : [temporaryWorkspaceManager.current.path]),
      ...(temporaryWorkspaceManager.reference?.path === undefined
        ? []
        : [temporaryWorkspaceManager.reference.path]),
    ]
    const uniqueRoots = [...new Set(roots)]
    const files = event.files.flatMap((file) => {
      const relativePath = publicWorkspaceRelativePath(file.path, session?.cwd, uniqueRoots)
      return relativePath === undefined ? [] : [{ ...file, path: relativePath }]
    })
    // Do not publish a card whose paths cannot be mapped into a workspace
    // owned by this Extension Host. The raw source path stays Host-local.
    if (files.length === 0) return undefined
    return sanitizePublicValue({ ...event, files })
  }
  const postBackendEvent = (backend: DshBackend, event: BackendEvent): Promise<boolean> =>
    enqueueEvent(async () => {
      const payload = await publicBackendEvent(backend, event)
      return payload === undefined ? undefined : { name: event.type, payload }
    })
  postRuntimeUpdateProgress = (progress) => {
    void postEvent('runtime.update.progress', progress)
  }
  const publishState = (state: BackendState): void => {
    void updateContextKeys(vscode.commands, state)
    diagnostics.log('info', 'connection-state', { state: state.kind })
    const payload = publicState(state)
    void postEvent('connection.snapshot', payload)
  }
  const attach = (backend: DshBackend): void => {
    invalidateCurrentWorkspaceSessionDetails()
    changeTracker.attach(backend, currentWorkspaceFolderId)
    taskRegistry.attach(backend, currentWorkspaceFolderId)
    backendService.attach(backend, (event) => {
      if (
        event.type === 'workspace.changed' ||
        event.type === 'workspace.removed' ||
        event.type === 'workspace.order.changed' ||
        event.type === 'archived.sessions.changed' ||
        event.type === 'session.added' ||
        event.type === 'session.removed'
      )
        invalidateCurrentWorkspaceSessionDetails()
      if (event.type === 'connection.lost') {
        invalidateCurrentWorkspaceSessionDetails()
        changeTracker.detach()
        taskRegistry.detach()
        editorContextProvider.dispose()
        taskSessionId = undefined
      }
      void postBackendEvent(backend, event)
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
      // Discovery only needs the validated loopback port. Keep the full
      // endpoint in the live Host connection, not in durable workspace state.
      port: result.backend.connection.endpoint.port,
    })
    attach(result.backend)
    // Commands may connect before the Webview exists. app.ready must always
    // receive a fresh authoritative snapshot even when the initial publish
    // had no recipient.
    publishState(result.state)
    return { connected: true }
  }
  let reconnectOperation: Promise<unknown> | undefined
  const reconnect = async (signal?: AbortSignal): Promise<unknown> => {
    if (reconnectOperation !== undefined) return reconnectOperation
    const operation = (async (): Promise<unknown> => {
      changeTracker.detach()
      taskRegistry.detach()
      editorContextProvider.dispose()
      taskSessionId = undefined
      endpointLaunchUrls.clear()
      await coordinator.disconnect()
      return connect(signal)
    })()
    reconnectOperation = operation
    try {
      return await operation
    } finally {
      if (reconnectOperation === operation) reconnectOperation = undefined
    }
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
  const requireCurrentWorkspaceSession = async (
    sessionId: string,
    signal: AbortSignal,
    options: { readonly fresh?: boolean } = {},
  ): Promise<SessionDetail> => {
    if (options.fresh !== true) {
      const cached = currentWorkspaceSessionDetails.get(sessionId)
      if (cached?.generation === currentWorkspaceSessionGeneration) return cached.detail
    }
    const pending = currentWorkspaceSessionLoads.get(sessionId)
    // An explicit session.open owns a fresh stream baseline. Do not let an
    // older advisory ownership read bypass that re-baselining hook.
    if (pending !== undefined && options.fresh !== true) return pending

    const generation = currentWorkspaceSessionGeneration
    const load = (async (): Promise<SessionDetail> => {
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
        const sessions = backendService.requireBackend().sessions
        detail =
          options.fresh === true && sessions.open !== undefined
            ? await sessions.open(sessionId, signal)
            : await sessions.get(sessionId, signal)
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
      if (generation === currentWorkspaceSessionGeneration)
        currentWorkspaceSessionDetails.set(sessionId, { generation, detail })
      return detail
    })()
    currentWorkspaceSessionLoads.set(sessionId, load)
    void load.then(
      () => {
        if (currentWorkspaceSessionLoads.get(sessionId) === load)
          currentWorkspaceSessionLoads.delete(sessionId)
      },
      () => {
        if (currentWorkspaceSessionLoads.get(sessionId) === load)
          currentWorkspaceSessionLoads.delete(sessionId)
      },
    )
    return load
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
  const featureContextOwner = (workspaceFolderIdValue?: string): EditorContextOwner => {
    if (
      workspaceFolderIdValue !== undefined &&
      !currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === workspaceFolderIdValue)
    )
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested editor context workspace is not open in VS Code.',
        retryable: false,
      })
    return {
      ...featureOwner(),
      ...(workspaceFolderIdValue === undefined ? {} : { workspaceFolderId: workspaceFolderIdValue }),
    }
  }
  const currentFeatureSessionBinding = (
    sessionId: string,
  ): {
    readonly sessionId: string
    readonly backendInstanceId: string
    readonly connectionGeneration: number
  } => {
    const connection = backendService.requireBackend().connection
    if (connection.backendInstanceId === undefined || connection.connectionGeneration === undefined)
      throw new AppError({
        code: 'GENERATION_MISMATCH',
        message: 'The DSH connection identity is not ready for editor context resolution.',
        retryable: true,
      })
    return {
      sessionId,
      backendInstanceId: connection.backendInstanceId,
      connectionGeneration: connection.connectionGeneration,
    }
  }
  const contextOwnerForSession = (
    session: SessionDetail,
    requestedWorkspaceFolderId: string | undefined,
    hasContext: boolean,
  ): EditorContextOwner => {
    if (!hasContext) return featureContextOwner()
    const sessionWorkspaceFolderId = workspaceFolderIdForSession(session)
    if (
      requestedWorkspaceFolderId !== undefined &&
      sessionWorkspaceFolderId !== undefined &&
      requestedWorkspaceFolderId !== sessionWorkspaceFolderId
    )
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The editor context belongs to a different workspace folder than this session.',
        retryable: false,
      })
    const resolvedWorkspaceFolderId = requestedWorkspaceFolderId ?? sessionWorkspaceFolderId
    if (resolvedWorkspaceFolderId === undefined)
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The session workspace folder could not be resolved safely.',
        retryable: false,
      })
    if (!currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === resolvedWorkspaceFolderId))
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested editor context workspace is not open in VS Code.',
        retryable: false,
      })
    return featureContextOwner(resolvedWorkspaceFolderId)
  }
  const featureWorkspaceFolderId = (
    requestedWorkspaceFolderId: string | undefined,
    session: SessionDetail | undefined,
  ): string => {
    const sessionWorkspaceFolderId = session === undefined ? undefined : workspaceFolderIdForSession(session)
    if (
      requestedWorkspaceFolderId !== undefined &&
      sessionWorkspaceFolderId !== undefined &&
      requestedWorkspaceFolderId !== sessionWorkspaceFolderId
    )
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested feature workspace does not own this session.',
        retryable: false,
      })
    const resolved = requestedWorkspaceFolderId ?? sessionWorkspaceFolderId ?? currentWorkspaceFolderId()
    if (
      resolved === undefined ||
      !currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === resolved)
    )
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'The requested feature workspace is not open in VS Code.',
        retryable: false,
      })
    return resolved
  }
  const promptTemplateOwner = async (
    sessionId: string,
    requestedWorkspaceFolderId: string,
    signal: AbortSignal,
  ): Promise<{ readonly sessionId: string; readonly workspaceFolderId: string }> => {
    const session = await requireCurrentWorkspaceSession(sessionId, signal)
    return {
      sessionId: session.id,
      workspaceFolderId: featureWorkspaceFolderId(requestedWorkspaceFolderId, session),
    }
  }
  const handleFeatureRequest = async (request: FeatureRequest, signal: AbortSignal): Promise<unknown> => {
    if (request.type === 'editor.context.capture') {
      const owner = featureContextOwner(request.payload.workspaceFolderId)
      const item = await editorContextUseCases.capture(
        {
          kind: request.payload.kind === 'open-document' ? 'file' : request.payload.kind,
          ...(request.payload.workspaceFolderId === undefined
            ? {}
            : { workspaceFolderId: request.payload.workspaceFolderId }),
        },
        owner,
        signal,
      )
      void postFeatureEvent('editor.context.changed', { contextRef: item.ref.contextRef, action: 'added' })
      return {
        kind: 'editor.context',
        items: [featureContextItem(item)],
        availableKinds: featureContextKinds(await editorContextUseCases.availability(owner, signal)),
      }
    }
    if (request.type === 'editor.context.list') {
      const owner = featureContextOwner(request.payload.workspaceFolderId)
      const [items, availability] = await Promise.all([
        editorContextUseCases.list(owner, signal),
        editorContextUseCases.availability(owner, signal),
      ])
      return {
        kind: 'editor.context',
        items: items.map(featureContextItem),
        availableKinds: featureContextKinds(availability),
      }
    }
    if (request.type === 'editor.context.preview') {
      const preview = await editorContextUseCases.preview(
        request.payload.contextRef,
        featureContextOwner(request.payload.workspaceFolderId),
        signal,
      )
      return {
        kind: 'editor.preview',
        contextRef: preview.contextRef,
        redactedPreviewText: redactText(preview.text, 32_768),
        language: 'plaintext',
        truncated: preview.truncated,
        expiresAt: preview.expiresAt,
      }
    }
    if (request.type === 'editor.context.release') {
      const owner = featureContextOwner(request.payload.workspaceFolderId)
      await editorContextUseCases.release(request.payload.contextRefs, owner, signal)
      for (const contextRef of request.payload.contextRefs)
        void postFeatureEvent('editor.context.changed', { contextRef, action: 'released' })
      void postEditorContextAvailabilityEvent()
      return { kind: 'empty' }
    }
    if (request.type === 'navigation.open') {
      await navigationUseCases.openFile(
        request.payload.workspaceFolderId,
        request.payload.relativePath,
        request.payload.range,
        signal,
        request.payload.reveal === 'preserve-focus',
      )
      return { kind: 'operation', operationId: request.requestId, state: 'completed' }
    }
    if (request.type === 'checkpoint.create') {
      const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const workspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
      const changes = await changeUseCases.list(
        { workspaceFolderId: workspaceId, sessionId: session.id, limit: 200 },
        signal,
      )
      const checkpoint = await checkpointUseCases.create(
        {
          sessionId: session.id,
          workspaceFolderId: workspaceId,
          ...(request.payload.label === undefined ? {} : { label: request.payload.label }),
          files: changes,
        },
        signal,
      )
      void postCheckpointFeatureEvent(checkpoint)
      return { kind: 'checkpoints', items: [featureCheckpointSummary(checkpoint)] }
    }
    if (request.type === 'checkpoint.list') {
      const session =
        request.payload.sessionId === undefined
          ? undefined
          : await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const workspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
      const checkpoints = await checkpointUseCases.list(
        { workspaceFolderId: workspaceId, ...(session === undefined ? {} : { sessionId: session.id }) },
        signal,
      )
      return { kind: 'checkpoints', items: checkpoints.map(featureCheckpointSummary) }
    }
    if (request.type === 'checkpoint.preview') {
      const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const workspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
      const checkpoint = await checkpointUseCases.get(request.payload.checkpointId, signal)
      assertCheckpointOwnership(checkpoint, session.id, workspaceId)
      const preview = await checkpointUseCases.preview(request.payload.checkpointId, signal)
      return { kind: 'checkpoint.preview', preview: featureCheckpointPreview(preview) }
    }
    if (request.type === 'checkpoint.delete') {
      const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const checkpoint = await checkpointUseCases.get(request.payload.checkpointId, signal)
      assertCheckpointOwnership(
        checkpoint,
        session.id,
        featureWorkspaceFolderId(request.payload.workspaceFolderId, session),
      )
      await checkpointUseCases.delete(request.payload.checkpointId, signal)
      void postCheckpointFeatureEvent({ ...checkpoint, state: 'deleted', restoreAllowed: false })
      return {
        kind: 'checkpoints',
        items: [{ ...featureCheckpointSummary(checkpoint), state: 'deleted', restoreAllowed: false }],
      }
    }
    if (request.type === 'checkpoint.restore') {
      const session = await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const checkpoint = await checkpointUseCases.get(request.payload.checkpointId, signal)
      assertCheckpointOwnership(
        checkpoint,
        session.id,
        featureWorkspaceFolderId(request.payload.workspaceFolderId, session),
      )
      const restored = await checkpointUseCases.restore(
        request.payload.checkpointId,
        request.payload.expectedCurrentRevision,
        request.payload.conflictPolicy,
        signal,
      )
      void postCheckpointFeatureEvent(restored.summary)
      return {
        kind: 'operation',
        operationId: request.requestId,
        state: restored.state,
        message:
          restored.state === 'partial'
            ? 'Checkpoint restore completed partially; conflicting files were left untouched.'
            : 'Checkpoint restore completed.',
      }
    }
    if (request.type === 'tasks.list') {
      const scope = request.payload.scope ?? 'current-session'
      if (scope === 'workspace') {
        if (request.payload.sessionId !== undefined)
          throw new AppError({
            code: 'INVALID_CONFIGURATION',
            message: 'A workspace task view cannot target one session.',
            retryable: false,
          })
        const requestedWorkspaceFolderId =
          request.payload.workspaceFolderId === undefined
            ? undefined
            : featureWorkspaceFolderId(request.payload.workspaceFolderId, undefined)
        if (requestedWorkspaceFolderId === undefined && currentWorkspaceFolders().length === 0)
          throw new AppError({
            code: 'RESOURCE_NOT_OWNED',
            message: 'Open a workspace folder before viewing workspace tasks.',
            retryable: false,
          })
        taskListScope = 'workspace'
        const snapshot = await taskUseCases.listSnapshot(
          {
            scope,
            ...(requestedWorkspaceFolderId === undefined
              ? {}
              : { workspaceFolderId: requestedWorkspaceFolderId }),
            ...(request.payload.includeCompleted === undefined
              ? {}
              : { includeCompleted: request.payload.includeCompleted }),
            ...(request.payload.cursor === undefined ? {} : { cursor: request.payload.cursor }),
            ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
          },
          signal,
        )
        return featureTaskList(snapshot)
      }
      const sessionId = request.payload.sessionId ?? taskSessionId
      if (sessionId === undefined)
        throw new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'Open a session before viewing tasks.',
          retryable: false,
        })
      const session = await requireCurrentWorkspaceSession(sessionId, signal)
      const currentWorkspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
      taskSessionId = sessionId
      taskListScope = 'current-session'
      taskRegistry.setCurrentSession(sessionId)
      const snapshot = await taskUseCases.listSnapshot(
        {
          workspaceFolderId: currentWorkspaceId,
          sessionId,
          scope,
          ...(request.payload.includeCompleted === undefined
            ? {}
            : { includeCompleted: request.payload.includeCompleted }),
          ...(request.payload.cursor === undefined ? {} : { cursor: request.payload.cursor }),
          ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
        },
        signal,
      )
      return featureTaskList(snapshot)
    }
    if (request.type === 'tasks.open') {
      const task = await taskUseCases.get(request.payload.taskId, signal)
      if (!currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === task.workspaceFolderId))
        throw taskResourceNotOwned()
      if (task.sessionId !== undefined) {
        const session = await requireCurrentWorkspaceSession(task.sessionId, signal)
        featureWorkspaceFolderId(task.workspaceFolderId, session)
      }
      taskSessionId = task.sessionId
      taskRegistry.setCurrentSession(task.sessionId)
      return featureTaskList({
        scope: 'current-session',
        source: 'current-session',
        items: [task],
        complete: true,
        omittedSessions: 0,
      })
    }
    if (request.type === 'tasks.stop') {
      const current = await taskUseCases.get(request.payload.taskId, signal)
      if (
        !currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === current.workspaceFolderId)
      )
        throw taskResourceNotOwned()
      if (current.sessionId !== undefined) {
        const session = await requireCurrentWorkspaceSession(current.sessionId, signal)
        featureWorkspaceFolderId(current.workspaceFolderId, session)
      }
      taskSessionId = current.sessionId
      taskRegistry.setCurrentSession(current.sessionId)
      const task = await taskUseCases.stop(
        request.payload.taskId,
        request.payload.mode,
        request.payload.taskRevision,
        signal,
      )
      return featureTaskList({
        scope: 'current-session',
        source: 'current-session',
        items: [task],
        complete: true,
        omittedSessions: 0,
      })
    }
    if (request.type === 'tasks.answer') {
      const current = await taskUseCases.get(request.payload.taskId, signal)
      if (
        !currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === current.workspaceFolderId)
      )
        throw taskResourceNotOwned()
      if (current.sessionId !== undefined) {
        const session = await requireCurrentWorkspaceSession(current.sessionId, signal)
        featureWorkspaceFolderId(current.workspaceFolderId, session)
      }
      taskSessionId = current.sessionId
      taskRegistry.setCurrentSession(current.sessionId)
      const task = await taskUseCases.answer(
        request.payload.taskId,
        request.payload.interactionId,
        request.payload.answer,
        signal,
      )
      return featureTaskList({
        scope: 'current-session',
        source: 'current-session',
        items: [task],
        complete: true,
        omittedSessions: 0,
      })
    }
    if (request.type === 'prompt.template.list') {
      const owner = await promptTemplateOwner(
        request.payload.sessionId,
        request.payload.workspaceFolderId,
        signal,
      )
      const templates = await promptTemplateUseCases.list(
        { ...owner, ...(request.payload.scope === undefined ? {} : { scope: request.payload.scope }) },
        signal,
      )
      return { kind: 'prompt.templates', items: templates.map(featurePromptTemplateSummary) }
    }
    if (request.type === 'prompt.template.read') {
      const owner = await promptTemplateOwner(
        request.payload.sessionId,
        request.payload.workspaceFolderId,
        signal,
      )
      const template = await promptTemplateUseCases.read(request.payload.templateId, owner, signal)
      return {
        kind: 'prompt.template',
        template: {
          summary: featurePromptTemplateSummary(template),
          templateText: template.templateText,
        },
      }
    }
    if (request.type === 'prompt.template.insert') {
      const owner = await promptTemplateOwner(
        request.payload.sessionId,
        request.payload.workspaceFolderId,
        signal,
      )
      const inserted = await promptTemplateUseCases.insert(
        request.payload.templateId,
        request.payload.variables,
        owner,
        signal,
      )
      return {
        kind: 'prompt.template.inserted',
        templateId: inserted.templateId,
        text: inserted.text,
        unresolvedVariables: inserted.unresolvedVariables,
      }
    }
    if (request.type === 'prompt.template.create') {
      const owner = await promptTemplateOwner(
        request.payload.sessionId,
        request.payload.workspaceFolderId,
        signal,
      )
      const template = await promptTemplateUseCases.create(
        {
          title: request.payload.title,
          description: request.payload.description,
          templateText: request.payload.templateText,
          scope: request.payload.scope,
          variables: request.payload.variables,
        },
        owner,
        signal,
      )
      return { kind: 'prompt.templates', items: [featurePromptTemplateSummary(template)] }
    }
    if (request.type === 'prompt.template.update') {
      const owner = await promptTemplateOwner(
        request.payload.sessionId,
        request.payload.workspaceFolderId,
        signal,
      )
      const template = await promptTemplateUseCases.update(
        request.payload.templateId,
        {
          ...(request.payload.title === undefined ? {} : { title: request.payload.title }),
          ...(request.payload.description === undefined ? {} : { description: request.payload.description }),
          ...(request.payload.templateText === undefined
            ? {}
            : { templateText: request.payload.templateText }),
          ...(request.payload.variables === undefined ? {} : { variables: request.payload.variables }),
        },
        owner,
        signal,
      )
      return { kind: 'prompt.templates', items: [featurePromptTemplateSummary(template)] }
    }
    if (request.type === 'prompt.template.delete') {
      const owner = await promptTemplateOwner(
        request.payload.sessionId,
        request.payload.workspaceFolderId,
        signal,
      )
      await promptTemplateUseCases.delete(request.payload.templateId, owner, signal)
      return {
        kind: 'operation',
        operationId: request.requestId,
        state: 'completed',
        message: 'Prompt template deleted.',
      }
    }
    if (request.type === 'changes.list') {
      const session =
        request.payload.sessionId === undefined
          ? undefined
          : await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      const currentWorkspaceId = featureWorkspaceFolderId(request.payload.workspaceFolderId, session)
      const changes = await changeUseCases.list(
        {
          workspaceFolderId: currentWorkspaceId,
          ...(request.payload.sessionId === undefined ? {} : { sessionId: request.payload.sessionId }),
          ...(request.payload.status === undefined
            ? {}
            : { status: fromFeatureChangeStatus(request.payload.status) }),
          ...(request.payload.cursor === undefined ? {} : { cursor: request.payload.cursor }),
          ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
        },
        signal,
      )
      return { kind: 'changes', items: changes.map(featureChangeSummary) }
    }
    if (request.type === 'changes.detail') {
      const detail = await changeUseCases.get(request.payload.changeId, signal)
      if (!currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === detail.workspaceFolderId))
        throw new AppError({
          code: 'RESOURCE_NOT_OWNED',
          message: 'The requested change is not owned by this workspace.',
          retryable: false,
        })
      const session = await requireCurrentWorkspaceSession(detail.sessionId, signal)
      featureWorkspaceFolderId(detail.workspaceFolderId, session)
      return {
        kind: 'change.detail',
        change: featureChangeSummary(detail),
        ...(detail.redactedDiff === undefined
          ? {}
          : { redactedDiff: redactText(detail.redactedDiff, 262_144) }),
        truncated: detail.diffTruncated,
      }
    }
    if (request.type === 'changes.markReviewed') {
      const current = await changeUseCases.get(request.payload.changeId, signal)
      if (
        !currentWorkspaceFolders().some((folder) => workspaceFolderId(folder) === current.workspaceFolderId)
      )
        throw new AppError({
          code: 'RESOURCE_NOT_OWNED',
          message: 'The requested change is not owned by this workspace.',
          retryable: false,
        })
      const session = await requireCurrentWorkspaceSession(current.sessionId, signal)
      featureWorkspaceFolderId(current.workspaceFolderId, session)
      const change = await changeUseCases.markReviewed(
        request.payload.changeId,
        fromFeatureReviewState(request.payload.reviewState),
        signal,
      )
      return { kind: 'changes', items: [featureChangeSummary(change)] }
    }
    throw new AppError({
      code: 'FEATURE_DISABLED',
      message: `The staged feature route ${request.type} is not enabled yet.`,
      retryable: false,
    })
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
    if (request.type === 'view.moveRightGuide')
      return moveOrExplainSecondarySidebar(vscode.commands, vscode.window)
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
        publicWorkspaceSummary(
          await workspaceUseCases.create({ name: request.payload.name, path: uri.fsPath }, signal),
        ),
      )
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
      return publicValue(
        await requireCurrentWorkspaceSession(request.payload.sessionId, signal, { fresh: true }),
      )
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
    if (request.type === 'session.enqueuePrompt') {
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
      const queued = await sessionUseCases.enqueuePrompt(
        {
          sessionId: request.payload.sessionId,
          text: request.payload.text,
          attachments: [...attachments, ...resolvedContext.map((entry) => entry.attachment)],
        },
        request.payload.mode,
        signal,
      )
      attachmentTokens.release(request.payload.attachments)
      if (contextRefs.length > 0) await editorContextUseCases.release(contextRefs, contextOwner)
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
          message:
            'This DSH integration supports images and text-based files; this binary file is not supported.',
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
        attachment: attachmentTokens.remember({
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
    if (request.type === 'extensionSettings.read')
      return publicValue(publicExtensionSettings(configuration.read(), extensionVersion))
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
          .goals.create(
            request.payload.sessionId,
            request.payload.title,
            signal,
            request.payload.maxGoalRounds,
          ),
      )
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
    if (request.type === 'subagent.list') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(await advancedUseCases.listSubagents(request.payload.sessionId, signal))
    }
    if (request.type === 'subagent.history') {
      await requireCurrentWorkspaceSession(request.payload.sessionId, signal)
      return publicValue(
        await advancedUseCases.listSubagentHistory(
          request.payload.sessionId,
          request.payload.beforeSeq === undefined ? undefined : { beforeSequence: request.payload.beforeSeq },
          signal,
        ),
      )
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
      editorContextProvider.dispose()
    },
    onMessageError: (error) => {
      diagnostics.log('error', 'webview-message-unhandled', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    },
  })
  const captureEditorContextFromCommand = async (kind: EditorContextKind): Promise<void> => {
    try {
      const item = await editorContextUseCases.capture({ kind }, featureContextOwner())
      await postFeatureEvent('editor.context.changed', {
        contextRef: item.ref.contextRef,
        action: 'added',
      }).catch(() => false)
      await postEditorContextAvailabilityEvent()
      await provider.reveal(true)
    } catch (error) {
      const detail =
        error instanceof AppError
          ? error.message
          : 'An unexpected error occurred. Open DSH diagnostics for the redacted failure details.'
      void vscode.window.showErrorMessage(`Unable to add ${kind} editor context: ${detail}`)
    }
  }
  const stateSubscription = coordinator.subscribe(publishState)
  const subscriptions: vscode.Disposable[] = [
    stateSubscriptionDisposable(stateSubscription),
    provider,
    diagnostics,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateCurrentWorkspaceSessionDetails()
      editorContextProvider.dispose()
      void postEvent('workspace.changed', {})
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void postEditorContextAvailabilityEvent()
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      void postEditorContextAvailabilityEvent()
    }),
    vscode.languages.onDidChangeDiagnostics(() => {
      void postEditorContextAvailabilityEvent()
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
            const target =
              endpointLaunchUrls.get(state.backend.endpoint.baseUrl) ?? state.backend.endpoint.baseUrl
            const opened = await vscode.env.openExternal(vscode.Uri.parse(target))
            if (!opened)
              void vscode.window.showWarningMessage('Unable to open the DSH Web UI in your browser.')
          },
          'dsh.installRuntime': () => runtimeInstaller.install(),
          'dsh.selectExecutable': () => runtimeInstaller.selectExecutable(),
          'dsh.copyInstallCommand': () => runtimeInstaller.copyInstallCommand(),
          'dsh.openDocumentation': () => vscode.env.openExternal(vscode.Uri.parse(DSH_DOCUMENTATION_URL)),
          'dsh.openInSecondarySidebar': () => moveOrExplainSecondarySidebar(vscode.commands, vscode.window),
          'dsh.showDiagnostics': () => diagnostics.show(),
          'dsh.addSelectionContext': () => captureEditorContextFromCommand('selection'),
          'dsh.addFileContext': () => captureEditorContextFromCommand('file'),
          'dsh.addSymbolContext': () => captureEditorContextFromCommand('symbol'),
          'dsh.addDiagnosticContext': () => captureEditorContextFromCommand('diagnostic'),
        },
      })
      void postEditorContextAvailabilityEvent()
      context.subscriptions.push(...subscriptions)
      context.subscriptions.push(
        configuration.onDidChange((affectsConfiguration) => {
          // A new executable path only takes effect on the next locate; the
          // memoized result would otherwise keep the previous one alive.
          if (affectsConfiguration('dsh.runtime.executablePath')) runtimeLocator.invalidate()
          if (!TRANSPORT_CONFIGURATION_KEYS.some((key) => affectsConfiguration(key))) return
          const stateKind = coordinator.getState().kind
          if (
            stateKind !== 'connected' &&
            stateKind !== 'connecting' &&
            stateKind !== 'discovering' &&
            stateKind !== 'locating-runtime' &&
            stateKind !== 'starting'
          )
            return
          // Disconnect invalidates the coordinator generation and aborts an
          // in-flight attach. The shared reconnect operation coalesces this
          // automatic path with an explicit connection.configure reconnect.
          void reconnect().catch(() => {
            publishState({ kind: 'failed', message: 'DSH configuration reload failed.', retryable: true })
          })
        }),
      )
      // Warm the connection while VS Code is still settling after startup:
      // discovery plus a managed start takes seconds, and the panel's
      // app.ready then returns through the coordinator's cached-backend fast
      // path instead of paying that chain while the user waits. The
      // coordinator only spawns a process after discovery finished empty, and
      // a concurrent app.ready request shares this same in-flight operation.
      // A failed warm-up stays silent; the next app.ready retries the full
      // chain exactly as it does today.
      const connectionWarmup = connect().catch(() => undefined)
      // The update check spawns npm subprocesses whose CPU cost stretches the
      // startup window; chain it after the warm-up instead of racing it.
      void connectionWarmup
        .then(() => runtimeUpdater.checkForUpdates(false, runtimeUpdateLifecycle.signal))
        .catch(() => undefined)
      return Promise.resolve()
    },
    dispose: async () => {
      runtimeUpdateLifecycle.abort()
      router.cancelAll()
      stateSubscription()
      provider.dispose()
      changeTracker.dispose()
      taskRegistry.dispose()
      await backendService.detach()
      await coordinator.disconnect()
      endpointLaunchUrls.clear()
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
  const entries = extensionRuntimePathEntries(platform(), environment)
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
    pathEntries: extensionRuntimePathEntries(os, environment),
    processExecutable: process.execPath,
  }
}

function extensionRuntimePathEntries(
  os: 'windows' | 'linux' | 'macos',
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  return runtimePathEntries(os, environment, os === 'windows' ? homedir() : undefined)
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
    !isAbsoluteFilePath(workspacePath)
  )
    return undefined
  return { id, path: workspacePath }
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
  childEnvironment.PATH = [prefix, ...extensionRuntimePathEntries(platform(), childEnvironment)]
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
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    // A launch that never produced a process (missing executable, EACCES)
    // reports `error` and never `exit`. Resolve the exit contract so callers
    // stop waiting for a process that does not exist, and so the reason is not
    // raised as an unhandled event in the Extension Host.
    child.once('error', () => resolve({ code: -1, signal: null }))
  })
  return {
    pid: child.pid ?? -1,
    stdout: textStream(child.stdout),
    stderr: textStream(child.stderr),
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal)
    },
    exited,
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
          ...(state.backend.capabilities.subagentImagePrompts === true ? { subagentImagePrompts: true } : {}),
          ...(state.backend.backendInstanceId === undefined
            ? {}
            : { backendInstanceId: state.backend.backendInstanceId }),
          ...(state.backend.connectionGeneration === undefined
            ? {}
            : { connectionGeneration: state.backend.connectionGeneration }),
          featureProfile: publicFeatureProfile(state.backend.capabilities.featureProfile),
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

function publicDiagnosticsSnapshot(
  state: BackendState,
  extensionVersion: string,
  recentEvents: readonly string[],
  connectionMode: ExtensionSettings['connection']['mode'],
): DiagnosticsSnapshot {
  const dshVersion = state.kind === 'connected' ? state.backend.capabilities.dshVersion : undefined
  const endpointKind =
    state.kind === 'connected'
      ? state.backend.ownership
      : connectionMode === 'custom'
        ? 'configured'
        : undefined
  const canReconnect =
    state.kind === 'connected' ||
    state.kind === 'runtime-missing' ||
    state.kind === 'port-conflict' ||
    (state.kind === 'failed' && state.retryable)
  return {
    extensionVersion,
    ...(dshVersion === undefined ? {} : { dshVersion }),
    state: state.kind,
    ...(endpointKind === undefined ? {} : { endpointKind }),
    canReconnect,
    recentEvents: recentEvents.slice(-32),
  }
}

function publicFeatureProfile(profile: FeatureCapabilityProfile | undefined): unknown {
  if (profile === undefined) return undefined
  const capabilities: Record<string, unknown> = {}
  for (const id of FEATURE_CAPABILITY_IDS) {
    const capability = profile.capabilities[id]
    if (capability === undefined) continue
    capabilities[id] = {
      state: capability.state,
      upstream: capability.upstream,
      ...(capability.reason === undefined ? {} : { reason: redactText(capability.reason, 512) }),
    }
  }
  return {
    dshVersion: profile.dshVersion,
    protocolVersion: profile.protocolVersion,
    source: profile.source,
    capabilities,
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

function safeStateMessage(message: string): string {
  const redacted = redactText(message, 320)
  return redacted === '' ? 'The DSH connection operation failed.' : redacted
}

function publicList(value: readonly unknown[]): readonly unknown[] {
  return value.map(publicValue)
}

/** Project the domain ref into the flattened, schema-checked safe DTO. */
function featureContextItem(item: EditorContextItem): unknown {
  const ref = item.ref
  return {
    contextRef: ref.contextRef,
    kind: ref.kind === 'file' ? 'open-document' : ref.kind,
    label: item.label,
    workspaceFolderId: ref.workspaceFolderId,
    relativePath: ref.relativePath,
    ...(ref.range === undefined ? {} : { range: ref.range }),
    sizeBytes: ref.sizeBytes,
    ...(ref.documentVersion === undefined ? {} : { documentVersion: ref.documentVersion }),
    stale: item.stale,
    previewAvailable: item.previewAvailable,
    expiresAt: ref.expiresAt,
    scope: {
      ownerId: ref.ownerId,
      workspaceFolderId: ref.workspaceFolderId,
      ownerViewId: ref.ownerViewId,
      ...(ref.sessionId === undefined ? {} : { sessionId: ref.sessionId }),
      ...(ref.backendInstanceId === undefined ? {} : { backendInstanceId: ref.backendInstanceId }),
      ...(ref.connectionGeneration === undefined ? {} : { connectionGeneration: ref.connectionGeneration }),
      expiresAt: ref.expiresAt,
    },
  }
}

function featureContextKinds(availability: EditorContextAvailability): FeatureContextKind[] {
  return availability.availableKinds.map((kind) => (kind === 'file' ? 'open-document' : kind))
}

function featureChangeSummary(
  change: ChangeSetFile,
): Extract<FeatureHostEvent, { readonly name: 'changes.updated' }>['change'] {
  return {
    changeId: change.changeId,
    sessionId: change.sessionId,
    workspaceFolderId: change.workspaceFolderId,
    relativePath: change.relativePath,
    ...(change.previousRelativePath === undefined
      ? {}
      : { previousRelativePath: change.previousRelativePath }),
    status: change.status,
    ...(change.additions === undefined ? {} : { additions: change.additions }),
    ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
    evidence: featureChangeEvidence(change.evidence),
    applicationState: featureChangeApplicationState(change.applicationState),
    reviewState: change.reviewState,
    sourceIds: [...change.sourceIds],
    locations: change.locations.map((location) => ({
      relativePath: location.path,
      ...(location.line === undefined ? {} : { line: location.line }),
    })),
    firstSeenAt: change.firstSeenAt,
    lastSeenAt: change.lastSeenAt,
    identity: change.identity,
    diffAvailable: change.diffAvailable,
  }
}

function featureCheckpointSummary(
  checkpoint: CheckpointSummary,
): Extract<FeatureHostEvent, { readonly name: 'checkpoint.updated' }>['checkpoint'] {
  return {
    checkpointId: checkpoint.checkpointId,
    sessionId: checkpoint.sessionId,
    workspaceFolderId: checkpoint.workspaceFolderId,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.label === undefined ? {} : { label: checkpoint.label }),
    fileCount: checkpoint.fileCount,
    totalBytes: checkpoint.totalBytes,
    state: checkpoint.state,
    restoreAllowed: checkpoint.restoreAllowed,
    contentEnabled: checkpoint.contentEnabled,
    ...(checkpoint.expectedRevision === undefined ? {} : { expectedRevision: checkpoint.expectedRevision }),
  }
}

function featureCheckpointPreview(
  preview: CheckpointPreview,
): Extract<FeatureResponsePayload, { readonly kind: 'checkpoint.preview' }>['preview'] {
  return {
    summary: featureCheckpointSummary(preview.summary),
    files: preview.files.map((file) => ({
      relativePath: file.relativePath,
      presentAtCheckpoint: file.presentAtCheckpoint,
      ...(file.expectedCurrentHash === undefined ? {} : { expectedCurrentHash: file.expectedCurrentHash }),
      ...(file.currentHash === undefined ? {} : { currentHash: file.currentHash }),
      conflict: file.conflict,
      byteSize: file.byteSize,
    })),
    conflictCount: preview.conflictCount,
  }
}

function featurePromptTemplateSummary(
  template: PromptTemplateSummary,
): Extract<FeatureResponsePayload, { readonly kind: 'prompt.templates' }>['items'][number] {
  return {
    templateId: template.templateId,
    title: template.title,
    description: template.description,
    scope: template.scope,
    updatedAt: template.updatedAt,
    variables: [...template.variables],
    enabled: template.enabled,
  }
}

function assertCheckpointOwnership(
  checkpoint: Pick<CheckpointSummary, 'sessionId' | 'workspaceFolderId'>,
  sessionId: string,
  workspaceFolderId: string,
): void {
  if (checkpoint.sessionId === sessionId && checkpoint.workspaceFolderId === workspaceFolderId) return
  throw new AppError({
    code: 'RESOURCE_NOT_OWNED',
    message: 'The requested checkpoint is not owned by the current session and workspace.',
    retryable: false,
  })
}

function featureTaskSummary(
  task: TaskSummary,
): Extract<FeatureHostEvent, { readonly name: 'tasks.updated' }>['task'] {
  return {
    taskId: task.taskId,
    sourceId: task.sourceId,
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
    ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
    workspaceFolderId: task.workspaceFolderId,
    kind: task.kind === 'goal' || task.kind === 'interaction' ? task.kind : task.kind,
    title: task.title,
    ...(task.sessionTitle === undefined ? {} : { sessionTitle: task.sessionTitle }),
    status: task.status,
    needsUserAction: task.needsUserAction,
    ...(task.actionKind === undefined ? {} : { actionKind: task.actionKind }),
    ...(task.interactionId === undefined ? {} : { interactionId: task.interactionId }),
    ...(task.modelLabel === undefined ? {} : { modelLabel: task.modelLabel }),
    ...(task.providerLabel === undefined ? {} : { providerLabel: task.providerLabel }),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    ...(task.progress === undefined ? {} : { progress: task.progress }),
    childCount: task.childCount,
    canOpen: task.canOpen,
    canAnswer: task.canAnswer,
    canSessionCancel: task.canSessionCancel,
    canProcessStop: task.canProcessStop,
    ownerKind: task.ownerKind,
    ...(task.backendInstanceId === undefined ? {} : { backendInstanceId: task.backendInstanceId }),
    ...(task.connectionGeneration === undefined ? {} : { connectionGeneration: task.connectionGeneration }),
    taskRevision: task.taskRevision,
  }
}

function featureTaskList(
  snapshot: TaskListSnapshot,
): Extract<FeatureResponsePayload, { readonly kind: 'tasks' }> {
  return {
    kind: 'tasks',
    items: snapshot.items.map(featureTaskSummary),
    scope: snapshot.scope,
    source: snapshot.source,
    complete: snapshot.complete,
    omittedSessions: snapshot.omittedSessions,
  }
}

function taskResourceNotOwned(): AppError {
  return new AppError({
    code: 'TASK_NOT_OWNED',
    message: 'The requested task does not belong to the current workspace.',
    retryable: false,
  })
}

function featureChangeEvidence(
  evidence: ChangeSetFile['evidence'],
): Extract<FeatureHostEvent, { readonly name: 'changes.updated' }>['change']['evidence'] {
  switch (evidence) {
    case 'structuredProposal':
      return 'structured-proposal'
    case 'structuredToolSuccess':
      return 'structured-tool-success'
    case 'filesystemObserved':
      return 'filesystem-observed'
    case 'structuredLocationOnly':
      return 'structured-location-only'
    case 'failed':
      return 'failed'
    case 'incomplete':
      return 'incomplete'
  }
}

function featureChangeApplicationState(
  state: ChangeSetFile['applicationState'],
): Extract<FeatureHostEvent, { readonly name: 'changes.updated' }>['change']['applicationState'] {
  switch (state) {
    case 'proposed':
      return 'proposed'
    case 'appliedObserved':
      return 'applied-observed'
    case 'failed':
      return 'failed'
    case 'unknown':
      return 'unknown'
  }
}

function fromFeatureChangeStatus(
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown',
): ChangeSetFile['status'] {
  return status
}

function fromFeatureReviewState(
  state: 'viewed' | 'accepted' | 'rejected' | 'needs-attention',
): ChangeSetFile['reviewState'] {
  return state
}

function publicValue(value: unknown): unknown {
  return sanitizePublicValue(value)
}

function publicExtensionSettings(
  settings: ExtensionSettings,
  extensionVersion: string,
): ExtensionSettingsSummary {
  return {
    extensionVersion,
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

function readExtensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as unknown as { readonly version?: unknown }
  const version = packageJson.version
  return typeof version === 'string' && version.trim() !== '' ? version : 'unknown'
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
    case 'models.discover.custom':
    case 'provider.secret.configure':
    case 'provider.secret.remove':
    case 'provider.custom.create':
    case 'plugin.credential.configure':
    case 'plugin.credential.remove':
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
