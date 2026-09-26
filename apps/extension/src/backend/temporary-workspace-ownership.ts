import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import path from 'node:path'

import {
  isManagedTemporaryWorkspaceLocation,
  isManagedTemporaryWorkspacePath,
  isManagedTemporaryWorkspacePathMissing,
} from './path-safety.js'

const ownershipTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const markerVersion = 1
const maxFileId = 0xffffffffffffffffn

interface DirectoryIdentity {
  readonly device: string
  readonly inode: string
}

interface MarkerSnapshot {
  readonly contents: string
  readonly identity: DirectoryIdentity
}

interface OwnershipMarker extends DirectoryIdentity {
  readonly version: typeof markerVersion
  readonly ownershipToken: string
}

type PendingDirectoryRecreation =
  | {
      readonly kind: 'versioned'
      readonly contents: string
      readonly marker: OwnershipMarker
      readonly markerIdentity: DirectoryIdentity
    }
  | {
      readonly kind: 'legacy'
      readonly contents: string
      readonly ownershipToken: string
      readonly markerIdentity: DirectoryIdentity
    }

/** Persists ownership beside a managed workspace without adding files to its contents. */
export class TemporaryWorkspaceOwnershipStore {
  private readonly pendingDirectoryRecreation = new Map<string, PendingDirectoryRecreation>()
  private readonly pendingExclusiveDirectoryCreation = new Map<string, DirectoryIdentity>()
  private readonly pathOperationTails = new Map<string, Promise<void>>()

  public constructor(private readonly rootPath: string) {}

