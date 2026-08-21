import {
  AppError,
  type FileReferenceCandidate,
  type ReferenceRepository,
  type SessionReferenceCandidate,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { unwrapRpcResultValue } from '../versions/rc6/rpc.js'

/** rc.8's browser-safe reference Remote projection. Older hosts simply reject the optional calls. */
export class Rc6ReferenceRepository implements ReferenceRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async listFiles(
    sessionId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly FileReferenceCandidate[]> {
    const result = await this.transport.remoteRequest<unknown>(
      'fileReferences/list',
      { agentId: sessionId, query },
      signal,
    )
    return parseFiles(unwrapRpcResultValue(result, 'fileReferences/list'))
  }

  public async listSessions(
    sessionId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly SessionReferenceCandidate[]> {
    const result = await this.transport.remoteRequest<unknown>(
      'sessionReferenceResolver/candidates',
      { agentId: sessionId, query },
      signal,
    )
    return parseSessions(unwrapRpcResultValue(result, 'sessionReferenceResolver/candidates'))
  }
}

function parseFiles(value: unknown): readonly FileReferenceCandidate[] {
  if (!Array.isArray(value)) throw malformed('file reference candidates')
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    if (
      typeof record.path !== 'string' ||
      record.path.trim() === '' ||
      record.path.length > 4_096 ||
      hasUnsafePathCharacters(record.path) ||
      (record.kind !== 'file' && record.kind !== 'directory')
    )
      return []
    return [{ path: record.path, kind: record.kind }]
  })
}

function hasUnsafePathCharacters(value: string): boolean {
  if (value.includes('"')) return true
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

function parseSessions(value: unknown): readonly SessionReferenceCandidate[] {
  if (!Array.isArray(value)) throw malformed('session reference candidates')
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    if (
      typeof record.sessionId !== 'string' ||
      record.sessionId.trim() === '' ||
      typeof record.label !== 'string' ||
      record.label.trim() === '' ||
      typeof record.mention !== 'string' ||
      !/^@\[[^\]\r\n]{1,512}\]\(dsh-session:[A-Za-z0-9_-]{1,512}\)$/u.test(record.mention) ||
      typeof record.createdAt !== 'number' ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt < 0 ||
      (record.cwd !== undefined && (typeof record.cwd !== 'string' || record.cwd.length > 4_096))
    )
      return []
    return [
      {
        sessionId: record.sessionId,
        label: record.label,
        ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
        createdAt: record.createdAt,
        mention: record.mention,
      },
    ]
  })
}

function malformed(kind: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned malformed ${kind}.`,
    retryable: false,
  })
}
