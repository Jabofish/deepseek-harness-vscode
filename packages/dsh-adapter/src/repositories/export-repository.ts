import { AppError, type ExportRepository, type SessionExportOptions } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { assertCanonicalSessionEvent } from '../versions/rc6/mapper.js'

export interface ExportFileSystem {
  stat(path: string): Promise<{ isDirectory(): boolean }>
  rename(source: string, destination: string, overwrite?: boolean): Promise<void>
  unlink(path: string): Promise<void>
  writeFile(path: string, data: Uint8Array): Promise<void>
}

const unavailableFileSystem: ExportFileSystem = {
  stat: () => Promise.reject(unavailable('authorized export file system')),
  rename: () => Promise.reject(unavailable('authorized export file system')),
  unlink: () => Promise.reject(unavailable('authorized export file system')),
  writeFile: () => Promise.reject(unavailable('authorized export file system')),
}

/** Export streams the entire history; larger pages halve the roundtrips. */
const EXPORT_HISTORY_PAGE_MESSAGES = 200
export class Rc6ExportRepository implements ExportRepository {
  public constructor(
    private readonly transport: DshTransport,
    private readonly fileSystem: ExportFileSystem = unavailableFileSystem,
  ) {}

  public async exportSession(
    options: SessionExportOptions,
    destination: string,
    signal?: AbortSignal,
    overwriteConfirmed = false,
  ): Promise<void> {
    try {
      if (options.format === 'zip') {
        if (!options.includeAttachments) throw unavailable('ZIP export without attachments')
        if (!options.includeReasoning) throw unavailable('ZIP export without reasoning')
        if (this.transport.downloadSessionLog === undefined) throw unavailable('session ZIP export')

        // rc.6's boolean is `includeDescendants`; the root archive always includes
        // its referenced media. It must not be inferred from the UI attachment flag.
        const response = await this.transport.downloadSessionLog(options.sessionId, false, signal)
        const body = response.body
        if (body === null) throw unavailable('empty session export response')
        await writeExportAtomically(
          destination,
          (temporaryPath, writeSignal) => this.writeStream(temporaryPath, body, writeSignal),
          signal,
          overwriteConfirmed,
          this.fileSystem,
        )
        return
      }

      const events = await readExportHistory(this.transport, options.sessionId, signal)

      await writeExportAtomically(
        destination,
        (temporaryPath, writeSignal) => this.writeHistory(temporaryPath, events, options, writeSignal),
        signal,
        overwriteConfirmed,
        this.fileSystem,
      )
    } catch (error) {
      throw mapExportError(error, signal)
    }
  }

  private async writeHistory(
    destination: string,
    events: readonly unknown[],
    options: SessionExportOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const source =
      options.format === 'json'
        ? jsonChunks(events, options.includeReasoning, options.includeAttachments)
        : markdownChunks(events, options.includeReasoning, options.includeAttachments)
    const chunks: string[] = []
    for (const chunk of source) {
      throwIfAborted(signal)
      chunks.push(chunk)
    }
    await this.fileSystem.writeFile(destination, new TextEncoder().encode(chunks.join('')))
  }

  private async writeStream(
    destination: string,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    try {
      while (true) {
        throwIfAborted(signal)
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
    const data = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    await this.fileSystem.writeFile(destination, data)
  }
}

async function readExportHistory(
  transport: DshTransport,
  sessionId: string,
  signal?: AbortSignal,
): Promise<readonly unknown[]> {
  const pages: unknown[][] = []
  let beforeSeq: number | undefined
  for (let page = 0; page < 100; page += 1) {
    const value = await callRpc<{ events: unknown[]; hasMore: boolean }>(
      transport,
      'session.history',
      {
        sessionId,
        maxMessages: EXPORT_HISTORY_PAGE_MESSAGES,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      },
      signal,
    )
    if (
      typeof value !== 'object' ||
      value === null ||
      !Array.isArray(value.events) ||
      typeof value.hasMore !== 'boolean'
    )
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned an invalid session history for export.',
        retryable: false,
      })
    for (const entry of value.events) validateExportHistoryEntry(entry)
    pages.push(value.events)
    if (!value.hasMore) return pages.reverse().flat()
    const sequences = value.events.flatMap((entry) => {
      const record = asRecord(entry)
      const event = asRecord(record.event)
      const sequence = event.seq ?? record.seq
      return typeof sequence === 'number' && Number.isSafeInteger(sequence) ? [sequence] : []
    })
    const oldest = sequences.length === 0 ? undefined : Math.min(...sequences)
    if (oldest === undefined || (beforeSeq !== undefined && oldest >= beforeSeq))
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned a non-progressing session history page.',
        retryable: false,
      })
    beforeSeq = oldest
  }
  throw new AppError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'The session is too large for the bounded export reader.',
    retryable: false,
  })
}

