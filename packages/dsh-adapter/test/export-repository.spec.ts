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
import type { AppError } from '@dsh-vscode/domain'
import { type SessionExportOptions } from '@dsh-vscode/domain'

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
  it('keeps chronological JSON output when bounded history spans multiple pages', async () => {
    const destination = await destinationPath('paged.json')
    let pages = 0
    const request = vi.fn(() => {
      const sequence = ++pages === 1 ? 2 : 1
      return Promise.resolve({
        result: {
          ok: true,
          value: {
            events: [{ type: 'message.user', seq: sequence, text: sequence === 1 ? 'older' : 'newer' }],
            hasMore: pages === 1,
          },
        },
      })
    })
    const repository = new Rc6ExportRepository(
      { ...createTransport(undefined), request } as DshTransport,
      nodeFileSystem,
    )
    await repository.exportSession(exportOptions('json', true), destination)
    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual([
      { type: 'message.user', seq: 1, text: 'older' },
      { type: 'message.user', seq: 2, text: 'newer' },
    ])
    expect(request).toHaveBeenCalledTimes(2)
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })

  it('stops after a page read is cancelled and leaves the destination intact', async () => {
    const destination = await destinationPath('cancelled-page.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const controller = new AbortController()
    const request = vi.fn(() => {
      controller.abort()
      return Promise.resolve({
        result: { ok: true, value: { events: [{ type: 'message.user', seq: 2 }], hasMore: true } },
      })
    })
    const repository = new Rc6ExportRepository(
      { ...createTransport(undefined), request } as DshTransport,
      nodeFileSystem,
    )
    await expect(
      repository.exportSession(exportOptions('json', true), destination, controller.signal, true),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(request).toHaveBeenCalledTimes(1)
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })

  it.each(['json', 'markdown'] as const)(
    'stops reading oversized %s history before requesting another page or touching the destination',
    async (format) => {
      const destination = await destinationPath(`oversized.${format}`)
      await writeFile(destination, 'original bytes', 'utf8')
      const text = 'x'.repeat(34 * 1024 * 1024)
      let pages = 0
      const request = vi.fn(() =>
        Promise.resolve({
          result: {
            ok: true,
            value: {
              events: [{ type: 'message.user', seq: 100 - ++pages, text }],
              hasMore: true,
            },
          },
        }),
      )
      const repository = new Rc6ExportRepository(
        { ...createTransport(undefined), request } as DshTransport,
        nodeFileSystem,
      )
      await expect(
        repository.exportSession(exportOptions(format, true), destination, undefined, true),
      ).rejects.toMatchObject({ code: 'EXPORT_FAILED', retryable: false })
      expect(request).toHaveBeenCalledTimes(2)
      await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
      await expect(temporaryFiles(destination)).resolves.toEqual([])
    },
  )

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

  it('keeps an inlined text-file body when the export includes attachments', async () => {
    const destination = await destinationPath('inlined-file-included.json')
    const repository = new Rc6ExportRepository(
      createTransport({ events: inlinedFileRows(), hasMore: false }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('json', false, true), destination)

    await expect(readFile(destination, 'utf8')).resolves.toContain('很长的正文')
  })

  it('renders message rows as prose in a Markdown export', async () => {
    const destination = await destinationPath('messages.md')
    const repository = new Rc6ExportRepository(
      createTransport({ events: messageRows(), hasMore: false }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('markdown', false), destination)

    const exported = await readFile(destination, 'utf8')
    expect(exported).toContain('### user/message\n\nHow do I export a session?')
    expect(exported).toContain('### assistant/message\n\nUse the export dialog.')
    expect(exported).not.toContain('weighing the options')
    // A row with no message text stays a machine record instead of prose.
    expect(exported).toContain('### tool/call')
    expect(exported).toContain('"callId":"c1"')
  })

  it('marks the attachments and images a Markdown export carries', async () => {
    const destination = await destinationPath('messages-attachments.md')
    const repository = new Rc6ExportRepository(
      createTransport({
        events: [
          ...inlinedFileRows(),
          {
            event: {
              type: 'assistant/message',
              seq: 2,
              time: 2,
              data: {
                turn: 1,
                step: 1,
                message: {
                  id: 'm1',
                  role: 'assistant',
                  source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
                  content: [
                    { type: 'text', text: 'Here is the diagram.' },
                    {
                      type: 'image',
                      attachment: {
                        attachmentId: 'a1',
                        mediaType: 'image/png',
                        bytes: 2048,
                        width: 4,
                        height: 4,
                        name: 'diagram.png',
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
        hasMore: false,
      }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('markdown', false), destination)

    const exported = await readFile(destination, 'utf8')
    // The inlined file body is included, so the envelope is projected as an
    // attachment name rather than as text: without a marker the file would be
    // missing from the readable export entirely.
    expect(exported).toContain('概括文件内容\n\n[attachment: 思路4.md]')
    expect(exported).toContain('Here is the diagram.\n\n[image: diagram.png (image/png, 2048 bytes)]')
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

  it('rejects a malformed history value without touching the destination', async () => {
    const destination = await destinationPath('malformed-history.json')
    await writeFile(destination, 'original bytes', 'utf8')
    const repository = new Rc6ExportRepository(createTransport(null), nodeFileSystem)

    await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('original bytes')
  })

  it('exports an unprojectable canonical row as a marked unreadable record instead of failing the session', async () => {
    const destination = await destinationPath('unreadable-canonical-history-row.json')
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
                markdown: 'payload the mapper rejects',
                authorization: 'secret-token',
              },
            },
          },
          {
            event: {
              type: 'user/message',
              seq: 2,
              time: 2,
              data: {
                id: 'u1',
                role: 'user',
                source: { kind: 'user' },
                content: [{ type: 'text', text: 'readable row' }],
              },
            },
          },
        ],
        hasMore: false,
      }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('json', true), destination)

    const written = JSON.parse(await readFile(destination, 'utf8')) as readonly Record<string, unknown>[]
    expect(written).toHaveLength(2)
    // The durable envelope survives, so the export stays sequence-complete and
    // a reader can still see which row could not be projected.
    expect(written[0]).toMatchObject({
      event: { type: 'assistant/message', seq: 1, time: 1, unreadable: true },
    })
    // The payload is kept the way the transcript keeps it, with sensitive
    // fields dropped, so a data rescue loses no more than the UI does.
    expect(JSON.stringify(written[0])).toContain('payload the mapper rejects')
    expect(JSON.stringify(written[0])).not.toContain('secret-token')
    // A readable row in the same session is still exported normally.
    expect(written[1]).toMatchObject({ event: { type: 'user/message', seq: 2 } })
    expect(JSON.stringify(written[1])).toContain('readable row')
    await expect(temporaryFiles(destination)).resolves.toEqual([])
  })

  it('still applies the reasoning exclusion inside a marked unreadable row', async () => {
    const destination = await destinationPath('unreadable-canonical-reasoning.json')
    const repository = new Rc6ExportRepository(
      createTransport({
        events: [
          {
            event: {
              type: 'assistant/message',
              seq: 1,
              time: 1,
              data: { turn: 1, step: 1, markdown: 'visible', reasoning: 'private reasoning' },
            },
          },
        ],
        hasMore: false,
      }),
      nodeFileSystem,
    )

    await repository.exportSession(exportOptions('json', false), destination)

    const exported = await readFile(destination, 'utf8')
    expect(exported).toContain('unreadable')
    expect(exported).toContain('visible')
    expect(exported).not.toContain('private reasoning')
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
})

/**
 * Real rc.6 history rows carry reasoning inside the payload: a streamed
 * `assistant/chunk` with a `reasoning-delta` chunk, and an `assistant/message`
 * whose content mixes a `reasoning` block with the visible `text` block. The
 * row type never contains "reasoning", so the row shape is what the filter
 * must key on.
 */

/** A durable user message carrying an inlined text file, as rc.6 stores it. */
function inlinedFileRows(): readonly unknown[] {
  return [
    {
      event: {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          id: 'u1',
          role: 'user',
          source: { kind: 'user' },
          content: [
            { type: 'text', text: '概括文件内容' },
            {
              type: 'text',
              text: '\n\nAttached file: 思路4.md\n\n# 很长的正文\n\nEnd of attached file: 思路4.md',
            },
          ],
        },
      },
    },
  ]
}

/** Canonical message rows plus one tool row, as rc.6 stores them. */
function messageRows(): readonly unknown[] {
  return [
    {
      event: {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          id: 'u1',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'How do I export a session?' }],
        },
      },
    },
    {
      event: {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'm1',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            content: [
              { type: 'reasoning', text: 'weighing the options' },
              { type: 'text', text: 'Use the export dialog.' },
            ],
          },
        },
      },
    },
    {
      event: {
        type: 'tool/call',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1, callId: 'c1', name: 'search', arguments: '{}' },
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

it('redacts an inlined text-file body from an export that excludes attachments', async () => {
  const destination = await destinationPath('inlined-file.json')
  const repository = new Rc6ExportRepository(
    createTransport({ events: inlinedFileRows(), hasMore: false }),
    nodeFileSystem,
  )

  await repository.exportSession(exportOptions('json', false, false), destination)

  const exported = await readFile(destination, 'utf8')
  expect(exported).not.toContain('很长的正文')
  expect(exported).toContain('思路4.md')
  expect(exported).toContain('[attachment omitted]')

  const markdownDestination = await destinationPath('inlined-file.md')
  await repository.exportSession(exportOptions('markdown', false, false), markdownDestination)
  const markdown = await readFile(markdownDestination, 'utf8')
  expect(markdown).not.toContain('很长的正文')
  expect(markdown).toContain('思路4.md')
})

it('still rejects a history row whose durable envelope is corrupt', async () => {
  const destination = await destinationPath('corrupt-envelope-row.json')
  const repository = new Rc6ExportRepository(
    createTransport({
      events: [{ event: { type: 'assistant/message', seq: '1', time: 1, data: {} } }],
      hasMore: false,
    }),
    nodeFileSystem,
  )

  await expect(repository.exportSession(exportOptions('json', true), destination)).rejects.toMatchObject({
    code: 'PROTOCOL_ERROR',
  })
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})