  public createDirectoryExclusive(directoryPath: string): Promise<void> {
    return this.withPathLock(directoryPath, async () => {
      if (!isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath)) {
        throw new Error('The temporary workspace must be created directly under managed storage.')
      }

      // mkdir without recursive mode refuses an existing leaf. Capture the new
      // directory's filesystem identity before the manager can yield to marker
      // restoration, then require create() to see this same directory instance.
      await mkdir(directoryPath)
      const identity = identityFromStat(lstatSync(directoryPath, { bigint: true }))
      if (identity === undefined || !isManagedTemporaryWorkspacePath(this.rootPath, directoryPath)) {
        throw new Error('The newly created temporary workspace has no reliable file identity.')
      }
      this.pendingExclusiveDirectoryCreation.set(this.pathKey(directoryPath), identity)
    })
  }

  public create(directoryPath: string, expectedOwnershipToken?: string): Promise<string> {
    return this.withPathLock(directoryPath, () =>
      this.createWithoutLock(directoryPath, expectedOwnershipToken),
    )
  }

  private async createWithoutLock(directoryPath: string, expectedOwnershipToken?: string): Promise<string> {
    if (!isManagedTemporaryWorkspacePath(this.rootPath, directoryPath)) {
      throw new Error('The temporary workspace ownership marker must stay beside a managed directory.')
    }

    const directoryIdentity = await this.directoryIdentity(directoryPath)
    if (directoryIdentity === undefined)
      throw new Error('The temporary workspace has no reliable file identity.')

    const directoryKey = this.pathKey(directoryPath)
    const expectedCreatedIdentity = this.pendingExclusiveDirectoryCreation.get(directoryKey)
    if (expectedCreatedIdentity !== undefined && !sameIdentity(directoryIdentity, expectedCreatedIdentity)) {
      this.pendingExclusiveDirectoryCreation.delete(directoryKey)
      throw new Error('The temporary workspace changed after exclusive creation.')
    }
    const pending = this.pendingDirectoryRecreation.get(directoryKey)
    if (pending !== undefined) {
      const pendingToken =
        pending.kind === 'versioned' ? pending.marker.ownershipToken : pending.ownershipToken
      if (expectedOwnershipToken !== pendingToken) {
        this.pendingDirectoryRecreation.delete(directoryKey)
        throw new Error('The temporary workspace ownership token changed before restoration.')
      }

      const currentMarker = await this.readMarkerSnapshot(directoryPath)
      if (
        currentMarker?.contents !== pending.contents ||
        !sameIdentity(currentMarker.identity, pending.markerIdentity)
      ) {
        this.pendingDirectoryRecreation.delete(directoryKey)
        throw new Error('The temporary workspace ownership marker changed before restoration.')
      }

      const rebound: OwnershipMarker = {
        version: markerVersion,
        ownershipToken: pendingToken,
        ...directoryIdentity,
      }
      await this.replaceMarker(
        directoryPath,
        pending.contents,
        rebound,
        directoryIdentity,
        pending.markerIdentity,
      )
      this.pendingDirectoryRecreation.delete(directoryKey)
      this.pendingExclusiveDirectoryCreation.delete(directoryKey)
      return pendingToken
    }
    if (expectedOwnershipToken !== undefined) {
      throw new Error('The temporary workspace ownership token was not verified before restoration.')
    }

    const marker: OwnershipMarker = {
      version: markerVersion,
      ownershipToken: randomUUID(),
      ...directoryIdentity,
    }
    const markerPath = this.markerPath(directoryPath)
    await writeFile(markerPath, serializeMarker(marker), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })

    // Make sure the path still denotes the directory instance bound above.
    // A failure leaves the sidecar as a safe orphan rather than guessing which
    // replacement directory should inherit ownership.
    if (
      !isManagedTemporaryWorkspacePath(this.rootPath, directoryPath) ||
      !sameIdentity(await this.directoryIdentity(directoryPath), directoryIdentity)
    ) {
      throw new Error('The temporary workspace changed while ownership was recorded.')
    }
    this.pendingExclusiveDirectoryCreation.delete(directoryKey)
    return marker.ownershipToken
  }

  public read(directoryPath: string, expectedOwnershipToken?: string): Promise<string | undefined> {
    return this.withPathLock(directoryPath, () => this.readWithoutLock(directoryPath, expectedOwnershipToken))
  }

  protected async readWithoutLock(
    directoryPath: string,
    expectedOwnershipToken?: string,
  ): Promise<string | undefined> {
    const directoryKey = this.pathKey(directoryPath)
    if (
      !isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath) ||
      (expectedOwnershipToken !== undefined && !isTemporaryWorkspaceOwnershipToken(expectedOwnershipToken))
    ) {
      this.pendingDirectoryRecreation.delete(directoryKey)
      return undefined
    }

    try {
      const snapshot = await this.readMarkerSnapshot(directoryPath)
      if (snapshot === undefined) {
        this.pendingDirectoryRecreation.delete(directoryKey)
        return undefined
      }
      const { contents } = snapshot

      let currentIdentity: DirectoryIdentity | undefined
      try {
        currentIdentity = identityFromStat(await lstat(directoryPath, { bigint: true }))
      } catch (error) {
        if (isNotFound(error) && isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath)) {
          const marker = parseMarker(contents)
          if (marker !== undefined) {
            if (expectedOwnershipToken !== undefined && marker.ownershipToken !== expectedOwnershipToken) {
              this.pendingDirectoryRecreation.delete(directoryKey)
              return undefined
            }
            this.pendingDirectoryRecreation.set(directoryKey, {
              kind: 'versioned',
              contents,
              marker,
              markerIdentity: snapshot.identity,
            })
            return marker.ownershipToken
          }
          const legacyToken = parseLegacyToken(contents)
          if (legacyToken !== undefined && expectedOwnershipToken === legacyToken) {
            // The previous format had no directory identity. Keep it pending
            // only when persisted global state supplies the exact token; the
            // manager must recreate the directory before it can be upgraded.
            this.pendingDirectoryRecreation.set(directoryKey, {
              kind: 'legacy',
              contents,
              ownershipToken: legacyToken,
              markerIdentity: snapshot.identity,
            })
            return legacyToken
          }
          this.pendingDirectoryRecreation.delete(directoryKey)
          return undefined
        }
        this.pendingDirectoryRecreation.delete(directoryKey)
        return undefined
      }

      if (currentIdentity === undefined || !isManagedTemporaryWorkspacePath(this.rootPath, directoryPath)) {
        this.pendingDirectoryRecreation.delete(directoryKey)
        return undefined
      }

      const marker = parseMarker(contents)
      if (marker !== undefined) {
        if (
          !sameIdentity(currentIdentity, marker) ||
          (expectedOwnershipToken !== undefined && marker.ownershipToken !== expectedOwnershipToken)
        ) {
          // A different directory at the same path is not the previous owner.
          this.pendingDirectoryRecreation.delete(directoryKey)
          return undefined
        }
        this.pendingDirectoryRecreation.delete(directoryKey)
        return marker.ownershipToken
      }

      const legacyToken = parseLegacyToken(contents)
      if (legacyToken === undefined || expectedOwnershipToken !== legacyToken) {
        // Old bare UUID markers are adoptable only through the exact token
        // retained in global state. Registry discovery alone cannot migrate it.
        this.pendingDirectoryRecreation.delete(directoryKey)
        return undefined
      }

      const migrated: OwnershipMarker = {
        version: markerVersion,
        ownershipToken: legacyToken,
        ...currentIdentity,
      }
      await this.replaceMarker(directoryPath, contents, migrated, currentIdentity, snapshot.identity)
      this.pendingDirectoryRecreation.delete(directoryKey)
      return legacyToken
    } catch {
      this.pendingDirectoryRecreation.delete(directoryKey)
      return undefined
    }
  }

  public remove(directoryPath: string, ownershipToken: string): Promise<void> {
    return this.withPathLock(directoryPath, () => this.removeWithoutLock(directoryPath, ownershipToken))
  }

  public removeOwnedDirectory(directoryPath: string, ownershipToken: string): Promise<void> {
    return this.withPathLock(directoryPath, () =>
      this.removeOwnedDirectoryWithoutLock(directoryPath, ownershipToken),
    )
  }

  private async removeWithoutLock(directoryPath: string, ownershipToken: string): Promise<void> {
    const directoryKey = this.pathKey(directoryPath)
    try {
      if (
        !isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath) ||
        !isManagedTemporaryWorkspacePathMissing(this.rootPath, directoryPath)
      ) {
        throw new Error('The temporary workspace ownership marker changed before removal.')
      }
      if ((await this.readWithoutLock(directoryPath, ownershipToken)) !== ownershipToken) {
        if (
          isManagedTemporaryWorkspacePathMissing(this.rootPath, directoryPath) &&
          (await this.markerIsMissing(directoryPath)) &&
          isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath)
        ) {
          return
        }
        throw new Error('The temporary workspace ownership marker changed before removal.')
      }
      const pending = this.pendingDirectoryRecreation.get(directoryKey)
      if (pending === undefined || !isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath)) {
        throw new Error('The temporary workspace ownership marker changed before removal.')
      }
      const expectedContents = pending.contents
      const expectedMarkerIdentity = pending.markerIdentity
      const currentMarker = await this.readMarkerSnapshot(directoryPath)
      if (
        currentMarker?.contents !== expectedContents ||
        !sameIdentity(currentMarker.identity, expectedMarkerIdentity) ||
        !isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath) ||
        !isManagedTemporaryWorkspacePathMissing(this.rootPath, directoryPath)
      ) {
        if (
          currentMarker === undefined &&
          isManagedTemporaryWorkspacePathMissing(this.rootPath, directoryPath) &&
          (await this.markerIsMissing(directoryPath))
        ) {
          return
        }
        throw new Error('The temporary workspace ownership marker changed before removal.')
      }
      // Recheck the marker identity and absence immediately before unlinking.
      // This detects replacements during async filesystem checks; Node does not
      // provide a portable conditional unlink, so external TOCTOU remains.
      const finalMarker = await this.readMarkerSnapshot(directoryPath)
      if (
        finalMarker?.contents !== expectedContents ||
        !sameIdentity(finalMarker.identity, expectedMarkerIdentity) ||
        !isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath) ||
        !isManagedTemporaryWorkspacePathMissing(this.rootPath, directoryPath)
      ) {
        if (
          finalMarker === undefined &&
          isManagedTemporaryWorkspacePathMissing(this.rootPath, directoryPath) &&
          (await this.markerIsMissing(directoryPath))
        ) {
          return
        }
        throw new Error('The temporary workspace ownership marker changed before removal.')
      }
      try {
        await unlink(this.markerPath(directoryPath))
      } catch (error) {
        if (
          !isNotFound(error) ||
          !isManagedTemporaryWorkspacePathMissing(this.rootPath, directoryPath) ||
          !isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath)
        ) {
          throw error
        }
      }
    } finally {
      // In particular, a failed marker unlink must not leave an implicit
      // permission to bind a later same-named directory to this owner.
      this.pendingDirectoryRecreation.delete(directoryKey)
    }
  }

  private async removeOwnedDirectoryWithoutLock(
    directoryPath: string,
    ownershipToken: string,
  ): Promise<void> {
    const markerSnapshot = await this.readMarkerSnapshot(directoryPath)
    const marker = parseMarker(markerSnapshot?.contents)
    const directoryIdentity = await this.directoryIdentity(directoryPath)
    if (
      !isManagedTemporaryWorkspacePath(this.rootPath, directoryPath) ||
      markerSnapshot === undefined ||
      marker?.ownershipToken !== ownershipToken ||
      directoryIdentity === undefined ||
      !sameIdentity(directoryIdentity, marker)
    ) {
      throw new Error('The temporary workspace changed before safe removal.')
    }

    // Move the path into a fresh private container before recursive deletion.
    // The post-rename file identity check catches a same-name replacement that
    // races the final pre-rename checks; an unverified object is restored when
    // the original name remains available, and is never recursively removed.
    const quarantineDirectory = await mkdtemp(path.join(this.rootPath, 'workspace-cleanup-'))
    const quarantineIdentityResult = await this.directoryIdentity(quarantineDirectory)
    if (quarantineIdentityResult === undefined) {
      throw new Error('The temporary workspace cleanup location could not be verified.')
    }
    const quarantineIdentity = quarantineIdentityResult
    const quarantinedPath = path.join(quarantineDirectory, 'workspace')
    const quarantineWitnessPath = path.join(quarantineDirectory, '.workspace-cleanup-witness')
    let quarantinedIdentity: DirectoryIdentity | undefined
    let quarantineHandle: Awaited<ReturnType<typeof open>> | undefined
    let quarantineWitnessHandle: Awaited<ReturnType<typeof open>> | undefined
    let quarantineWitnessIdentity: DirectoryIdentity | undefined

    try {
      // Pin the fresh container while checking its identity so a junction
      // replacement between creation and these checks cannot redirect later
      // operations.
      quarantineHandle = await open(quarantineDirectory, 'r')
      if (
        !sameIdentity(identityFromStat(await quarantineHandle.stat({ bigint: true })), quarantineIdentity)
      ) {
        throw new Error('The temporary workspace cleanup location could not be verified.')
      }
      await quarantineHandle.close()
      quarantineHandle = undefined

      if (!isManagedTemporaryWorkspacePath(this.rootPath, quarantineDirectory)) {
        throw new Error('The temporary workspace cleanup location could not be verified.')
      }

      // A regular-file handle gives us a portable link-count witness after
      // recursive deletion. Directory link counts for an open, removed
      // directory differ between filesystems.
      quarantineWitnessHandle = await open(quarantineWitnessPath, 'wx', 0o600)
      quarantineWitnessIdentity = identityFromFileStat(await quarantineWitnessHandle.stat({ bigint: true }))
      if (
        quarantineWitnessIdentity === undefined ||
        !sameIdentity(await this.regularFileIdentity(quarantineWitnessPath), quarantineWitnessIdentity)
      ) {
        throw new Error('The temporary workspace cleanup location could not be verified.')
      }

      const markerBeforeMove = await this.readMarkerSnapshot(directoryPath)
      if (
        markerBeforeMove?.contents !== markerSnapshot.contents ||
        !sameIdentity(markerBeforeMove.identity, markerSnapshot.identity) ||
        !isManagedTemporaryWorkspacePath(this.rootPath, directoryPath) ||
        !sameIdentity(await this.directoryIdentity(directoryPath), directoryIdentity) ||
        !sameIdentity(await this.directoryIdentity(quarantineDirectory), quarantineIdentity)
      ) {
        throw new Error('The temporary workspace changed before safe removal.')
      }

      await rename(directoryPath, quarantinedPath)
      quarantinedIdentity = await this.directoryIdentity(quarantinedPath)
      if (!sameIdentity(quarantinedIdentity, directoryIdentity)) {
        const restored = await this.restoreQuarantinedDirectory(
          directoryPath,
          quarantineDirectory,
          quarantinedPath,
          quarantinedIdentity,
          quarantineIdentity,
        )
        if (restored) quarantinedIdentity = undefined
        throw new Error(
          restored
            ? 'The temporary workspace changed during safe removal; the replacement was restored.'
            : 'The temporary workspace changed during safe removal; its replacement was preserved in isolated storage.',
        )
      }

      let markerAfterMove: MarkerSnapshot | undefined
      try {
        // The ownership marker is a sidecar outside the workspace directory, so
        // moving the workspace alone does not isolate it. Recheck the original
        // sidecar identity and bytes after the move and before deleting data.
        markerAfterMove = await this.readMarkerSnapshot(directoryPath)
      } catch {
        markerAfterMove = undefined
      }
      if (
        markerAfterMove?.contents !== markerSnapshot.contents ||
        !sameIdentity(markerAfterMove.identity, markerSnapshot.identity)
      ) {
        const restored = await this.restoreQuarantinedDirectory(
          directoryPath,
          quarantineDirectory,
          quarantinedPath,
          quarantinedIdentity,
          quarantineIdentity,
        )
        if (restored) quarantinedIdentity = undefined
        throw new Error(
          restored
            ? 'The temporary workspace ownership marker changed during safe removal; the workspace was restored.'
            : 'The temporary workspace ownership marker changed during safe removal; the workspace was preserved in isolated storage.',
        )
      }

      if (
        !isManagedTemporaryWorkspacePath(this.rootPath, quarantineDirectory) ||
        !sameIdentity(await this.directoryIdentity(quarantineDirectory), quarantineIdentity) ||
        !sameIdentity(await this.regularFileIdentity(quarantineWitnessPath), quarantineWitnessIdentity) ||
        !sameIdentity(await this.directoryIdentity(quarantinedPath), directoryIdentity)
      ) {
        throw new Error('The temporary workspace changed while isolated for safe removal.')
      }

      // Delete the quarantine container itself as the recursive-removal leaf.
      // If that leaf was replaced with a junction after the checks above, Node
      // removes the junction rather than traversing it; the still-linked file
      // witness below makes that substitution fail closed.
      await rm(quarantineDirectory, { recursive: true })
      const removedWitness = await quarantineWitnessHandle.stat({ bigint: true })
      if (removedWitness.nlink !== 0n) {
        throw new Error('The temporary workspace cleanup container changed during removal.')
      }
      quarantinedIdentity = undefined
    } catch (error) {
      if (quarantinedIdentity !== undefined) {
        await this.restoreQuarantinedDirectory(
          directoryPath,
          quarantineDirectory,
          quarantinedPath,
          quarantinedIdentity,
          quarantineIdentity,
        )
      }
      throw error
    } finally {
      await quarantineHandle?.close().catch(() => undefined)
      await quarantineWitnessHandle?.close().catch(() => undefined)
      if (
        isManagedTemporaryWorkspacePath(this.rootPath, quarantineDirectory) &&
        sameIdentity(await this.directoryIdentity(quarantineDirectory), quarantineIdentity)
      ) {
        if (
          quarantineWitnessIdentity !== undefined &&
          sameIdentity(await this.regularFileIdentity(quarantineWitnessPath), quarantineWitnessIdentity)
        ) {
          await unlink(quarantineWitnessPath).catch(() => undefined)
        }
        await rmdir(quarantineDirectory).catch(() => undefined)
      }
    }
  }

  private async restoreQuarantinedDirectory(
    directoryPath: string,
    quarantineDirectory: string,
    quarantinedPath: string,
    quarantinedIdentity: DirectoryIdentity | undefined,
    quarantineIdentity: DirectoryIdentity,
  ): Promise<boolean> {
    if (
      quarantinedIdentity === undefined ||
      !isManagedTemporaryWorkspacePath(this.rootPath, quarantineDirectory) ||
      !sameIdentity(await this.directoryIdentity(quarantineDirectory), quarantineIdentity) ||
      !sameIdentity(await this.directoryIdentity(quarantinedPath), quarantinedIdentity) ||
      !isManagedTemporaryWorkspaceLocation(this.rootPath, directoryPath) ||
      !isManagedTemporaryWorkspacePathMissing(this.rootPath, directoryPath)
    ) {
      return false
    }

    await rename(quarantinedPath, directoryPath)
    return sameIdentity(await this.directoryIdentity(directoryPath), quarantinedIdentity)
  }

  protected async directoryIdentity(directoryPath: string): Promise<DirectoryIdentity | undefined> {
    try {
      return identityFromStat(await lstat(directoryPath, { bigint: true }))
    } catch {
      return undefined
    }
  }

  private async regularFileIdentity(filePath: string): Promise<DirectoryIdentity | undefined> {
    try {
      return identityFromFileStat(await lstat(filePath, { bigint: true }))
    } catch {
      return undefined
    }
  }

  private async readMarker(directoryPath: string): Promise<OwnershipMarker | undefined> {
    return parseMarker((await this.readMarkerSnapshot(directoryPath))?.contents)
  }

  protected async readMarkerSnapshot(directoryPath: string): Promise<MarkerSnapshot | undefined> {
    const markerPath = this.markerPath(directoryPath)
    const beforeStat = await lstat(markerPath, { bigint: true })
    const beforeIdentity = identityFromFileStat(beforeStat)
    if (beforeIdentity === undefined) return undefined
    const contents = await readFile(markerPath, 'utf8')
    const afterStat = await lstat(markerPath, { bigint: true })
    const afterIdentity = identityFromFileStat(afterStat)
    if (afterIdentity === undefined || !sameIdentity(beforeIdentity, afterIdentity)) return undefined
    return { contents, identity: afterIdentity }
  }

  private async markerIsMissing(directoryPath: string): Promise<boolean> {
    try {
      await lstat(this.markerPath(directoryPath), { bigint: true })
      return false
    } catch (error) {
      return isNotFound(error)
    }
  }

  private async replaceMarker(
    directoryPath: string,
    expectedContents: string,
    replacement: OwnershipMarker,
    expectedDirectoryIdentity: DirectoryIdentity,
    expectedMarkerIdentity: DirectoryIdentity,
  ): Promise<void> {
    if (
      !isManagedTemporaryWorkspacePath(this.rootPath, directoryPath) ||
      !sameIdentity(await this.directoryIdentity(directoryPath), expectedDirectoryIdentity)
    ) {
      throw new Error('The temporary workspace changed while its ownership was restored.')
    }

    const markerBeforeWrite = await this.readMarkerSnapshot(directoryPath)
    if (
      markerBeforeWrite?.contents !== expectedContents ||
      !sameIdentity(markerBeforeWrite.identity, expectedMarkerIdentity)
    ) {
      throw new Error('The temporary workspace ownership marker changed before replacement.')
    }

    const markerPath = this.markerPath(directoryPath)
    const replacementPath = `${markerPath}.tmp-${randomUUID()}`
    let replacementIdentity: DirectoryIdentity | undefined
    try {
      const replacementHandle = await open(replacementPath, 'wx', 0o600)
      try {
        replacementIdentity = identityFromFileStat(await replacementHandle.stat({ bigint: true }))
        if (replacementIdentity === undefined || sameIdentity(replacementIdentity, expectedMarkerIdentity)) {
          throw new Error(
            'The temporary workspace ownership marker could not be verified before replacement.',
          )
        }
        await replacementHandle.writeFile(serializeMarker(replacement), { encoding: 'utf8' })
      } finally {
        await replacementHandle.close()
      }

      if (replacementIdentity === undefined) {
        throw new Error('The temporary workspace ownership marker could not be verified before replacement.')
      }

      const markerBeforeRename = await this.readMarkerSnapshot(directoryPath)
      if (
        markerBeforeRename?.contents !== expectedContents ||
        !sameIdentity(markerBeforeRename.identity, expectedMarkerIdentity) ||
        !isManagedTemporaryWorkspacePath(this.rootPath, directoryPath) ||
        !sameIdentity(await this.directoryIdentity(directoryPath), expectedDirectoryIdentity) ||
        !sameIdentity(
          identityFromFileStat(await lstat(replacementPath, { bigint: true })),
          replacementIdentity,
        )
      ) {
        throw new Error('The temporary workspace changed while its ownership was restored.')
      }
      // Node has no portable identity-conditional rename. Keep the source and
      // target identity checks directly beside this syscall; an external
      // replacement in the final check-to-rename interval remains possible.
      await rename(replacementPath, markerPath)
      const markerAfterRename = await this.readMarkerSnapshot(directoryPath)
      if (
        markerAfterRename === undefined ||
        !sameMarker(parseMarker(markerAfterRename.contents), replacement) ||
        !sameIdentity(markerAfterRename.identity, replacementIdentity) ||
        sameIdentity(markerAfterRename.identity, expectedMarkerIdentity) ||
        !isManagedTemporaryWorkspacePath(this.rootPath, directoryPath) ||
        !sameIdentity(await this.directoryIdentity(directoryPath), expectedDirectoryIdentity)
      ) {
        throw new Error('The temporary workspace ownership marker could not be verified after restoration.')
      }
    } finally {
      if (replacementIdentity !== undefined) {
        try {
          const leftoverIdentity = identityFromFileStat(await lstat(replacementPath, { bigint: true }))
          if (sameIdentity(leftoverIdentity, replacementIdentity)) await unlink(replacementPath)
        } catch {
          // The path may have moved during rename or been replaced. Leave any
          // unverified entry alone instead of unlinking another owner's file.
        }
      }
    }
  }

  private markerPath(directoryPath: string): string {
    return path.join(this.rootPath, `.${path.basename(directoryPath)}.dsh-vscode-owner`)
  }

  private async withPathLock<T>(directoryPath: string, operation: () => Promise<T>): Promise<T> {
    const key = this.pathKey(directoryPath)
    const previous = this.pathOperationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.pathOperationTails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.pathOperationTails.get(key) === tail) this.pathOperationTails.delete(key)
    }
  }

  private pathKey(directoryPath: string): string {
    const resolved = path.resolve(directoryPath)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
}

