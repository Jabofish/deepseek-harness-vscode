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
import { normalizeLoopbackUrl } from '../config/configuration-source.js'
import { DSH_PACKAGE } from '../constants.js'
import { RuntimeInstaller } from '../vscode/install-runtime.js'
import { DshRuntimeUpdater } from '../vscode/update-runtime.js'
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

const execFileAsync = promisify(execFile)
const RUNTIME_PATH_STATE_KEY = 'dsh.runtime.lastKnownPath'

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
  const endpointCookies = new Map<string, string>()
  // Keep the process launch URL in the Extension Host so the browser can
  // perform its own cookie exchange. The URL is never included in Webview
  // state or messages.
  const endpointLaunchUrls = new Map<string, string>()
  // One shared object for every adapter: spreading it would evaluate the
  // getters here, and building the composition root must never read settings.
  const adapterOptions = createAdapterOptions({
    requestTimeoutMs: () => configuration.read().connection.requestTimeoutMs,
    fetch: globalThis.fetch,
    samePath: sameWorkspacePath,
    exportFileSystem: createExportFileSystem(vscode),
    authCookie: (endpoint) => endpointCookies.get(endpoint.baseUrl),
  })
  const rememberReadyEndpoint = createManagedEndpointLoginHandler(endpointCookies, endpointLaunchUrls)
  const adapters = createVersionAdapters(adapterOptions)
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
  const runtimeUpdater = new DshRuntimeUpdater({
    npmExecutable: () => {
      const os = platform()
      return resolveNpmExecutable(os, extensionRuntimePathEntries(os, process.env))
    },
    locateRuntime: async (signal) => (await runtimeLocator.locate(signal)).runtime,
    onProgress: (progress) => onRuntimeUpdateProgress(progress),
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
  }
}

export interface ConnectionLifecycleDependencies {
  readonly context: vscode.ExtensionContext
  readonly configuration: VsCodeConfigurationSource
  readonly coordinator: DshConnectionCoordinator
  readonly currentWorkspaceFolders: () => readonly vscode.WorkspaceFolder[]
  readonly endpointLaunchUrls: Map<string, string>
  readonly attach: (backend: DshBackend) => Promise<void>
  readonly publishState: (state: BackendState) => void
  readonly disposeAccountLifecycleHost: () => Promise<void>
  readonly detachSessionAdapters: () => void
}

export interface ConnectionLifecycle {
  readonly connect: (signal?: AbortSignal) => Promise<unknown>
  readonly reconnect: (signal?: AbortSignal) => Promise<unknown>
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
    attach,
    publishState,
    disposeAccountLifecycleHost,
    detachSessionAdapters,
  } = deps
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
    await attach(result.backend)
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
      await disposeAccountLifecycleHost()
      detachSessionAdapters()
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
  return { connect, reconnect, configureConnection }
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
    let response: Response
    try {
      response = await fetcher(launchUrl, { method: 'GET', redirect: 'manual', signal })
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
