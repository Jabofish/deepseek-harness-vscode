import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import { createAttachmentRequestHandler } from './attachment-request-handler.js'

const native = vi.hoisted(() => ({ pick: vi.fn(), stat: vi.fn(), read: vi.fn() }))
vi.mock('vscode', () => ({
  window: { showOpenDialog: native.pick },
  workspace: { fs: { stat: native.stat, readFile: native.read } },
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
})