function identityFromStat(stat: {
  readonly dev: bigint
  readonly ino: bigint
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): DirectoryIdentity | undefined {
  // Node exposes the file-system-specific ID through BigIntStats. A zero
  // device can mean the volume query was unsupported, and zero or all-ones
  // inode values can mean no usable file ID is available. Do not fall back to
  // timestamps or the path in those cases.
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev <= 0n ||
    stat.dev >= maxFileId ||
    stat.ino <= 0n ||
    stat.ino >= maxFileId
  ) {
    return undefined
  }
  return { device: stat.dev.toString(), inode: stat.ino.toString() }
}

function identityFromFileStat(stat: {
  readonly dev: bigint
  readonly ino: bigint
  isFile(): boolean
  isSymbolicLink(): boolean
}): DirectoryIdentity | undefined {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.dev <= 0n ||
    stat.dev >= maxFileId ||
    stat.ino <= 0n ||
    stat.ino >= maxFileId
  ) {
    return undefined
  }
  return { device: stat.dev.toString(), inode: stat.ino.toString() }
}

function parseMarker(value: string | undefined): OwnershipMarker | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (
      record.version !== markerVersion ||
      !isTemporaryWorkspaceOwnershipToken(record.ownershipToken) ||
      !isCanonicalFileId(record.device) ||
      !isCanonicalFileId(record.inode) ||
      record.device === '0' ||
      record.inode === '0' ||
      record.inode === maxFileId.toString() ||
      record.device === maxFileId.toString()
    ) {
      return undefined
    }
    return {
      version: markerVersion,
      ownershipToken: record.ownershipToken,
      device: record.device,
      inode: record.inode,
    }
  } catch {
    return undefined
  }
}

function parseLegacyToken(value: string): string | undefined {
  return isTemporaryWorkspaceOwnershipToken(value) ? value : undefined
}

function isCanonicalFileId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false
  try {
    const parsed = BigInt(value)
    return parsed >= 0n && parsed <= maxFileId && parsed.toString() === value
  } catch {
    return false
  }
}

function serializeMarker(marker: OwnershipMarker): string {
  return JSON.stringify(marker)
}

function sameIdentity(left: DirectoryIdentity | undefined, right: DirectoryIdentity): boolean {
  return left?.device === right.device && left.inode === right.inode
}

function sameMarker(left: OwnershipMarker | undefined, right: OwnershipMarker): boolean {
  return (
    left?.version === right?.version &&
    left.ownershipToken === right.ownershipToken &&
    left.device === right.device &&
    left.inode === right.inode
  )
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function isTemporaryWorkspaceOwnershipToken(value: unknown): value is string {
  return typeof value === 'string' && ownershipTokenPattern.test(value)
}
