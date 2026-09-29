import { createHash } from 'node:crypto'
import type * as vscode from 'vscode'

/** Opaque, stable identity shared by open-tab candidates and file context. */
export function openFileCandidateId(uri: vscode.Uri): string {
  return `dsh-open-file-${createHash('sha256').update(uri.toString(), 'utf8').digest('hex').slice(0, 32)}`
}