/** Keep malformed history rows from being serialized as a successful export. */
function validateExportHistoryEntry(value: unknown): void {
  const record = asRecordOrUndefined(value)
  if (record === undefined) throw malformedExportHistoryEntry()
  const nested = record.event
  if (nested !== undefined) {
    const event = asRecordOrUndefined(nested)
    if (
      event === undefined ||
      typeof event.type !== 'string' ||
      event.type.trim() === '' ||
      !Number.isSafeInteger(event.seq) ||
      (event.seq as number) < 0 ||
      typeof event.time !== 'number' ||
      !Number.isFinite(event.time)
    )
      throw malformedExportHistoryEntry()
    try {
      assertCanonicalSessionEvent(event.type, event)
    } catch {
      throw malformedExportHistoryEntry()
    }
    return
  }
  // Older rc.6-compatible fixtures returned the raw event object directly.
  // Preserve that compatibility while still requiring an identifiable row.
  if (typeof record.type !== 'string' || record.type.trim() === '') throw malformedExportHistoryEntry()
}

function malformedExportHistoryEntry(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned an invalid session history event for export.',
    retryable: false,
  })
}

export async function writeExportAtomically(
  destination: string,
  produce: (temporaryPath: string, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
  overwriteConfirmed = false,
  fileSystem: ExportFileSystem = unavailableFileSystem,
): Promise<void> {
  throwIfAborted(signal)
  const temporaryPath = await reserveTemporaryPath(destination, fileSystem)
  let temporaryOwned = true
  let backupPath: string | undefined

  try {
    await produce(temporaryPath, signal)
    throwIfAborted(signal)

    let destinationInfo = await readDestinationInfo(destination, fileSystem)
    if (destinationInfo?.isDirectory() === true)
      throw new AppError({
        code: 'EXPORT_FAILED',
        message: 'The export destination is a directory.',
        retryable: false,
      })
    if (destinationInfo !== undefined && !overwriteConfirmed)
      throw new AppError({
        code: 'EXPORT_FAILED',
        message: 'The export destination already exists; overwrite confirmation is required.',
        retryable: false,
      })

    const replaceExisting = async (): Promise<void> => {
      backupPath = `${temporaryPath}.backup`
      await fileSystem.rename(destination, backupPath, false)
      try {
        await fileSystem.rename(temporaryPath, destination, false)
        temporaryOwned = false
      } catch (error) {
        try {
          await fileSystem.rename(backupPath, destination, true)
          backupPath = undefined
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            'The export failed and the original destination could not be restored.',
            { cause: restoreError },
          )
        }
        throw error
      }
      await fileSystem.unlink(backupPath)
      backupPath = undefined
    }

    if (destinationInfo !== undefined) {
      await replaceExisting()
      return
    }

    try {
      // The Extension Host's authorized file system provides the commit
      // operation. The adapter never opens or writes a platform path itself.
      await fileSystem.rename(temporaryPath, destination, false)
      temporaryOwned = false
    } catch (error) {
      if (!isCommitConflict(error) || !overwriteConfirmed) throw error
      destinationInfo = await readDestinationInfo(destination, fileSystem)
      if (destinationInfo?.isDirectory() === true)
        throw new AppError({
          code: 'EXPORT_FAILED',
          message: 'The export destination is a directory.',
          retryable: false,
        })
      if (destinationInfo === undefined) throw error
      await replaceExisting()
    }
  } finally {
    if (temporaryOwned) await fileSystem.unlink(temporaryPath).catch(() => undefined)
    // A remaining backup contains the user's original file. Never delete it as
    // generic failure cleanup; leaving it recoverable is safer than data loss.
  }
}

async function reserveTemporaryPath(destination: string, fileSystem: ExportFileSystem): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporaryPath = `${destination}.dsh-vscode-${globalThis.crypto.randomUUID()}.tmp`
    try {
      await fileSystem.stat(temporaryPath)
      continue
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      return temporaryPath
    }
  }
  throw new AppError({
    code: 'EXPORT_FAILED',
    message: 'Could not reserve a temporary export file.',
    retryable: true,
  })
}

