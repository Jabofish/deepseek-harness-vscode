import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import type * as EditorFiles from './editor-files.js'

vi.mock('vscode', () => ({
  workspace: { isTrusted: true },
}))

vi.mock('./editor-files.js', async (load) => ({
  ...(await load<typeof EditorFiles>()),
  listOpenFileCandidates: () => [
    {
      id: 'dsh-open-file-0123456789abcdef0123456789abcdef',
      uri: { scheme: 'file', toString: () => 'file:///project/hello.txt' },
      name: 'hello.txt',
      mimeType: 'text/plain',
      active: true,
    },
  ],
  readOpenFileAttachment: () =>
    Promise.resolve({
      name: 'hello.txt',
      mimeType: 'text/plain',
      dataUri: 'data:text/plain;base64,aGVsbG8=',
    }),
}))

import { createRequestGateway } from './request-handler.js'

describe('open-file context route', () => {
  it('returns one editor context instead of storing a second attachment', async () => {
    const sent: unknown[] = []
    const remember = vi.fn()
    const captureOpenFile = vi.fn().mockResolvedValue({
      ref: {
        contextRef: 'dsh-context:one',
        kind: 'file',
        workspaceFolderId: 'workspace-1',
        relativePath: 'hello.txt',
        sourceCandidateId: 'dsh-open-file-0123456789abcdef0123456789abcdef',
        ownerId: 'owner',
        ownerViewId: 'view',
        contextStoreGeneration: 1,
        sizeBytes: 5,
        capturedAt: 1,
        contentHash: 'hash',
        expiresAt: 600_001,
      },
      label: 'file: hello.txt',
      stale: false,
      previewAvailable: true,
    })
    const { router } = createRequestGateway({
      post: (message: unknown) => {
        sent.push(message)
        return Promise.resolve(true)
      },
      diagnostics: { log: () => {} },
      context: { extensionUri: { fsPath: '/extension' }, subscriptions: [] },
      attachmentTokens: { remember },
      backendService: { requireBackend: () => ({ sessions: { supportsFileUploads: false } }) },
      editorContextProvider: { captureOpenFile },
    } as never)

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'attachment.open.attach',
        requestId: 'open-file-1',
        payload: { candidateId: 'dsh-open-file-0123456789abcdef0123456789abcdef' },
      },
    })

    expect(captureOpenFile).toHaveBeenCalledTimes(1)
    expect(remember).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'response',
      ok: true,
      payload: { kind: 'editor.context', items: [{ label: 'file: hello.txt' }] },
    })
  })

  it('keeps the attachment route when an open file cannot be captured as editor context', async () => {
    const sent: unknown[] = []
    const remember = vi.fn().mockReturnValue({
      uri: 'dsh-attachment:one',
      name: 'hello.txt',
      mimeType: 'text/plain',
    })
    const captureOpenFile = vi
      .fn()
      .mockRejectedValue(
        new AppError({ code: 'CONTEXT_LIMIT', message: 'Context is full.', retryable: false }),
      )
    const { router } = createRequestGateway({
      post: (message: unknown) => {
        sent.push(message)
        return Promise.resolve(true)
      },
      diagnostics: { log: () => {} },
      context: { extensionUri: { fsPath: '/extension' }, subscriptions: [] },
      attachmentTokens: { remember },
      backendService: { requireBackend: () => ({ sessions: { supportsFileUploads: false } }) },
      editorContextProvider: { captureOpenFile },
    } as never)

    await router.handle({
      protocolVersion: 1,
      message: {
        type: 'attachment.open.attach',
        requestId: 'open-file-2',
        payload: { candidateId: 'dsh-open-file-0123456789abcdef0123456789abcdef' },
      },
    })

    expect(remember).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      ok: true,
      payload: { attachment: { name: 'hello.txt' } },
    })
  })
})
