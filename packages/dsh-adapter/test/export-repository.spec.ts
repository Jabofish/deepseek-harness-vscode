import { link, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, type SessionExportOptions } from '@dsh-vscode/domain'

import type { DshTransport, ExportFileSystem } from '../src/index.js'
import { Rc6ExportRepository } from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('Rc6ExportRepository', () => {
  it('writes JSON through a same-directory temporary file and filters reasoning when requested', async () => {
    const destination = await destinationPath('session.json')
    const repository = new Rc6ExportRepository(
      createTransport({
        events: [
          { type: 'reasoning/delta', text: 'private reasoning' },
          { type: 'message.user', text: 'Hello' },
        ],
      }),
    )

    await repository.exportSession(exportOptions('json', false), destination)

    await expect(readFile(destination, 'utf8')).resolves.toBe(
      '[\n  {\n    "type": "message.user",\n    "text": "Hello"\n  }\n]',
    )
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })

  it('never overwrites an existing destination without an explicit Host confirmation', async () => {
    const destination = await destinationPath('existing.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const repository = new Rc6ExportRepository(createTransport({ events: [{ type: 'message.user' }] }))

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toMatchObject({
      code: 'EXPORT_FAILED',
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })

  it('preserves an existing destination when the history request fails', async () => {
    const destination = await destinationPath('failed-history.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const failure = new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'backend unavailable',
      retryable: true,
    })
    const repository = new Rc6ExportRepository(createTransport(undefined, failure))

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toBe(failure)
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
  })

  it('rejects a malformed history value without touching the destination', async () => {
    const destination = await destinationPath('malformed-history.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const repository = new Rc6ExportRepository(createTransport(null))

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
  })

  it('replaces a confirmed destination and restores the original when the commit rename fails', async () => {
    const destination = await destinationPath('rollback.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const renames = vi.fn(async (source: string, target: string) => {
      if (renames.mock.calls.length === 2) throw new Error('commit rename failed')
      await rename(source, target)
    })
    const fileSystem: ExportFileSystem = { stat, rename: renames, unlink, link }
    const repository = new Rc6ExportRepository(
      createTransport({ events: [{ type: 'message.user', text: 'replacement' }] }),
      fileSystem,
    )

    await expect(
      repository.exportSession(exportOptions('json', true), destination, undefined, true),
    ).rejects.toMatchObject({ code: 'EXPORT_FAILED' })
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
    await expect(temporaryFiles(destination)).resolves.toEqual([])
    expect(renames).toHaveBeenCalledTimes(3)
  })

  it('cancels a failed ZIP source without deleting the existing destination', async () => {
    const destination = await destinationPath('failed.zip')
    await writeFile(destination, 'original bytes', 'utf8')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('source failed'))
      },
    })
    const downloadSessionLog = vi.fn(() => Promise.resolve(new Response(body)))
    const repository = new Rc6ExportRepository({
      ...createTransport(undefined),
      downloadSessionLog,
    })

    await expect(
      repository.exportSession(exportOptions('zip', true), destination, undefined, true),
    ).rejects.toMatchObject({
      code: 'EXPORT_FAILED',
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })

  it('uses the rc.6 descendant flag independently from the attachment option', async () => {
    const destination = await destinationPath('session.zip')
    const downloadSessionLog = vi.fn((_sessionId: string, _includeDescendants: boolean) =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
    )
    const repository = new Rc6ExportRepository({
      ...createTransport(undefined),
      downloadSessionLog,
    })

    await repository.exportSession(exportOptions('zip', true), destination)

    expect(downloadSessionLog).toHaveBeenCalledWith('s1', false, undefined)
    await expect(readFile(destination)).resolves.toEqual(Buffer.from([1, 2, 3]))
  })

  it('rejects a ZIP request that asks to omit attachments because rc.6 cannot express that option', async () => {
    const destination = await destinationPath('without-attachments.zip')
    const downloadSessionLog = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1]))))
    const repository = new Rc6ExportRepository({
      ...createTransport(undefined),
      downloadSessionLog,
    })

    await expect(
      repository.exportSession(exportOptions('zip', true, false), destination),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(downloadSessionLog).not.toHaveBeenCalled()
  })

  it('rejects a ZIP request that asks to omit reasoning because rc.6 returns the raw archive', async () => {
    const destination = await destinationPath('without-reasoning.zip')
    const downloadSessionLog = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1]))))
    const repository = new Rc6ExportRepository({
      ...createTransport(undefined),
      downloadSessionLog,
    })

    await expect(repository.exportSession(exportOptions('zip', false), destination)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(downloadSessionLog).not.toHaveBeenCalled()
  })

  it('maps cancellation to a stable error and leaves no temporary file', async () => {
    const destination = await destinationPath('cancelled.json')
    const controller = new AbortController()
    controller.abort()
    const repository = new Rc6ExportRepository(createTransport({ events: [{ type: 'message.user' }] }))

    await expect(
      repository.exportSession(exportOptions('json', true), destination, controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })
})

function exportOptions(
  format: SessionExportOptions['format'],
  includeReasoning: boolean,
  includeAttachments = true,
): SessionExportOptions {
  return {
    sessionId: 's1',
    format,
    includeAttachments,
    includeReasoning,
  }
}

function createTransport(response: unknown, failure?: AppError): DshTransport {
  return {
    request: <TResponse>() => {
      if (failure !== undefined) throw failure
      return Promise.resolve({ result: { ok: true, value: response } } as TResponse)
    },
    remoteRequest: <TResponse>() => Promise.resolve({ result: { ok: true, value: response } } as TResponse),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

async function destinationPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vscode-export-'))
  temporaryRoots.push(root)
  return join(root, name)
}

async function temporaryFiles(destination: string): Promise<string[]> {
  const name = destination.split(/[\\/]/).pop() ?? ''
  const names = await readdir(dirname(destination))
  return names.filter((entry) => entry.startsWith(`${name}.dsh-vscode-`))
}
