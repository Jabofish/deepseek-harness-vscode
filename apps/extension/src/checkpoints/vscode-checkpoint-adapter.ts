import * as vscode from 'vscode'

import { AppError } from '@dsh-vscode/domain'

import type {
  CheckpointStorage,
  CheckpointStorageEntry,
  CheckpointWorkspaceAccess,
} from './checkpoint-store.js'
import { WorkspacePathGuard } from '../editor/workspace-path-guard.js'

/** Adapt VS Code's local/remote file API to the checkpoint transaction seam. */
export function createVscodeCheckpointStorage(
  workspace: typeof vscode.workspace = vscode.workspace,
): CheckpointStorage {
  return {
    mkdir: async (directory) => {
      await workspace.fs.createDirectory(vscode.Uri.file(directory))
    },
    list: async (directory): Promise<readonly CheckpointStorageEntry[]> => {
      const entries = await workspace.fs.readDirectory(vscode.Uri.file(directory))
      const result: CheckpointStorageEntry[] = []
      for (const [name, type] of entries) {
        if ((type & vscode.FileType.Directory) !== 0) result.push({ name, kind: 'directory' })
        else if ((type & vscode.FileType.File) !== 0) result.push({ name, kind: 'file' })
      }
      return result
    },
    readFile: (filePath) =>
      Promise.resolve(workspace.fs.readFile(vscode.Uri.file(filePath))).then(
        (bytes) => bytes,
        (error: unknown) => {
          if (isFileNotFound(error)) return undefined
          throw error
        },
      ),
    writeFile: (filePath, data) => Promise.resolve(workspace.fs.writeFile(vscode.Uri.file(filePath), data)),
    rename: (sourcePath, destinationPath, overwrite) =>
      Promise.resolve(
        workspace.fs.rename(vscode.Uri.file(sourcePath), vscode.Uri.file(destinationPath), { overwrite }),
      ),
    delete: (filePath, recursive) =>
      Promise.resolve(workspace.fs.delete(vscode.Uri.file(filePath), { recursive, useTrash: false })),
  }
}

/** Workspace file access with path, regular-file and symlink checks at each operation. */
export function createVscodeCheckpointWorkspace(
  workspace: typeof vscode.workspace = vscode.workspace,
): CheckpointWorkspaceAccess {
  const guard = new WorkspacePathGuard(workspace)
  return {
    readFile: async (workspaceFolderId, relativePath) => {
      const resolved = guard.resolve(workspaceFolderId, relativePath)
      const stat = await readStat(workspace, resolved.uri)
      if (stat === undefined) return undefined
      await guard.assertRegularFile(resolved)
      return workspace.fs.readFile(resolved.uri)
    },
    writeFile: async (workspaceFolderId, relativePath, data) => {
      const resolved = guard.resolve(workspaceFolderId, relativePath)
      const stat = await readStat(workspace, resolved.uri)
      if (stat !== undefined) await guard.assertRegularFile(resolved)
      await workspace.fs.writeFile(resolved.uri, data)
    },
    deleteFile: async (workspaceFolderId, relativePath) => {
      const resolved = guard.resolve(workspaceFolderId, relativePath)
      const stat = await readStat(workspace, resolved.uri)
      if (stat === undefined) return
      await guard.assertRegularFile(resolved)
      await workspace.fs.delete(resolved.uri, { recursive: false, useTrash: false })
    },
    renameFile: async (workspaceFolderId, sourceRelativePath, destinationRelativePath, overwrite) => {
      const source = guard.resolve(workspaceFolderId, sourceRelativePath)
      await guard.assertRegularFile(source)
      const destination = guard.resolve(workspaceFolderId, destinationRelativePath)
      const destinationStat = await readStat(workspace, destination.uri)
      if (destinationStat !== undefined) await guard.assertRegularFile(destination)
      await workspace.fs.rename(source.uri, destination.uri, { overwrite })
    },
  }
}

async function readStat(
  workspace: typeof vscode.workspace,
  uri: vscode.Uri,
): Promise<vscode.FileStat | undefined> {
  try {
    return await workspace.fs.stat(uri)
  } catch (error) {
    if (isFileNotFound(error)) return undefined
    throw new AppError({
      code: 'PATH_NOT_ALLOWED',
      message: 'The workspace file could not be safely inspected.',
      retryable: false,
      cause: error,
    })
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'FileNotFound'
  )
}
