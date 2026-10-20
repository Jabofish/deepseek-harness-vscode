import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import {
  AppError,
  type BackendEndpoint,
  type BackendState,
  type DshBackend,
  type DshRuntimeUpdateProgress,
  isLoopbackEndpoint,
  parseServerOrigin,
} from '@dsh-vscode/domain'
import {
  BackendService,
  DshConnectionCoordinator,
  RuntimeUseCases,
  type ConnectionRequest,
} from '@dsh-vscode/application'
import { VersionedBackendFactory, VersionedBackendProbe } from '@dsh-vscode/dsh-adapter'
import { createAdapterOptions } from '../backend/adapter-options.js'
import { createVersionAdapters } from '../backend/version-adapters.js'
import { CompanionRegistryDiscoveryProvider } from '../backend/discovery/companion-provider.js'
import { ConfiguredPortDiscoveryProvider } from '../backend/discovery/configured-provider.js'
import { DefaultPortDiscoveryProvider } from '../backend/discovery/default-port-provider.js'
import { CompositeInstanceDiscovery } from '../backend/discovery/instance-discovery.js'
import { KnownInstanceDiscoveryProvider } from '../backend/discovery/known-instance-provider.js'
import { LinuxProcessDiscoveryProvider } from '../backend/discovery/linux-process-provider.js'
import { MacOsProcessDiscoveryProvider } from '../backend/discovery/macos-process-provider.js'
import { WindowsProcessDiscoveryProvider } from '../backend/discovery/windows-process-provider.js'
import { DshProcessSupervisor } from '../backend/process-supervisor.js'
import type { RedactedDiagnostics } from '../backend/diagnostics.js'
import { DshRuntimeLocator, readStoredRuntimePath } from '../backend/runtime-locator.js'
import { resolveNpmExecutable } from '../backend/runtime-paths.js'
import { resolveWindowsShim } from '../backend/windows-shim.js'
import type { VsCodeConfigurationSource } from '../config/configuration-source.js'
import { normalizeServerUrl } from '../config/configuration-source.js'
import { DSH_PACKAGE } from '../constants.js'
import { RuntimeInstaller } from '../vscode/install-runtime.js'
import {
  DshRuntimeUpdater,
  type ExecuteRuntimeCommand,
  type RuntimeCommandResult,
} from '../vscode/update-runtime.js'
import { RUNTIME_INSTALL_MAX_BUFFER, RUNTIME_INSTALL_TIMEOUT_MS } from '../vscode/runtime-installation.js'
import {
  endpointFromServerUrl,
  extensionRuntimePathEntries,
  platform,
  readTextFile,
  runtimeEnvironment,
  spawnManagedChild,
  windowsShimOptions,
} from './runtime.js'
import { createExportFileSystem } from './export-file-system.js'
import { sameWorkspacePath } from './workspace-state.js'
import { EndpointNetwork } from '../backend/endpoint-network.js'
import { ExternalConnectionAccess } from '../backend/external-connection-access.js'
import { createCredentialScope } from '../backend/credential-scope.js'
import { hasLocalWorkspaceAuthority } from '../view/session-workspace-scope.js'

const execFileAsync = promisify(execFile)
const RUNTIME_PATH_STATE_KEY = 'dsh.runtime.lastKnownPath'

/** F5 explicitly requests a fresh owned runtime instead of discovering a stale companion. */
function usesDevelopmentRuntime(context: Pick<vscode.ExtensionContext, 'extensionMode'>): boolean {
  return (
    process.env.DSH_VSCODE_DEV_MANAGED_RUNTIME === '1' &&
    context.extensionMode === vscode.ExtensionMode.Development
  )
}
export interface RuntimeAssemblyDependencies {
  readonly context: vscode.ExtensionContext
  readonly configuration: VsCodeConfigurationSource
  readonly diagnostics: RedactedDiagnostics
  readonly currentWorkspaceFolder: () => vscode.WorkspaceFolder | undefined
  /** Late-bound publisher; the Webview event pipeline replaces it once built. */
  readonly onRuntimeUpdateProgress: (progress: DshRuntimeUpdateProgress) => void
}

