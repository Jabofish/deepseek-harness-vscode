import path from 'node:path'

import type { WorkspaceCreateInput, WorkspaceSummary } from '@dsh-vscode/domain'

export interface StoredTemporaryWorkspace {
  readonly id: string
  readonly path: string
}

export interface TemporaryWorkspaceManagerDependencies {
  readonly rootPath: string
  readonly initialReference?: StoredTemporaryWorkspace
  readonly createWorkspace: (input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>
  readonly ensureDirectory: (directoryPath: string) => Promise<void>
  readonly createTemporaryDirectory: (prefix: string) => Promise<string>
  readonly removeDirectory: (directoryPath: string) => Promise<void>
  readonly isManagedPath: (candidatePath: string) => boolean
  readonly samePath: (left: string, right: string) => boolean
  readonly persistReference: (reference: StoredTemporaryWorkspace | undefined) => Promise<void>
}

/**
 * Owns the extension-created workspace used when VS Code has no folder open.
 *
 * DSH's workspace registry is durable, but the extension's temporary path is
 * also durable in ExtensionContext.globalState. A DSH restart or profile
 * change can therefore make the registry omit a path that the extension still
 * owns. The manager re-registers that exact safe path instead of silently
 * returning an empty workspace list.
 */
export class TemporaryWorkspaceManager {
  private currentWorkspace: WorkspaceSummary | undefined
  private storedReference: StoredTemporaryWorkspace | undefined
  private creating: Promise<WorkspaceSummary> | undefined

  public constructor(private readonly dependencies: TemporaryWorkspaceManagerDependencies) {
    this.storedReference = dependencies.initialReference
  }

  public get current(): WorkspaceSummary | undefined {
    return this.currentWorkspace
  }

  public get reference(): StoredTemporaryWorkspace | undefined {
    return this.storedReference
  }

  /**
   * Resolve the one extension-owned workspace from the current DSH registry.
   * A managed registry entry is adopted when state was lost; otherwise the
   * persisted path is re-registered or a fresh managed directory is created.
   */
  public async resolve(
    workspaces: readonly WorkspaceSummary[],
    signal?: AbortSignal,
  ): Promise<WorkspaceSummary> {
    const reference = await this.validReference()
    if (reference !== undefined) {
      const refreshed = workspaces.find(
        (workspace) =>
          workspace.id === reference.id ||
          (workspace.path !== undefined && this.dependencies.samePath(workspace.path, reference.path)),
      )
      if (refreshed !== undefined) return this.remember(refreshed, reference.path)
    }

    // Recover a managed DSH registry entry even when globalState was lost or
    // belongs to a previous Extension Host instance. Only paths under this
    // extension's own temporary root are eligible for adoption.
    const managed = workspaces.find(
      (workspace) => workspace.path !== undefined && this.dependencies.isManagedPath(workspace.path),
    )
    if (managed !== undefined) return this.remember(managed)

    // The registry result is authoritative for this lookup. If the DSH
    // process was recreated and lost its in-memory registry, re-register the
    // same managed path even when this extension instance still has a cached
    // summary.
    return this.ensure(signal, true)
  }

  /** Ensure the temporary workspace exists and is registered exactly once. */
  public ensure(signal?: AbortSignal, forceRegistration = false): Promise<WorkspaceSummary> {
    if (!forceRegistration && this.currentWorkspace !== undefined)
      return Promise.resolve(this.currentWorkspace)
    if (this.creating !== undefined) return this.creating

    const operation = this.createOrRestore(signal)
    this.creating = operation
    void operation.then(
      () => {
        if (this.creating === operation) this.creating = undefined
      },
      () => {
        if (this.creating === operation) this.creating = undefined
      },
    )
    return operation
  }

  public async remember(workspace: WorkspaceSummary, fallbackPath?: string): Promise<WorkspaceSummary> {
    const workspacePath = workspace.path ?? fallbackPath ?? this.storedReference?.path
    if (workspacePath === undefined || !this.dependencies.isManagedPath(workspacePath)) {
      throw new Error('A temporary workspace must stay inside the extension-managed root.')
    }

    const remembered = { ...workspace, path: workspacePath }
    this.currentWorkspace = remembered
    const nextReference: StoredTemporaryWorkspace = { id: remembered.id, path: workspacePath }
    if (
      this.storedReference === undefined ||
      this.storedReference.id !== nextReference.id ||
      !this.dependencies.samePath(this.storedReference.path, nextReference.path)
    ) {
      this.storedReference = nextReference
      await this.dependencies.persistReference(nextReference)
    }
    return remembered
  }

  public async forget(removeDirectory: boolean): Promise<void> {
    const temporaryPath = this.currentWorkspace?.path ?? this.storedReference?.path
    this.currentWorkspace = undefined
    this.storedReference = undefined
    await this.dependencies.persistReference(undefined)
    if (removeDirectory && temporaryPath !== undefined && this.dependencies.isManagedPath(temporaryPath))
      await this.dependencies.removeDirectory(temporaryPath).catch(() => undefined)
  }

  private async createOrRestore(signal?: AbortSignal): Promise<WorkspaceSummary> {
    const reference = await this.validReference()
    if (reference !== undefined) {
      await this.dependencies.ensureDirectory(reference.path)
      const restored = await this.dependencies.createWorkspace(
        { name: 'Temporary Workspace', path: reference.path },
        signal,
      )
      return this.remember(restored, reference.path)
    }

    await this.dependencies.ensureDirectory(this.dependencies.rootPath)
    const temporaryPath = await this.dependencies.createTemporaryDirectory(
      path.join(this.dependencies.rootPath, 'workspace-'),
    )
    try {
      const created = await this.dependencies.createWorkspace(
        { name: 'Temporary Workspace', path: temporaryPath },
        signal,
      )
      return this.remember(created, temporaryPath)
    } catch (error) {
      await this.dependencies.removeDirectory(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  private async validReference(): Promise<StoredTemporaryWorkspace | undefined> {
    const reference = this.storedReference
    if (reference === undefined || this.dependencies.isManagedPath(reference.path)) return reference

    // Never re-register a user-controlled or malformed persisted path. Clear
    // only the reference; the path itself is not ours to delete.
    this.storedReference = undefined
    await this.dependencies.persistReference(undefined)
    return undefined
  }
}
