import path from 'node:path'

import type { WorkspaceCreateInput, WorkspaceSummary } from '@dsh-vscode/domain'

import { isTemporaryWorkspaceOwnershipToken } from './temporary-workspace-ownership.js'

export interface StoredTemporaryWorkspace {
  readonly id: string
  readonly path: string
  readonly ownershipToken: string
}

/** Pre-marker state written by previous extension versions. */
export interface LegacyTemporaryWorkspaceReference {
  readonly id: string
  readonly path: string
}

export interface TemporaryWorkspaceManagerDependencies {
  readonly rootPath: string
  readonly initialReference?: StoredTemporaryWorkspace
  readonly initialLegacyReference?: LegacyTemporaryWorkspaceReference
  readonly createWorkspace: (input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>
  readonly ensureDirectory: (directoryPath: string) => Promise<void>
  /** Create a missing managed directory without accepting an EEXIST race. */
  readonly createDirectoryExclusive: (directoryPath: string) => Promise<void>
  readonly createTemporaryDirectory: (prefix: string) => Promise<string>
  readonly createOwnershipMarker: (directoryPath: string, expectedOwnershipToken?: string) => Promise<string>
  readonly readOwnershipMarker: (
    directoryPath: string,
    expectedOwnershipToken?: string,
  ) => Promise<string | undefined>
  readonly removeOwnershipMarker: (directoryPath: string, ownershipToken: string) => Promise<void>
  readonly removeOwnedDirectory: (directoryPath: string, ownershipToken: string) => Promise<void>
  readonly isManagedPath: (candidatePath: string) => boolean
  readonly isManagedPathMissing: (candidatePath: string) => boolean
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
  private legacyReference: LegacyTemporaryWorkspaceReference | undefined
  private creating: Promise<WorkspaceSummary> | undefined

  public constructor(private readonly dependencies: TemporaryWorkspaceManagerDependencies) {
    this.storedReference = dependencies.initialReference
    this.legacyReference = dependencies.initialLegacyReference
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
      if (refreshed !== undefined) {
        const refreshedPath = refreshed.path ?? reference.path
        if (this.dependencies.isManagedPath(refreshedPath))
          return this.remember(refreshed, reference.path, reference.ownershipToken)
      }
    }

    const migrated = await this.migrateLegacyReference(workspaces)
    if (migrated !== undefined) return migrated

    // Recover a DSH registry entry only when its directory also carries the
    // marker written when this extension created it. A matching path shape
    // alone cannot establish ownership.
    for (const workspace of workspaces) {
      if (workspace.path === undefined) continue
      const directoryExists = this.dependencies.isManagedPath(workspace.path)
      if (!directoryExists && !this.dependencies.isManagedPathMissing(workspace.path)) continue
      const ownershipToken = await this.dependencies.readOwnershipMarker(workspace.path)
      if (ownershipToken === undefined) continue
      if (directoryExists) return this.remember(workspace, undefined, ownershipToken)

      const reference: StoredTemporaryWorkspace = {
        id: workspace.id,
        path: workspace.path,
        ownershipToken,
      }
      await this.dependencies.persistReference(reference)
      this.storedReference = reference
      return this.ensure(signal, true)
    }

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

  public async remember(
    workspace: WorkspaceSummary,
    fallbackPath?: string,
    expectedOwnershipToken?: string,
  ): Promise<WorkspaceSummary> {
    const workspacePath = workspace.path ?? fallbackPath ?? this.storedReference?.path
    if (workspacePath === undefined) {
      throw new Error('A temporary workspace must stay inside the extension-managed root.')
    }
    const markerToken = await this.dependencies.readOwnershipMarker(workspacePath, expectedOwnershipToken)
    if (
      !isTemporaryWorkspaceOwnershipToken(markerToken) ||
      (expectedOwnershipToken !== undefined && markerToken !== expectedOwnershipToken)
    ) {
      throw new Error('A temporary workspace must have an extension ownership marker.')
    }
    if (!this.dependencies.isManagedPath(workspacePath)) {
      throw new Error('A temporary workspace must stay inside the extension-managed root.')
    }
    const ownershipToken = markerToken

    const remembered = { ...workspace, path: workspacePath }
    const nextReference: StoredTemporaryWorkspace = {
      id: remembered.id,
      path: workspacePath,
      ownershipToken,
    }
    if (
      this.storedReference === undefined ||
      this.storedReference.id !== nextReference.id ||
      !this.dependencies.samePath(this.storedReference.path, nextReference.path) ||
      this.storedReference.ownershipToken !== nextReference.ownershipToken
    ) {
      await this.dependencies.persistReference(nextReference)
    }
    this.currentWorkspace = remembered
    this.storedReference = nextReference
    this.legacyReference = undefined
    return remembered
  }

  public async forget(removeDirectory: boolean): Promise<void> {
    const temporaryPath = this.currentWorkspace?.path ?? this.storedReference?.path
    const reference = this.storedReference
    if (
      removeDirectory &&
      temporaryPath !== undefined &&
      reference !== undefined &&
      this.dependencies.samePath(reference.path, temporaryPath)
    ) {
      const markerToken = await this.dependencies.readOwnershipMarker(temporaryPath, reference.ownershipToken)
      if (markerToken === reference.ownershipToken) {
        if (this.dependencies.isManagedPath(temporaryPath)) {
          await this.dependencies.removeOwnedDirectory(temporaryPath, reference.ownershipToken)
        } else if (!this.dependencies.isManagedPathMissing(temporaryPath)) {
          throw new Error('The temporary workspace path cannot be safely removed.')
        }
        await this.dependencies.removeOwnershipMarker(temporaryPath, reference.ownershipToken)
      }
    }

    // Keep the in-memory reference if deletion or persistence fails so a
    // later forget can retry the same cleanup.
    await this.dependencies.persistReference(undefined)
    this.currentWorkspace = undefined
    this.storedReference = undefined
    this.legacyReference = undefined
  }

  private async migrateLegacyReference(
    workspaces: readonly WorkspaceSummary[],
  ): Promise<WorkspaceSummary | undefined> {
    const legacy = this.legacyReference
    if (legacy === undefined || !this.dependencies.isManagedPath(legacy.path)) return undefined
    const registered = workspaces.find(
      (workspace) =>
        workspace.id === legacy.id &&
        workspace.path !== undefined &&
        this.dependencies.samePath(workspace.path, legacy.path),
    )
    if (registered === undefined) return undefined

    const ownershipToken =
      (await this.dependencies.readOwnershipMarker(legacy.path)) ??
      (await this.dependencies.createOwnershipMarker(legacy.path))
    if (!isTemporaryWorkspaceOwnershipToken(ownershipToken)) {
      throw new Error('A temporary workspace must have a valid extension ownership token.')
    }
    const reference: StoredTemporaryWorkspace = {
      id: legacy.id,
      path: legacy.path,
      ownershipToken,
    }
    await this.dependencies.persistReference(reference)
    this.storedReference = reference
    this.legacyReference = undefined
    return this.remember(registered, legacy.path, ownershipToken)
  }

  private async createOrRestore(signal?: AbortSignal): Promise<WorkspaceSummary> {
    const reference = await this.validReference()
    if (reference !== undefined) {
      const workspaceWasMissing = this.dependencies.isManagedPathMissing(reference.path)
      if (workspaceWasMissing) {
        // An exclusive mkdir prevents a same-path directory that appeared
        // after the missing check from inheriting the persisted owner token.
        await this.dependencies.createDirectoryExclusive(reference.path)
        // A missing, token-matched workspace can be restored. Rebind the
        // sidecar to the newly created directory instance before registering it
        // with DSH; an existing same-path directory never takes this path.
        const restoredOwnershipToken = await this.dependencies.createOwnershipMarker(
          reference.path,
          reference.ownershipToken,
        )
        if (restoredOwnershipToken !== reference.ownershipToken) {
          throw new Error('The restored temporary workspace ownership token changed.')
        }
      } else {
        await this.dependencies.ensureDirectory(reference.path)
      }
      const restored = await this.dependencies.createWorkspace(
        { name: 'Temporary Workspace', path: reference.path },
        signal,
      )
      return this.remember(restored, reference.path, reference.ownershipToken)
    }

    await this.dependencies.ensureDirectory(this.dependencies.rootPath)
    const temporaryPath = await this.dependencies.createTemporaryDirectory(
      path.join(this.dependencies.rootPath, 'workspace-'),
    )
    let ownershipToken: string | undefined
    try {
      const createdOwnershipToken = await this.dependencies.createOwnershipMarker(temporaryPath)
      if (!isTemporaryWorkspaceOwnershipToken(createdOwnershipToken)) {
        throw new Error('A temporary workspace must have a valid extension ownership token.')
      }
      ownershipToken = createdOwnershipToken
      const created = await this.dependencies.createWorkspace(
        { name: 'Temporary Workspace', path: temporaryPath },
        signal,
      )
      return this.remember(created, temporaryPath, ownershipToken)
    } catch (error) {
      try {
        const markerToken = await this.dependencies.readOwnershipMarker(temporaryPath)
        // A failed or partial marker write does not establish ownership. Never
        // infer ownership from the generated directory name or from a missing
        // marker: leave an unverified directory in place rather than risk
        // recursively deleting a directory that replaced it.
        const markerStillOurs = ownershipToken !== undefined && markerToken === ownershipToken
        if (
          markerStillOurs &&
          ownershipToken !== undefined &&
          this.dependencies.isManagedPath(temporaryPath)
        ) {
          await this.dependencies.removeOwnedDirectory(temporaryPath, ownershipToken)
          await this.dependencies.removeOwnershipMarker(temporaryPath, ownershipToken)
        }
      } catch {
        // Preserve the registration error and leave the directory alone when
        // its ownership or safe location cannot be verified.
      }
      throw error
    }
  }

  private async validReference(): Promise<StoredTemporaryWorkspace | undefined> {
    const reference = this.storedReference
    if (reference === undefined) return undefined

    const markerToken = await this.dependencies.readOwnershipMarker(reference.path, reference.ownershipToken)
    if (
      markerToken === reference.ownershipToken &&
      (this.dependencies.isManagedPath(reference.path) ||
        this.dependencies.isManagedPathMissing(reference.path))
    )
      return reference

    // Never re-register a user-controlled, unmarked, or malformed persisted
    // path. Clear only the reference; the path itself is not ours to delete.
    this.storedReference = undefined
    await this.dependencies.persistReference(undefined)
    return undefined
  }
}
