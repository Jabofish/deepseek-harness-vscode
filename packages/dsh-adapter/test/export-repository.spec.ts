import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, type SessionExportOptions } from '@dsh-vscode/domain'

import type { DshTransport, ExportFileSystem } from '../src/index.js'
import { Rc6ExportRepository } from '../src/index.js'

const temporaryRoots: string[] = []

const nodeFileSystem: ExportFileSystem = {
  stat,
  rename: async (source, destination, overwrite = false) => {
    if (overwrite) await unlink(destination).catch(() => undefined)
    await rename(source, destination)
  },
  unlink,
  writeFile: (filePath, data) => fsWriteFile(filePath, data),
}

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
        hasMore: false,
      }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('json', false), destination)

    await expect(readFile(destination, 'utf8')).resolves.toBe(
      '[\n  {\n    "type": "message.user",\n    "text": "Hello"\n  }\n]',
    )
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })

  it('excludes canonical rc.6 reasoning rows and reasoning blocks from a JSON export', async () => {
    const destination = await destinationPath('canonical-reasoning.json')
    const repository = new Rc6ExportRepository(
      createTransport({ events: canonicalReasoningRows(), hasMore: false }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('json', false), destination)

    const exported = await readFile(destination, 'utf8')
    expect(exported).not.toContain('private reasoning')
    const rows = JSON.parse(exported) as readonly unknown[]
    expect(rows).toHaveLength(2)
    const message = (rows[1] as { event: { data: { message: { content: readonly unknown[] } } } }).event.data
      .message
    expect(message.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('keeps canonical rc.6 reasoning rows when the export asks for reasoning', async () => {
    const destination = await destinationPath('canonical-reasoning-included.json')
    const repository = new Rc6ExportRepository(
      createTransport({ events: canonicalReasoningRows(), hasMore: false }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('json', true), destination)

    const exported = await readFile(destination, 'utf8')
    expect(exported).toContain('private reasoning')
    const rows = JSON.parse(exported) as readonly unknown[]
    expect(rows).toHaveLength(3)
  })

  it('excludes canonical rc.6 reasoning from a Markdown export', async () => {
    const destination = await destinationPath('canonical-reasoning.md')
    const repository = new Rc6ExportRepository(
      createTransport({ events: canonicalReasoningRows(), hasMore: false }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('markdown', false), destination)

    const exported = await readFile(destination, 'utf8')
    expect(exported).not.toContain('private reasoning')
    expect(exported).toContain('Hello')
  })

  it('keeps tool arguments and visible text while stripping embedded reasoning fields', async () => {
    const destination = await destinationPath('canonical-reasoning-attempt.json')
    const repository = new Rc6ExportRepository(
      createTransport({
        events: [
          {
            event: {
              type: 'tool/call',
              seq: 1,
              time: 1,
              data: {
                turn: 1,
                step: 1,
                callId: 'call-1',
                name: 'search',
                arguments: '{"reasoning":"a tool argument named reasoning"}',
              },
            },
          },
          {
            event: {
              type: 'assistant/attempt',
              seq: 2,
              time: 2,
              data: {
                turn: 1,
                step: 1,
                stream: [
                  { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
                  { type: 'text-delta', index: 1, text: 'Hello' },
                ],
              },
            },
          },
          {
            event: {
              type: 'assistant/message',
              seq: 3,
              time: 3,
              data: {
                turn: 1,
                step: 1,
                reasoning: 'private reasoning',
                message: {
                  id: 'm1',
                  role: 'assistant',
                  source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
                  reasoning_content: 'private reasoning',
                  content: [{ type: 'text', text: 'Hello' }],
                },
              },
            },
          },
        ],
        hasMore: false,
      }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('json', false), destination)

    const exported = await readFile(destination, 'utf8')
    expect(exported).not.toContain('private reasoning')
    const rows = JSON.parse(exported) as readonly Record<string, unknown>[]
    expect(rows).toHaveLength(3)
    const attempt = rows[1] as { event: { data: { stream: readonly unknown[] } } }
    expect(attempt.event.data.stream).toEqual([{ type: 'text-delta', index: 1, text: 'Hello' }])
    const toolCall = rows[0] as { event: { data: { arguments: string } } }
    expect(toolCall.event.data.arguments).toBe('{"reasoning":"a tool argument named reasoning"}')
    const message = rows[2] as { event: { data: { message: Record<string, unknown> } } }
    expect(message.event.data.message.reasoning_content).toBeUndefined()
    expect(message.event.data.message.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('applies the attachment and reasoning exclusions in one pass', async () => {
    const destination = await destinationPath('canonical-reasoning-attachments.json')
    const repository = new Rc6ExportRepository(
      createTransport({
        events: [
          {
            event: {
              type: 'assistant/message',
              seq: 1,
              time: 1,
              data: {
                turn: 1,
                step: 1,
                message: {
                  id: 'm1',
                  role: 'assistant',
                  source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
                  content: [
                    { type: 'reasoning', text: 'private reasoning' },
                    { type: 'text', text: 'Hello' },
                    {
                      type: 'image',
                      attachment: {
                        attachmentId: 'a1',
                        mediaType: 'image/png',
                        bytes: 3,
                        width: 1,
                        height: 1,
                      },
                    },
                  ],
                },
              },
            },
          },
          // Older rc.6-compatible rows carried inline media instead of a
          // reference, and the attachment exclusion still has to scrub them.
          { type: 'image', seq: 2, uri: 'data:image/png;base64,aGVsbG8=', data: 'aGVsbG8=' },
        ],
        hasMore: false,
      }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('json', false, false), destination)

    const exported = await readFile(destination, 'utf8')
    expect(exported).not.toContain('private reasoning')
    expect(exported).not.toContain('aGVsbG8=')
    expect(exported).toContain('[attachment omitted]')
    const rows = JSON.parse(exported) as readonly Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    const blocks = (rows[0] as { event: { data: { message: { content: readonly unknown[] } } } }).event.data
      .message.content
    expect(blocks.map((block) => (block as { type: string }).type)).toEqual(['text', 'image'])
  })

  it('never overwrites an existing destination without an explicit Host confirmation', async () => {
    const destination = await destinationPath('existing.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const repository = new Rc6ExportRepository(
      createTransport({ events: [{ type: 'message.user' }], hasMore: false }),
      nodeFileSystem,
    )

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
    const repository = new Rc6ExportRepository(createTransport(undefined, failure), nodeFileSystem)

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toBe(failure)
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
  })

  it('rejects a malformed history value without touching the destination', async () => {
    const destination = await destinationPath('malformed-history.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const repository = new Rc6ExportRepository(createTransport(null), nodeFileSystem)

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
  })

  it('rejects a history page missing the required hasMore flag', async () => {
    const destination = await destinationPath('missing-history-flag.json')
    const repository = new Rc6ExportRepository(createTransport({ events: [] }), nodeFileSystem)

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a history page containing a malformed event row', async () => {
    const destination = await destinationPath('malformed-history-row.json')
    const repository = new Rc6ExportRepository(
      createTransport({ events: [null], hasMore: false }),
      nodeFileSystem,
    )

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a canonical event row that would otherwise be exported with synthetic state', async () => {
    const destination = await destinationPath('malformed-canonical-history-row.json')
    const repository = new Rc6ExportRepository(
      createTransport({
        events: [
          {
            event: {
              type: 'assistant/message',
              seq: 1,
              time: 1,
              data: { turn: 1, step: 1, markdown: 'not canonical' },
            },
          },
        ],
        hasMore: false,
      }),
      nodeFileSystem,
    )

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replaces a confirmed destination and restores the original when the commit rename fails', async () => {
    const destination = await destinationPath('rollback.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const renames = vi.fn<ExportFileSystem['rename']>(async (source, target, overwrite = false) => {
      if (renames.mock.calls.length === 2) throw new Error('commit rename failed')
      await nodeFileSystem.rename(source, target, overwrite)
    })
    const fileSystem: ExportFileSystem = { ...nodeFileSystem, rename: renames }
    const repository = new Rc6ExportRepository(
      createTransport({ events: [{ type: 'message.user', text: 'replacement' }], hasMore: false }),
      fileSystem,
    )

    await expect(
      repository.exportSession(exportOptions('json', true), destination, undefined, true),
    ).rejects.toMatchObject({ code: 'EXPORT_FAILED' })
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
    await expect(temporaryFiles(destination)).resolves.toEqual([])
    expect(renames).toHaveBeenCalledTimes(3)
  })

  it.each(['EEXIST', 'FileExists'])(
    'recovers a confirmed export when the destination appears as a %s commit failure',
    async (code) => {
      const destination = await destinationPath('raced.json')
      let destinationVisible = false
      const fileSystem: ExportFileSystem = {
        ...nodeFileSystem,
        stat: (filePath) =>
          !destinationVisible && filePath === destination
            ? Promise.reject(Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' }))
            : nodeFileSystem.stat(filePath),
        rename: async (source, target, overwrite = false) => {
          if (!destinationVisible && target === destination) {
            destinationVisible = true
            await writeFile(destination, 'created after the check', 'utf8')
            throw Object.assign(new Error(code), { code })
          }
          await nodeFileSystem.rename(source, target, overwrite)
        },
      }
      const repository = new Rc6ExportRepository(
        createTransport({ events: [{ type: 'message.user', text: 'replacement' }], hasMore: false }),
        fileSystem,
      )

      await repository.exportSession(exportOptions('json', true), destination, undefined, true)

      await expect(readFile(destination, 'utf8')).resolves.toContain('replacement')
      await expect(temporaryFiles(destination)).resolves.toEqual([])
    },
  )

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
    const repository = new Rc6ExportRepository(
      {
        ...createTransport(undefined),
        downloadSessionLog,
      },
      nodeFileSystem,
    )

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
    const repository = new Rc6ExportRepository(
      {
        ...createTransport(undefined),
        downloadSessionLog,
      },
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('zip', true), destination)

    expect(downloadSessionLog).toHaveBeenCalledWith('s1', false, undefined)
    await expect(readFile(destination)).resolves.toEqual(Buffer.from([1, 2, 3]))
  })

  it('rejects a ZIP request that asks to omit attachments because rc.6 cannot express that option', async () => {
    const destination = await destinationPath('without-attachments.zip')
    const downloadSessionLog = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1]))))
    const repository = new Rc6ExportRepository(
      {
        ...createTransport(undefined),
        downloadSessionLog,
      },
      nodeFileSystem,
    )

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
    const repository = new Rc6ExportRepository(
      {
        ...createTransport(undefined),
        downloadSessionLog,
      },
      nodeFileSystem,
    )

    await expect(repository.exportSession(exportOptions('zip', false), destination)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(downloadSessionLog).not.toHaveBeenCalled()
  })

  it('maps cancellation to a stable error and leaves no temporary file', async () => {
    const destination = await destinationPath('cancelled.json')
    const controller = new AbortController()
    controller.abort()
    const repository = new Rc6ExportRepository(
      createTransport({ events: [{ type: 'message.user' }], hasMore: false }),
      nodeFileSystem,
    )

    await expect(
      repository.exportSession(exportOptions('json', true), destination, controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })
})

/**
 * Real rc.6 history rows carry reasoning inside the payload: a streamed
 * `assistant/chunk` with a `reasoning-delta` chunk, and an `assistant/message`
 * whose content mixes a `reasoning` block with the visible `text` block. The
 * row type never contains "reasoning", so the row shape is what the filter
 * must key on.
 */
function canonicalReasoningRows(): readonly unknown[] {
  return [
    {
      event: {
        type: 'assistant/chunk',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' } },
      },
    },
    {
      event: {
        type: 'assistant/chunk',
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Hello' } },
      },
    },
    {
      event: {
        type: 'assistant/message',
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'm1',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            content: [
              { type: 'reasoning', text: 'private reasoning' },
              { type: 'text', text: 'Hello' },
            ],
          },
        },
      },
    },
  ]
}

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