export interface RuntimeAssembly {
  readonly runtimeLocator: DshRuntimeLocator
  readonly coordinator: DshConnectionCoordinator
  readonly backendService: BackendService
  readonly supervisor: DshProcessSupervisor
  readonly runtimeInstaller: RuntimeInstaller
  readonly runtimeUseCases: RuntimeUseCases
  readonly endpointLaunchUrls: Map<string, string>
  readonly externalConnection: ExternalConnectionAccess
}

/** Locate the runtime, discover endpoints, and own the connection machinery. */
export function createRuntimeAssembly(deps: RuntimeAssemblyDependencies): RuntimeAssembly {
  const { context, configuration, diagnostics, currentWorkspaceFolder, onRuntimeUpdateProgress } = deps
  const runtimeLocator = new DshRuntimeLocator({
    os: platform(),
    configuredPath: () => configuration.read().runtime.executablePath,
    pathEntries: () => extensionRuntimePathEntries(platform(), process.env),
    lastKnownRuntimePath: () =>
      readStoredRuntimePath(context.globalState.get<unknown>(RUNTIME_PATH_STATE_KEY)),
    rememberRuntimePath: (hint) => {
      void context.globalState.update(RUNTIME_PATH_STATE_KEY, hint)
    },
    logProbeFailure: (failure) =>
      diagnostics.log('warn', 'runtime-probe-failed', {
        name: failure.name,
        status: 'unusable',
        message: failure.message,
      }),
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
      () => {
        const connection = configuration.read().connection
        return connection.attachPortsConfigured === true ? connection.attachPorts : []
      },
      () => configuration.read().connection.serverUrl,
    ),
    new KnownInstanceDiscoveryProvider(context.workspaceState),
    new DefaultPortDiscoveryProvider(),
    new CompanionRegistryDiscoveryProvider(),
    new WindowsProcessDiscoveryProvider(),
    new LinuxProcessDiscoveryProvider(),
    new MacOsProcessDiscoveryProvider(),
  ])
  const endpointCookies = new Map<string, string>()
  const network = new EndpointNetwork()
  const externalConnection = new ExternalConnectionAccess({
    secrets: context.secrets,
    credentialScope: createCredentialScope(context.globalStorageUri.fsPath),
    network,
    isTrusted: () => vscode.workspace.isTrusted,
    requestTimeoutMs: () => configuration.read().connection.requestTimeoutMs,
    confirm: async (endpoint, insecure) => {
      const action = insecure ? 'Connect using unencrypted HTTP' : 'Authorize connection'
      const message = insecure
        ? `Connect to ${endpoint.baseUrl}? HTTP sends credentials and messages without encryption. Use HTTPS on untrusted networks.`
        : `Authorize DSH at ${endpoint.baseUrl}? This instance will receive the tasks and files you choose to send.`
      return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action
    },
    inputToken: () =>
      Promise.resolve(
        vscode.window.showInputBox({
          title: 'DSH external connection credentials',
          prompt:
            'Enter the DSH launch token. Leave empty for an instance that does not require token login.',
          password: true,
          ignoreFocusOut: true,
        }),
      ),
  })
  // Keep the process launch URL in the Extension Host so the browser can
  // perform its own cookie exchange. The URL is never included in Webview
  // state or messages.
  const endpointLaunchUrls = new Map<string, string>()
  // One shared object for every adapter: spreading it would evaluate the
  // getters here, and building the composition root must never read settings.
  const adapterOptions = createAdapterOptions({
    requestTimeoutMs: () => configuration.read().connection.requestTimeoutMs,
    fetch: network.fetch,
    webSocket: network.webSocketConstructor(),
    samePath: sameWorkspacePath,
    exportFileSystem: createExportFileSystem(vscode),
    authCookie: (endpoint) =>
      externalConnection.cookie(endpoint) ??
      (endpointLaunchUrls.has(endpoint.baseUrl) ? endpointCookies.get(endpoint.baseUrl) : undefined),
    allowLocalInspector: (endpoint) => {
      const state = coordinator.getState()
      return (
        state.kind === 'connected' &&
        state.backend.endpoint.baseUrl === endpoint.baseUrl &&
        hasLocalWorkspaceAuthority(state.backend)
      )
    },
    // The assistant preview is an opt-in transient channel; the Host records
    // when it had to re-open the follow stream and when it stopped trying, so a
    // degraded "whole reply at settlement" render is diagnosable.
    onAssistantPreview: (state) =>
      diagnostics.log(state.status === 'disabled' ? 'warn' : 'info', 'assistant-preview', {
        status: state.status,
        phase: state.phase,
      }),
  })
  const rememberReadyEndpoint = createManagedEndpointLoginHandler(
    endpointCookies,
    endpointLaunchUrls,
    network.fetch,
  )
  const adapters = createVersionAdapters(adapterOptions)
  const probe = new VersionedBackendProbe(adapters, { fetch: network.fetch })
  const factory = new VersionedBackendFactory(adapters)
  const supervisor = new DshProcessSupervisor({
    managedPort: () => (usesDevelopmentRuntime(context) ? 0 : configuration.read().connection.managedPort),
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
    endpointPreparation: externalConnection,
    onProgress: (progress) => diagnostics.connectionProgress(progress),
  })
  const backendService = new BackendService()
  let runtimeInstall: { readonly key: string; readonly operation: Promise<RuntimeCommandResult> } | undefined
  const executeRuntimeCommand: ExecuteRuntimeCommand = (executable, args, options) => {
    const installing = args[0] === 'install'
    const key = [executable, ...args].join('\0')
    if (installing && runtimeInstall !== undefined) {
      if (runtimeInstall.key === key) return runtimeInstall.operation
      return Promise.reject(
        new AppError({
          code: 'BACKEND_BUSY',
          message: 'A DSH installation is already running. Wait for it to finish before changing versions.',
          retryable: true,
          context: { operation: 'runtime.install', reason: 'install-in-progress' },
        }),
      )
    }
    if (options.signal?.aborted === true)
      return Promise.reject(
        new AppError({
          code: 'REQUEST_CANCELLED',
          message: 'The DSH installation was cancelled.',
          retryable: true,
        }),
      )
    const run = async (): Promise<RuntimeCommandResult> => {
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
        // Closing a chat must not interrupt npm while it is replacing shared files.
        ...(!installing && options.signal !== undefined ? { signal: options.signal } : {}),
      })
      return { stdout: result.stdout, stderr: result.stderr }
    }
    const operation = run()
    if (installing) {
      runtimeInstall = { key, operation }
      const release = (): void => {
        if (runtimeInstall?.operation === operation) runtimeInstall = undefined
      }
      void operation.then(release, release)
    }
    return operation
  }
  const runtimeInstaller = new RuntimeInstaller({
    tasks: vscode.tasks,
    window: vscode.window,
    env: vscode.env,
    Uri: vscode.Uri,
    workspace: vscode.workspace,
    runInstall: async () => {
      const os = platform()
      const npm = resolveNpmExecutable(os, extensionRuntimePathEntries(os, process.env))
      await executeRuntimeCommand(npm, ['install', '--global', DSH_PACKAGE], {
        timeout: RUNTIME_INSTALL_TIMEOUT_MS,
        maxBuffer: RUNTIME_INSTALL_MAX_BUFFER,
      })
    },
    verifyInstall: async () => {
      runtimeLocator.invalidate()
      return (await runtimeLocator.locate()).runtime?.supported === true
    },
    verifyExecutable: async (executable) => (await runtimeLocator.inspectExecutable(executable)).supported,
  })
  const runtimeUpdater = new DshRuntimeUpdater({
    npmExecutable: () => {
      const os = platform()
      return resolveNpmExecutable(os, extensionRuntimePathEntries(os, process.env))
    },
    locateRuntime: async (signal) => (await runtimeLocator.locate(signal)).runtime,
    onProgress: (progress) => onRuntimeUpdateProgress(progress),
    execute: executeRuntimeCommand,
    environment: () => runtimeEnvironment(),
  })
  const runtimeUseCases = new RuntimeUseCases({
    install: () => runtimeInstaller.install(),
    selectExecutable: () => runtimeInstaller.selectExecutable(),
    copyInstallCommand: () => Promise.resolve(runtimeInstaller.copyInstallCommand()),
    openDocumentation: () => Promise.resolve(runtimeInstaller.openDocumentation()).then(() => undefined),
    checkForUpdates: (force, signal) => runtimeUpdater.checkForUpdates(force, signal),
    installVersion: (version, signal) => runtimeUpdater.installVersion(version, signal),
  })
  return {
    runtimeLocator,
    coordinator,
    backendService,
    supervisor,
    runtimeInstaller,
    runtimeUseCases,
    endpointLaunchUrls,
    externalConnection,
  }
}

