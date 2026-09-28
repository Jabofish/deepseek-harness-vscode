import * as vscode from 'vscode'
import { mkdir, mkdtemp } from 'node:fs/promises'
import type { AgentConfiguration, AgentPresetDescriptor } from '@dsh-vscode/domain'
import type { BackendService } from '@dsh-vscode/application'
import {
  AdvancedAgentUseCases,
  EditorContextUseCases,
  ExportUseCases,
  InteractionUseCases,
  ModelSettingsUseCases,
  NavigationUseCases,
  ProviderSettingsUseCases,
  SessionUseCases,
  SettingsUseCases,
  WorkspaceUseCases,
} from '@dsh-vscode/application'
import {
  isManagedTemporaryWorkspacePath,
  isManagedTemporaryWorkspacePathMissing,
} from '../backend/path-safety.js'
import { TemporaryWorkspaceOwnershipStore } from '../backend/temporary-workspace-ownership.js'
import { TemporaryWorkspaceManager } from '../backend/temporary-workspace.js'
import { AttachmentStore } from '../attachments/attachment-store.js'
import { EditorContextProvider } from '../editor/editor-context-provider.js'
import { NavigationService } from '../navigation/navigation-service.js'
import {
  readStoredTemporaryWorkspace,
  readLegacyTemporaryWorkspace,
  sameWorkspacePath,
} from './workspace-state.js'

const TEMPORARY_WORKSPACE_STATE_KEY = 'dsh.temporaryWorkspace'

/** Resolve a new session's requested preset against the host's optional roster. */
export function resolveSessionConfigurationForRoster(
  requested: AgentConfiguration,
  presets: readonly AgentPresetDescriptor[],
): AgentConfiguration {
  if (presets.length === 0) {
    // The empty string is an internal sentinel; the session adapter omits it
    // from the wire so DSH uses its own composition and default.
    return { ...requested, preset: '' }
  }

  const usable = presets.filter((preset) => preset.broken === undefined)
  const candidates = usable.length > 0 ? usable : presets
  const selected =
    candidates.find((preset) => preset.id === requested.preset) ??
    candidates.find((preset) => preset.isDefault) ??
    candidates[0]
  return { ...requested, preset: selected?.id ?? '' }
}

export interface UseCasesAssemblyDependencies {
  readonly backendService: BackendService
  readonly context: vscode.ExtensionContext
}

export interface UseCasesAssembly {
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
  readonly editorContextProvider: EditorContextProvider
  readonly editorContextUseCases: EditorContextUseCases
  readonly navigationUseCases: NavigationUseCases
}

/** Instantiate the backend-backed use cases and the workspace-local stores. */
export function createUseCasesAssembly(deps: UseCasesAssemblyDependencies): UseCasesAssembly {
  const { backendService, context } = deps
  const workspaceUseCases = new WorkspaceUseCases(backendService)
  const sessionUseCases = new SessionUseCases(backendService)
  const modelUseCases = new ModelSettingsUseCases(backendService)
  const interactionUseCases = new InteractionUseCases(backendService)
  const settingsUseCases = new SettingsUseCases(backendService)
  const providerSettingsUseCases = new ProviderSettingsUseCases(backendService)
  const advancedUseCases = new AdvancedAgentUseCases(backendService)
  const exportUseCases = new ExportUseCases(backendService)
  const storedTemporaryWorkspaceState = context.globalState.get<unknown>(TEMPORARY_WORKSPACE_STATE_KEY)
  const initialTemporaryWorkspaceReference = readStoredTemporaryWorkspace(storedTemporaryWorkspaceState)
  const initialLegacyTemporaryWorkspaceReference = readLegacyTemporaryWorkspace(storedTemporaryWorkspaceState)
  const temporaryWorkspaceOwnershipStore = new TemporaryWorkspaceOwnershipStore(
    context.globalStorageUri.fsPath,
  )
  const temporaryWorkspaceManager = new TemporaryWorkspaceManager({
    rootPath: context.globalStorageUri.fsPath,
    ...(initialTemporaryWorkspaceReference === undefined
      ? {}
      : { initialReference: initialTemporaryWorkspaceReference }),
    ...(initialLegacyTemporaryWorkspaceReference === undefined
      ? {}
      : { initialLegacyReference: initialLegacyTemporaryWorkspaceReference }),
    createWorkspace: (input, signal) => workspaceUseCases.create(input, signal),
    ensureDirectory: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true })
    },
    createDirectoryExclusive: (directoryPath) =>
      temporaryWorkspaceOwnershipStore.createDirectoryExclusive(directoryPath),
    createTemporaryDirectory: (prefix) => mkdtemp(prefix),
    createOwnershipMarker: (directoryPath, expectedOwnershipToken) =>
      temporaryWorkspaceOwnershipStore.create(directoryPath, expectedOwnershipToken),
    readOwnershipMarker: (directoryPath, expectedOwnershipToken) =>
      temporaryWorkspaceOwnershipStore.read(directoryPath, expectedOwnershipToken),
    removeOwnershipMarker: (directoryPath, ownershipToken) =>
      temporaryWorkspaceOwnershipStore.remove(directoryPath, ownershipToken),
    removeOwnedDirectory: (directoryPath, ownershipToken) =>
      temporaryWorkspaceOwnershipStore.removeOwnedDirectory(directoryPath, ownershipToken),
    isManagedPath: (candidatePath) =>
      isManagedTemporaryWorkspacePath(context.globalStorageUri.fsPath, candidatePath),
    isManagedPathMissing: (candidatePath) =>
      isManagedTemporaryWorkspacePathMissing(context.globalStorageUri.fsPath, candidatePath),
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
  return {
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
    editorContextProvider,
    editorContextUseCases,
    navigationUseCases,
  }
}
