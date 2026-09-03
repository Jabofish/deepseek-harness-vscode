/** Host-owned autocomplete candidates for the official DSH `@` references. */

export interface FileReferenceCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface SessionReferenceCandidate {
  readonly sessionId: string
  readonly label: string
  readonly cwd?: string
  /** Whether the source session shares the requesting session's workspace. */
  readonly sameWorkspace: boolean
  readonly createdAt: number
  readonly mention: string
}

export interface ReferenceRepository {
  /** File and directory candidates are always relative to the session cwd. */
  listFiles(
    sessionId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly FileReferenceCandidate[]>
  /** Metadata-only cross-session candidates; message bodies never cross this port. */
  listSessions(
    sessionId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly SessionReferenceCandidate[]>
}
