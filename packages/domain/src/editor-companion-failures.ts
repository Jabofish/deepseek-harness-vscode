import type { EditorCompanionFailure, EditorCompanionRequest } from './editor-companion.js'

/** Fixed guidance shared by the model and the public tool card; contains no raw tool data. */
export function editorCompanionFailureMessage(
  reason: EditorCompanionFailure,
  operation?: EditorCompanionRequest['kind'],
): string {
  if (
    operation === 'propose' &&
    ['timeout', 'cancelled', 'unavailable', 'invalid-response', 'stale-request'].includes(reason)
  )
    return 'Edit outcome unknown. Do not automatically resend. Read the file to verify; query get_edit_result if you have a proposalId.'
  switch (reason) {
    case 'not-bound':
      return 'Editor access is not connected to this session. Check Settings → General → Editor integration for the reason; retry after it is ready.'
    case 'denied':
      return 'This capability is disabled. Change it in Settings → General → Editor integration.'
    case 'no-editor':
      return operation === 'selection' || operation === 'state'
        ? 'No active editor. Open a file with vscode_open_file, then retry.'
        : 'No active editor. Supply a workspace-relative path.'
    case 'stale-document':
      return operation === 'propose'
        ? 'Document changed. Nothing was written. Read the current file before preparing another edit.'
        : 'Document changed. Read again without expectedVersion to obtain the current version.'
    case 'not-found':
      return operation === 'proposal'
        ? 'Unknown or expired proposalId. Use the ID returned by the edit, or read the file to verify.'
        : 'The requested file no longer exists. Check its path.'
    case 'file-access':
      return 'Cannot access this file. Check its permissions and that it is a regular file.'
    case 'invalid-range':
      return 'Start line or column is past EOF. Read from line 1 or use a valid position.'
    case 'workspace-mismatch':
      return 'File access is limited to folders open in this VS Code window. Open the folder, then retry.'
    case 'untrusted':
      return 'Trust this VS Code workspace, then retry. Use the access prompt or Settings → General → Editor integration → Manage workspace trust.'
    case 'limit':
      return 'Request exceeds a size limit. Use a smaller range or fewer edits.'
    case 'unsupported':
      return 'No language provider for this file. Use text search or enable its language extension.'
    case 'timeout':
      return 'VS Code did not answer in time. Retry the same request.'
    case 'busy':
      return 'Too many editor requests are in flight. Retry shortly.'
    case 'cancelled':
      return 'The request was cancelled.'
    case 'stale-request':
    case 'invalid-response':
      return 'Invalid editor reply. Retry the read; if it persists, repair in Settings → General → Editor integration.'
    case 'unavailable':
      return 'Editor connection is unavailable. Retry shortly; if it persists, reconnect DSH.'
  }
}
