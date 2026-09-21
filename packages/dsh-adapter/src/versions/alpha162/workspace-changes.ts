import { AppError, type WorkspaceChangeSource } from '@dsh-vscode/domain'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'

function malformed(): never {
  throw new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'Malformed workspace change snapshot.',
    retryable: false,
  })
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export function workspaceChangeSource(transport: AlphaLoopbackApiClient): WorkspaceChangeSource {
  return {
    summary: async (sessionId, sequence, signal) => {
      const raw = await transport.readChanges('summary', sessionId, sequence, undefined, signal)
      if (raw === undefined) return undefined
      const value = recordOrUndefined(raw)
      if (
        !count(value?.turn) ||
        !count(value?.total) ||
        !Array.isArray(value?.files) ||
        value.files.length > 500
      )
        return malformed()
      return {
        turn: value.turn,
        total: value.total,
        files: value.files.map((rawFile: unknown) => {
          const file = recordOrUndefined(rawFile)
          if (
            typeof file?.path !== 'string' ||
            file.path.trim() === '' ||
            !count(file.added) ||
            !count(file.deleted) ||
            (file.binary !== undefined && file.binary !== true) ||
            (file.oversized !== undefined && file.oversized !== true)
          )
            return malformed()
          return {
            path: file.path,
            additions: file.added,
            deletions: file.deleted,
            diffAvailable: file.binary !== true && file.oversized !== true,
          }
        }),
      }
    },
    diff: async (sessionId, sequence, index, signal) => {
      const raw = await transport.readChanges('diff', sessionId, sequence, index, signal)
      if (raw === undefined) return undefined
      const value = recordOrUndefined(raw)
      if (value?.kind === 'binary' || value?.kind === 'oversized') return undefined
      if (value?.kind !== 'text' || !Array.isArray(value.hunks)) return malformed()
      return value.hunks
        .map((rawHunk: unknown) => {
          const hunk = recordOrUndefined(rawHunk)
          if (
            !count(hunk?.oldStart) ||
            !count(hunk?.oldLines) ||
            !count(hunk?.newStart) ||
            !count(hunk?.newLines) ||
            !Array.isArray(hunk.lines) ||
            !hunk.lines.every((line: unknown) => typeof line === 'string' && /^[ +\-\\]/u.test(line))
          )
            return malformed()
          return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`
        })
        .join('\n')
    },
  }
}
