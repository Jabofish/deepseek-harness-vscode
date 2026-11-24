import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import { createAttachmentRequestHandler } from './attachment-request-handler.js'

const native = vi.hoisted(() => ({
  pick: vi.fn(),
  stat: vi.fn(),
  read: vi.fn(),
  openDocument: vi.fn(),
  showDocument: vi.fn(),
}))
vi.mock('vscode', () => ({
  window: { showOpenDialog: native.pick, showTextDocument: native.showDocument },
  workspace: {
    fs: { stat: native.stat, readFile: native.read },
    openTextDocument: native.openDocument,
  },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
}))

beforeEach(() => {
  vi.resetAllMocks()
})

function fixture(): {
  readonly remember: Mock<(input: unknown) => unknown>
  readonly pick: (signal?: AbortSignal) => Promise<unknown>
} {
  const remember = vi.fn((input: unknown) => input)
  const handler = createAttachmentRequestHandler({
    attachmentTokens: { remember },
    backendService: { requireBackend: () => ({ sessions: { supportsFileUploads: true } }) },
  } as unknown as RequestGatewayDependencies)
  return {
    remember,
    pick: (signal = new AbortController().signal) =>
      handler({ type: 'attachment.pick', requestId: 'pick' }, signal),
  }
}

describe('native attachment picking across workspace and client filesystems', () => {
  it('reuses canonical ingest bytes while rejecting noncanonical Base64 and mismatched image signatures', async () => {
    const remember = vi.fn((input: unknown) => input)
    const handler = createAttachmentRequestHandler({
      attachmentTokens: { remember },
      backendService: { requireBackend: () => ({ sessions: { supportsFileUploads: true } }) },
    } as unknown as RequestGatewayDependencies)
    const payload = { name: 'image.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }
    expect(
      await handler(
        { type: 'attachment.ingest', requestId: 'ingest', payload },
        new AbortController().signal,
      ),
    ).toEqual({
      cancelled: false,
      attachment: { name: 'image.png', mimeType: 'image/png', dataUri: 'data:image/png;base64,iVBORw0KGgo=' },
    })
    for (const dataBase64 of [
      'iVBORw0KGgo',
      'iVBORw0KGgo=\n',
      Buffer.from('not an image').toString('base64'),
    ]) {
      await expect(
        handler(
          { type: 'attachment.ingest', requestId: 'invalid', payload: { ...payload, dataBase64 } },
          new AbortController().signal,
        ),
      ).rejects.toThrow()
    }
    expect(remember).toHaveBeenCalledTimes(1)
  })

  it.each(['file', 'vscode-remote', 'vscode-local'])(
    'reads the selected %s URI through its provider without exposing its authority or path',
    async (scheme) => {
      const selected = {
        scheme,
        authority: 'fixture-host',
        path: '/fixture/note.txt',
        fsPath: '/wrong-side/note.txt',
      }
      native.pick.mockResolvedValue([selected])
      native.stat.mockResolvedValue({ type: 1, size: 7 })
      native.read.mockResolvedValue(new TextEncoder().encode('fixture'))
      const f = fixture()
      expect(await f.pick()).toEqual({
        cancelled: false,
        attachment: {
          name: 'note.txt',
          mimeType: 'text/plain',
          dataUri: 'data:text/plain;base64,Zml4dHVyZQ==',
        },
      })
      expect(native.stat).toHaveBeenCalledExactlyOnceWith(selected)
      expect(native.read).toHaveBeenCalledExactlyOnceWith(selected)
    },
  )
  it('does not retain bytes when cancellation arrives during a provider read', async () => {
    const controller = new AbortController()
    native.pick.mockResolvedValue([{ scheme: 'vscode-local', path: '/fixture/note.txt' }])
    native.stat.mockResolvedValue({ type: 1, size: 7 })
    native.read.mockImplementation(() => {
      controller.abort()
      return Promise.resolve(new TextEncoder().encode('fixture'))
    })
    const f = fixture()
    await expect(f.pick(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.remember).not.toHaveBeenCalled()
  })
  it.each([
    { type: 2, size: 7 },
    { type: 65, size: 7 },
    { type: 1, size: 64 * 1024 * 1024 },
  ])('rejects an invalid selected resource before reading it (%j)', async (stat) => {
    native.pick.mockResolvedValue([{ scheme: 'vscode-local', path: '/fixture/note.txt' }])
    native.stat.mockResolvedValue(stat)
    await expect(fixture().pick()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(native.read).not.toHaveBeenCalled()
  })
  it('attaches every file of a multi-file selection', async () => {
    native.pick.mockResolvedValue([
      { scheme: 'file', path: '/fixture/a.txt' },
      { scheme: 'file', path: '/fixture/b.md' },
    ])
    native.stat.mockResolvedValue({ type: 1, size: 3 })
    native.read.mockResolvedValue(new TextEncoder().encode('abc'))
    const f = fixture()
    const result = (await f.pick()) as { attachment: unknown; attachments: readonly { name: string }[] }
    expect(result.attachments.map((entry) => entry.name)).toEqual(['a.txt', 'b.md'])
    expect(result.attachment).toEqual(result.attachments[0])
    expect(f.remember).toHaveBeenCalledTimes(2)
  })
  it('keeps nothing when one file of a multi-file selection is rejected, and names it', async () => {
    native.pick.mockResolvedValue([
      { scheme: 'file', path: '/fixture/a.txt' },
      { scheme: 'file', path: '/fixture/folder' },
    ])
    native.stat.mockImplementation((uri: { path: string }) =>
      Promise.resolve(uri.path.endsWith('folder') ? { type: 2, size: 0 } : { type: 1, size: 3 }),
    )
    native.read.mockResolvedValue(new TextEncoder().encode('abc'))
    const f = fixture()
    await expect(f.pick()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await expect(f.pick()).rejects.toThrow(/^folder: /u)
    expect(f.remember).not.toHaveBeenCalled()
  })
  it('refuses selections above the per-pick limit before reading', async () => {
    native.pick.mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({ scheme: 'file', path: `/fixture/${index}.txt` })),
    )
    await expect(fixture().pick()).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(native.stat).not.toHaveBeenCalled()
  })
})

describe('opening a pending text attachment', () => {
  it('opens text content as an untitled preview and refuses images or expired tokens', async () => {
    const text = vi.fn((uri: string) =>
      uri === 'dsh-attachment:text' ? { name: 'note.md', text: '# hi' } : undefined,
    )
    const handler = createAttachmentRequestHandler({
      attachmentTokens: { text },
    } as unknown as RequestGatewayDependencies)
    native.openDocument.mockResolvedValue({ uri: 'untitled:1' })
    const open = (uri: string): Promise<unknown> =>
      handler(
        { type: 'attachment.openText', requestId: 'open', payload: { uri } },
        new AbortController().signal,
      )
    expect(await open('dsh-attachment:text')).toEqual({ opened: true })
    expect(native.openDocument).toHaveBeenCalledExactlyOnceWith({ content: '# hi' })
    expect(native.showDocument).toHaveBeenCalledExactlyOnceWith({ uri: 'untitled:1' }, { preview: true })
    expect(await open('dsh-attachment:image')).toEqual({ opened: false })
    expect(native.openDocument).toHaveBeenCalledTimes(1)
  })
})