export interface ConnectionLifecycleDependencies {
  readonly context: vscode.ExtensionContext
  readonly configuration: VsCodeConfigurationSource
  readonly coordinator: DshConnectionCoordinator
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
  readonly endpointLaunchUrls: Map<string, string>
  readonly externalConnection?: ExternalConnectionAccess
  readonly attach: (backend: DshBackend) => Promise<void>
  readonly publishState: (state: BackendState) => void
  readonly disposeAccountLifecycleHost: () => Promise<void>
  readonly detachSessionAdapters: () => void
}

export interface ConnectionLifecycle {
  readonly connect: (signal?: AbortSignal) => Promise<unknown>
  readonly reconnect: (signal?: AbortSignal) => Promise<unknown>
  /**
   * The transport-change listener's entry point. Distinct from `reconnect` so
   * `configureConnection` can suppress the per-write reconnects its own
   * settings updates trigger, and run exactly one reconnect that reads the
   * fully committed configuration.
   */
  readonly reconnectOnTransportChange: (signal?: AbortSignal) => Promise<unknown>
  readonly configureConnection: (
    mode: 'auto' | 'custom',
    endpoint: string | undefined,
    signal?: AbortSignal,
  ) => Promise<unknown>
}

/** The connect/reconnect/configure entry points shared by routes and commands. */
export function createConnectionLifecycle(deps: ConnectionLifecycleDependencies): ConnectionLifecycle {
  const {
    context,
    configuration,
    coordinator,
    currentWorkspaceFolders,
    endpointLaunchUrls,
    externalConnection,
    attach,
    publishState,
    disposeAccountLifecycleHost,
    detachSessionAdapters,
  } = deps
  const connect = async (signal?: AbortSignal): Promise<unknown> => {
    const current = configuration.read()
    const development = usesDevelopmentRuntime(context)
    const mode = development ? 'new-isolated' : current.connection.mode
    const hasWorkspaceFolder = currentWorkspaceFolders().length > 0
    const useConfiguredEndpoint =
      mode === 'custom' ||
      ((mode === 'auto' || mode === 'attach-only') &&
        current.connection.serverUrl !== undefined &&
        current.connection.serverUrl.trim() !== '')
    const customEndpoint = useConfiguredEndpoint
      ? endpointFromServerUrl(current.connection.serverUrl)
      : undefined
    const allowedEndpoints =
      !useConfiguredEndpoint && mode !== 'new-isolated' && current.connection.attachPortsConfigured === true
        ? current.connection.attachPorts.map((port) => ({
            host: '127.0.0.1' as const,
            port,
            baseUrl: `http://127.0.0.1:${port}`,
          }))
        : undefined
    const request: ConnectionRequest = {
      mode: useConfiguredEndpoint ? 'custom' : mode,
      ...(useConfiguredEndpoint ? { credentialRevision: externalConnection?.revision ?? 0 } : {}),
      ...(customEndpoint === undefined ? {} : { endpoint: customEndpoint }),
      ...(allowedEndpoints === undefined ? {} : { allowedEndpoints }),
      ...(current.connection.runtimeVersion === undefined || current.connection.runtimeVersion === ''
        ? {}
        : { runtimeVersion: current.connection.runtimeVersion }),
      // A workspace that has not been trusted may attach to an existing
      // host. An empty window is safe to isolate in a temporary workspace,
      // but an untrusted project folder must never auto-start DSH.
      autoStart:
        (development || current.runtime.autoStart) && (vscode.workspace.isTrusted || !hasWorkspaceFolder),
    }
    const result = await coordinator.connect(request, signal)
    signal?.throwIfAborted()
    await attach(result.backend)
    signal?.throwIfAborted()
    // A remote port must never become a remembered local discovery candidate.
    // Persistence is optional and must not hold a healthy UI on the loading page.
    void context.workspaceState
      .update(
        'dsh.lastEndpoint',
        isLoopbackEndpoint(result.backend.connection.endpoint)
          ? {
              host: result.backend.connection.endpoint.host,
              port: result.backend.connection.endpoint.port,
              ...(result.backend.connection.pid === undefined ? {} : { pid: result.backend.connection.pid }),
            }
          : undefined,
      )
      .then(undefined, () => undefined)
    // Commands may connect before the Webview exists. app.ready must always
    // receive a fresh authoritative snapshot even when the initial publish
    // had no recipient.
    publishState(result.state)
    return { connected: true }
  }
  let reconnectOperation: Promise<unknown> | undefined
  let reconnectAbort: AbortController | undefined
  const reconnect = async (signal?: AbortSignal, replace = false): Promise<unknown> => {
    if (reconnectOperation !== undefined && !replace) return reconnectOperation
    reconnectAbort?.abort(new DOMException('Connection settings changed.', 'AbortError'))
    const abort = new AbortController()
    reconnectAbort = abort
    const operationSignal = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal])
    const operation = (async (): Promise<unknown> => {
      operationSignal.throwIfAborted()
      await disposeAccountLifecycleHost()
      operationSignal.throwIfAborted()
      detachSessionAdapters()
      endpointLaunchUrls.clear()
      await coordinator.disconnect()
      operationSignal.throwIfAborted()
      await externalConnection?.release()
      operationSignal.throwIfAborted()
      return connect(operationSignal)
    })()
    reconnectOperation = operation
    try {
      return await operation
    } finally {
      if (reconnectOperation === operation) reconnectOperation = undefined
      if (reconnectAbort === abort) reconnectAbort = undefined
    }
  }
  // A transport-settings change the configuration listener observed. While
  // `configureConnection` is mid-write this is a no-op: every write the
  // configure path commits fires this listener, and acting on each one would
  // reconnect on partially updated configuration (a mode switch could attach
  // under the old mode) while the coalescer then swallowed the correcting
  // explicit reconnect.
  let configuringTransport = false
  let configurationQueue: Promise<void> = Promise.resolve()
  let configurationRevision = 0
  const writeTransportSettings = async (
    settings: vscode.WorkspaceConfiguration,
    writes: readonly (readonly [string, unknown])[],
  ): Promise<void> => {
    for (const [key, value] of writes) await settings.update(key, value, vscode.ConfigurationTarget.Global)
  }
  const reconnectOnTransportChange = (signal?: AbortSignal): Promise<unknown> => {
    if (configuringTransport) return Promise.resolve(undefined)
    return reconnect(signal, true)
  }
  const configureConnection = async (
    mode: 'auto' | 'custom',
    endpoint: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    signal?.throwIfAborted()
    let writes: readonly (readonly [string, unknown])[]
    if (mode === 'custom') {
      const normalized = normalizeServerUrl(endpoint ?? '')
      if (normalized === undefined)
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'Enter an HTTP(S) endpoint such as http://127.0.0.1:3080.',
          retryable: false,
        })
      writes = [
        // Write the endpoint before switching modes so the configuration is
        // never observed in a transient custom-without-endpoint state.
        ['connection.serverUrl', normalized],
        ['connection.mode', mode],
      ]
    } else {
      writes = [
        // Switch out of custom mode before clearing its endpoint for the same
        // reason. Existing attach-only/new-isolated settings remain untouched
        // until the user explicitly chooses a mode here.
        ['connection.mode', mode],
        ['connection.serverUrl', ''],
      ]
    }
    const revision = ++configurationRevision
    reconnectAbort?.abort(new DOMException('Connection settings changed.', 'AbortError'))
    // Serialize settings writes, while a newer submission cancels an obsolete
    // network attempt instead of waiting for its timeout.
    const operation = configurationQueue.then(async () => {
      signal?.throwIfAborted()
      if (revision !== configurationRevision)
        throw new DOMException('Connection settings changed.', 'AbortError')
      configuringTransport = true
      try {
        if (mode === 'custom' && externalConnection !== undefined) {
          const selected = endpointFromServerUrl(endpoint)
          if (selected === undefined)
            throw new AppError({
              code: 'INVALID_ENDPOINT',
              message: 'Enter a valid DSH endpoint.',
              retryable: false,
            })
          await externalConnection.authorize(selected, signal)
        }
        signal?.throwIfAborted()
        await writeTransportSettings(vscode.workspace.getConfiguration('dsh'), writes)
        if (revision !== configurationRevision)
          throw new DOMException('Connection settings changed.', 'AbortError')
        signal?.throwIfAborted()
        return await reconnect(signal, true)
      } finally {
        configuringTransport = false
      }
    })
    configurationQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
  return { connect, reconnect, reconnectOnTransportChange, configureConnection }
}