async function readDestinationInfo(
  destination: string,
  fileSystem: ExportFileSystem,
): Promise<{ isDirectory(): boolean } | undefined> {
  try {
    return await fileSystem.stat(destination)
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}

function* jsonChunks(
  events: readonly unknown[],
  includeReasoning: boolean,
  includeAttachments: boolean,
): Iterable<string> {
  let emitted = false
  yield '[\n'
  for (const event of events) {
    const projected = exportableEvent(event, includeReasoning, includeAttachments)
    if (projected === undefined) continue
    if (emitted) yield ',\n'
    yield indent(JSON.stringify(projected, null, 2) ?? 'null', 2)
    emitted = true
  }
  yield emitted ? '\n]' : ']'
}

function* markdownChunks(
  events: readonly unknown[],
  includeReasoning: boolean,
  includeAttachments: boolean,
): Iterable<string> {
  for (const event of events) {
    const projected = exportableEvent(event, includeReasoning, includeAttachments)
    if (projected === undefined) continue
    const value = asRecord(projected)
    const type = eventType(value)
    const text = typeof value.text === 'string' ? value.text : (JSON.stringify(value) ?? '')
    yield `### ${type}\n\n${text}\n\n`
  }
}

/** Returns `undefined` for a row that is dropped from the export entirely. */
function exportableEvent(event: unknown, includeReasoning: boolean, includeAttachments: boolean): unknown {
  if (!includeReasoning && isReasoningEvent(event)) return undefined
  const value = includeReasoning ? event : stripReasoning(event)
  return includeAttachments ? value : stripAttachments(value)
}

function stripAttachments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAttachments)
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return value
  const result: Record<string, unknown> = {}
  const image = record.type === 'image'
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'attachments') {
      result[key] = []
      continue
    }
    if (image && (key === 'data' || key === 'uri')) {
      result[key] = '[attachment omitted]'
      continue
    }
    result[key] = stripAttachments(entry)
  }
  return result
}

/** Content blocks and stream chunks the mapper projects as private reasoning. */
const REASONING_BLOCK_TYPES = new Set(['reasoning', 'reasoning-delta'])
/** Message fields the mapper reads back as reasoning text. */
const REASONING_KEYS = new Set(['reasoning', 'reasoningContent', 'reasoning_content'])

/**
 * A row is pure reasoning when its own type says so (legacy/synthetic rows) or
 * when it is an rc.6 streamed reasoning delta, which carries nothing else.
 * Rows that merely embed reasoning are kept and stripped instead, so the
 * visible answer is not lost with them.
 */
function isReasoningEvent(event: unknown): boolean {
  const record = asRecord(event)
  if (/reasoning/i.test(eventType(record))) return true
  const nested = asRecordOrUndefined(record.event) ?? record
  return asRecordOrUndefined(asRecord(nested.data).chunk)?.type === 'reasoning-delta'
}

/** Returns `undefined` for a value that is reasoning and nothing else. */
function stripReasoning(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReasoning).filter((entry) => entry !== undefined)
  const record = asRecordOrUndefined(value)
  if (record === undefined) return value
  if (typeof record.type === 'string' && REASONING_BLOCK_TYPES.has(record.type)) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (REASONING_KEYS.has(key)) continue
    const stripped = stripReasoning(entry)
    if (stripped !== undefined) result[key] = stripped
  }
  return result
}

function eventType(value: Record<string, unknown>): string {
  if (typeof value.type === 'string') return value.type
  const nested = asRecord(value.event)
  return typeof nested.type === 'string' ? nested.type : 'event'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw signal.reason ?? new DOMException('The export was cancelled.', 'AbortError')
}

function mapExportError(error: unknown, signal: AbortSignal | undefined): AppError {
  if (signal?.aborted === true)
    return new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The session export was cancelled.',
      retryable: false,
      cause: error,
    })
  if (error instanceof AppError) return error
  return new AppError({
    code: 'EXPORT_FAILED',
    message: 'The DSH session export could not be written.',
    retryable: true,
    cause: error,
  })
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function isNotFoundError(error: unknown): boolean {
  return isErrorCode(error, 'ENOENT') || isErrorCode(error, 'FileNotFound')
}

/** Node reports an occupied destination as EEXIST; `vscode.workspace.fs` as FileExists. */
function isCommitConflict(error: unknown): boolean {
  return isErrorCode(error, 'EEXIST') || isErrorCode(error, 'FileExists')
}
