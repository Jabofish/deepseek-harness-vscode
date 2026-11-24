import { describe, expect, it, vi } from 'vitest'

const trust = vi.hoisted(() => ({ isTrusted: true }))
vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return trust.isTrusted
    },
  },
}))

import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { createFeatureRequestHandler, type FeatureRequestHandler } from './feature-request-handler.js'

const owner = { ownerId: 'owner', ownerViewId: 'view' }

function handler(release: () => Promise<void> = () => Promise.resolve()): {
  readonly handle: FeatureRequestHandler['handleFeatureRequest']
  readonly release: ReturnType<typeof vi.fn>
} {
  const useCases = { release: vi.fn(release) }
  const handler = createFeatureRequestHandler({
    featureContextOwner: () => owner,
    editorContextUseCases: useCases,
    postFeatureEvent: () => Promise.resolve(true),
    postEditorContextAvailabilityEvent: () => Promise.resolve(),
  } as never)
  return { handle: handler.handleFeatureRequest, release: useCases.release }
}

const request = (type: FeatureRequest['type'], payload: unknown): FeatureRequest =>
  ({ type, requestId: 'trust-1', payload }) as FeatureRequest

describe('feature route workspace trust', () => {
  it.each([
    ['editor.context.capture', { kind: 'file' }],
    ['editor.context.list', {}],
    ['editor.context.preview', { contextRef: 'dsh-context:one' }],
    ['editor.context.release', { contextRefs: [] }],
    ['navigation.open', { workspaceFolderId: 'workspace-1', relativePath: 'src/main.ts' }],
  ] as const)('refuses %s in an untrusted workspace', async (type, payload) => {
    trust.isTrusted = false
    const { handle, release } = handler()

    await expect(handle(request(type, payload), new AbortController().signal)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(release).not.toHaveBeenCalled()
  })

  it('reaches the editor context route when the workspace is trusted', async () => {
    trust.isTrusted = true
    const { handle, release } = handler()

    await expect(
      handle(request('editor.context.release', { contextRefs: [] }), new AbortController().signal),
    ).resolves.toEqual({ kind: 'empty' })
    expect(release).toHaveBeenCalledOnce()
  })
})