export function createManagedEndpointLoginHandler(
  endpointCookies: Map<string, string>,
  endpointLaunchUrls: Map<string, string>,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): (endpoint: BackendEndpoint, launchUrl: string | undefined, signal: AbortSignal) => Promise<void> {
  return async (endpoint, launchUrl, signal) => {
    // A managed port can be reused by a fresh DSH process. Never let a cookie
    // from the previous process authorize the new endpoint.
    endpointCookies.delete(endpoint.baseUrl)
    endpointLaunchUrls.delete(endpoint.baseUrl)
    signal.throwIfAborted()
    if (launchUrl === undefined) return
    const target = new URL(launchUrl)
    if (
      !isLoopbackEndpoint(endpoint) ||
      parseServerOrigin(target.origin)?.baseUrl !== endpoint.baseUrl ||
      target.username !== '' ||
      target.password !== ''
    ) {
      throw new AppError({
        code: 'INVALID_ENDPOINT',
        message: 'The managed launch URL does not match its local endpoint.',
        retryable: false,
      })
    }
    const loginSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    let response: Response
    try {
      response = await fetcher(launchUrl, { method: 'GET', redirect: 'manual', signal: loginSignal })
    } catch (error) {
      signal.throwIfAborted()
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The managed DSH web login could not be completed.',
        retryable: true,
        cause: error,
      })
    }
    signal.throwIfAborted()
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const setCookies = headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? '']
    const cookie = setCookies
      .map((value) => value.split(';', 1)[0]?.trim() ?? '')
      .find((value) => /^[^=;\s]+=[^;\r\n]+$/u.test(value))
    await response.body?.cancel().catch(() => undefined)
    if (response.status < 300 || response.status >= 400 || cookie === undefined) {
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The managed DSH web login returned no session cookie.',
        retryable: true,
      })
    }
    signal.throwIfAborted()
    endpointCookies.set(endpoint.baseUrl, cookie)
    endpointLaunchUrls.set(endpoint.baseUrl, launchUrl)
  }
}
