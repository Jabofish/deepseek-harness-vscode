import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { link, open, rename, stat, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { AppError, type ExportRepository, type SessionExportOptions } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'

export interface ExportFileSystem {
  stat(path: string): Promise<{ isDirectory(): boolean }>
  rename(source: string, destination: string): Promise<void>
  unlink(path: string): Promise<void>
  link(source: string, destination: string): Promise<void>
}

const nodeFileSystem: ExportFileSystem = { stat, rename, unlink, link }

export class Rc6ExportRepository implements ExportRepository {
  public constructor(
    private readonly transport: DshTransport,
    private readonly fileSystem: ExportFileSystem = nodeFileSystem,
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
    await pipeText(source, destination, signal)
  }

  private async writeStream(
    destination: string,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    const source = Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>)
    await pipe(source, destination, signal)
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
      { sessionId, maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
      signal,
    )
    if (
      typeof value !== 'object' ||
      value === null ||
      !Array.isArray(value.events) ||
      (value.hasMore !== undefined && typeof value.hasMore !== 'boolean')
    )
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned an invalid session history for export.',
        retryable: false,
      })
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

export async function writeExportAtomically(
  destination: string,
  produce: (temporaryPath: string, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
  overwriteConfirmed = false,
  fileSystem: ExportFileSystem = nodeFileSystem,
): Promise<void> {
  throwIfAborted(signal)
  const temporaryPath = await reserveTemporaryPath(destination)
  let temporaryOwned = true
  let backupPath: string | undefined

  try {
    await produce(temporaryPath, signal)
    throwIfAborted(signal)
    await syncFile(temporaryPath)

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
      await fileSystem.rename(destination, backupPath)
      try {
        await fileSystem.rename(temporaryPath, destination)
        temporaryOwned = false
      } catch (error) {
        try {
          await fileSystem.rename(backupPath, destination)
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
      // A hard link is the only cross-platform no-overwrite commit available to
      // Node here. It also closes the race between the existence check and commit.
      await fileSystem.link(temporaryPath, destination)
      await fileSystem.unlink(temporaryPath)
      temporaryOwned = false
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST') || !overwriteConfirmed) throw error
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
    if (temporaryOwned) await unlink(temporaryPath).catch(() => undefined)
    // A remaining backup contains the user's original file. Never delete it as
    // generic failure cleanup; leaving it recoverable is safer than data loss.
  }
}

async function pipeText(
  source: Iterable<string> | AsyncIterable<string>,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await pipe(Readable.from(source), destination, signal)
}

async function pipe(source: Readable, destination: string, signal?: AbortSignal): Promise<void> {
  const writer = createWriteStream(destination, { flags: 'w' })
  if (signal === undefined) {
    await pipeline(source, writer)
  } else {
    await pipeline(source, writer, { signal })
  }
}

async function reserveTemporaryPath(destination: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporaryPath = `${destination}.dsh-vscode-${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let created = false
    try {
      handle = await open(temporaryPath, 'wx')
      created = true
      await handle.close()
      return temporaryPath
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (created) await unlink(temporaryPath).catch(() => undefined)
      if (isErrorCode(error, 'EEXIST') && !created) continue
      throw error
    }
  }
  throw new AppError({
    code: 'EXPORT_FAILED',
    message: 'Could not reserve a temporary export file.',
    retryable: true,
  })
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readDestinationInfo(
  destination: string,
  fileSystem: ExportFileSystem,
): Promise<{ isDirectory(): boolean } | undefined> {
  try {
    return await fileSystem.stat(destination)
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined
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
    if (!includeReasoning && isReasoningEvent(event)) continue
    if (emitted) yield ',\n'
    const serialized = JSON.stringify(includeAttachments ? event : stripAttachments(event), null, 2) ?? 'null'
    yield indent(serialized, 2)
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
    if (!includeReasoning && isReasoningEvent(event)) continue
    const value = asRecord(includeAttachments ? event : stripAttachments(event))
    const type = eventType(value)
    const text = typeof value.text === 'string' ? value.text : (JSON.stringify(value) ?? '')
    yield `### ${type}\n\n${text}\n\n`
  }
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

function isReasoningEvent(event: unknown): boolean {
  return /reasoning/i.test(eventType(asRecord(event)))
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
