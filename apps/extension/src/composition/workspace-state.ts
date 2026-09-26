import { realpathSync } from 'node:fs'
import path from 'node:path'
import {
  type LegacyTemporaryWorkspaceReference,
  type StoredTemporaryWorkspace,
} from '../backend/temporary-workspace.js'
import { isTemporaryWorkspaceOwnershipToken } from '../backend/temporary-workspace-ownership.js'
import { isAbsoluteFilePath } from '../backend/runtime-paths.js'

export function readStoredTemporaryWorkspace(value: unknown): StoredTemporaryWorkspace | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = record.id
  const workspacePath = record.path
  const ownershipToken = record.ownershipToken
  if (
    typeof id !== 'string' ||
    id.trim() === '' ||
    typeof workspacePath !== 'string' ||
    workspacePath.trim() === '' ||
    !isAbsoluteFilePath(workspacePath) ||
    !isTemporaryWorkspaceOwnershipToken(ownershipToken)
  )
    return undefined
  return { id, path: workspacePath, ownershipToken }
}

export function readLegacyTemporaryWorkspace(value: unknown): LegacyTemporaryWorkspaceReference | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, 'ownershipToken')) return undefined
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

export function sameWorkspacePath(left: string, right: string): boolean {
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
