import * as vscode from 'vscode'
import path from 'node:path'

import { AppError } from '@dsh-vscode/domain'

import { workspaceFolderId } from '../editor/workspace-path-guard.js'
import type { PromptTemplateScopeStorage } from './prompt-template-store.js'

/**
 * Adapt VS Code's workspace.fs to the Host-only prompt-template storage seam.
 * The store controls all file names; this adapter only exposes fixed storage
 * roots and never accepts a path from the Webview.
 */
export function createVscodePromptTemplateStorage(
  rootPath: string,
  workspace: typeof vscode.workspace = vscode.workspace,
): PromptTemplateScopeStorage {
  return createStorage(rootPath, workspace)
}

export function createVscodeWorkspacePromptTemplateStorage(
  requestedWorkspaceFolderId: string,
  workspace: typeof vscode.workspace = vscode.workspace,
): PromptTemplateScopeStorage | undefined {
  const folder = workspace.workspaceFolders?.find(
    (candidate) => workspaceFolderId(candidate) === requestedWorkspaceFolderId,
  )
  if (folder === undefined || folder.uri.scheme !== 'file') return undefined
  const metadataRoot = path.join(folder.uri.fsPath, '.dsh-vscode')
  return createStorage(path.join(metadataRoot, 'prompts'), workspace, [folder.uri.fsPath, metadataRoot])
}

function createStorage(
  rootPath: string,
  workspace: typeof vscode.workspace,
  protectedRoots: readonly string[] = [],
): PromptTemplateScopeStorage {
  const root = path.resolve(rootPath)
  const safeRoots = [...new Set([root, ...protectedRoots.map((candidate) => path.resolve(candidate))])]
  const uriFor = (name: string): vscode.Uri => {
    assertSafeName(name)
    return vscode.Uri.file(path.join(root, name))
  }
  return {
    mkdir: async () => {
      await assertSafeRoots(workspace, safeRoots)
      await workspace.fs.createDirectory(vscode.Uri.file(root))
      await assertSafeRoots(workspace, safeRoots)
    },
    read: async (name) => {
      try {
        await assertSafeRoots(workspace, safeRoots)
        await assertRegularFileIfPresent(workspace, uriFor(name))
        return await workspace.fs.readFile(uriFor(name))
      } catch (error) {
        if (isFileNotFound(error)) return undefined
        throw normalizeStorageError(error)
      }
    },
    write: async (name, data) => {
      try {
        await assertSafeRoots(workspace, safeRoots)
        await assertRegularFileIfPresent(workspace, uriFor(name))
        await workspace.fs.writeFile(uriFor(name), data)
        await assertRegularFileIfPresent(workspace, uriFor(name))
      } catch (error) {
        throw normalizeStorageError(error)
      }
    },
    rename: async (sourceName, destinationName, overwrite) => {
      try {
        await assertSafeRoots(workspace, safeRoots)
        await assertRegularFileIfPresent(workspace, uriFor(sourceName))
        await assertRegularFileIfPresent(workspace, uriFor(destinationName))
        await workspace.fs.rename(uriFor(sourceName), uriFor(destinationName), { overwrite })
        await assertRegularFileIfPresent(workspace, uriFor(destinationName))
      } catch (error) {
        throw normalizeStorageError(error)
      }
    },
    delete: async (name) => {
      try {
        await assertSafeRoots(workspace, safeRoots)
        await assertRegularFileIfPresent(workspace, uriFor(name))
        await workspace.fs.delete(uriFor(name), { recursive: false, useTrash: false })
      } catch (error) {
        if (isFileNotFound(error)) return
        throw normalizeStorageError(error)
      }
    },
  }
}

async function assertSafeRoots(workspace: typeof vscode.workspace, roots: readonly string[]): Promise<void> {
  for (const root of roots) {
    try {
      const stat = await workspace.fs.stat(vscode.Uri.file(root))
      if ((stat.type & vscode.FileType.SymbolicLink) !== 0) throw pathNotAllowed()
    } catch (error) {
      if (error instanceof AppError) throw error
      if (isFileNotFound(error)) continue
      throw storageError(error)
    }
  }
}

async function assertRegularFileIfPresent(
  workspace: typeof vscode.workspace,
  uri: vscode.Uri,
): Promise<void> {
  try {
    const stat = await workspace.fs.stat(uri)
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) throw pathNotAllowed()
    if ((stat.type & vscode.FileType.File) === 0) throw storageError(new Error('Not a regular file.'))
  } catch (error) {
    if (error instanceof AppError) throw error
    if (isFileNotFound(error)) return
    throw storageError(error)
  }
}

function assertSafeName(name: string): void {
  if (
    name.trim() === '' ||
    name === '.' ||
    name === '..' ||
    path.basename(name) !== name ||
    name.includes('/') ||
    name.includes('\\') ||
    path.isAbsolute(name)
  )
    throw pathNotAllowed()
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'FileNotFound'
  )
}

function storageError(error: unknown): AppError {
  return new AppError({
    code: 'STORAGE_CORRUPT',
    message: 'Prompt template storage could not access the local file.',
    retryable: true,
    cause: error,
  })
}

function pathNotAllowed(): AppError {
  return new AppError({
    code: 'PATH_NOT_ALLOWED',
    message: 'Prompt template storage cannot use a symbolic link or nested file name.',
    retryable: false,
  })
}

function normalizeStorageError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError({
        code: 'STORAGE_CORRUPT',
        message: 'Prompt template storage could not access the local file.',
        retryable: true,
        cause: error,
      })
}
