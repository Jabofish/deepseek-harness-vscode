import { describe, expect, it, vi } from 'vitest'
import type { DshBackend } from '@dsh-vscode/domain'
import {
  createFeatureRequestHandler,
  type FeatureRequestHandlerDependencies,
} from './feature-request-handler.js'
import { featureRequestSchema } from '@dsh-vscode/webview-protocol'
import { featureResponsePayloadSchema } from '@dsh-vscode/webview-protocol'
const native = vi.hoisted(() => ({
  open: vi.fn(() => Promise.resolve(true)),
  copy: vi.fn(() => Promise.resolve()),
}))
vi.mock('vscode', () => ({
  env: { openExternal: native.open, clipboard: { writeText: native.copy } },
  Uri: { parse: (url: string) => url },
}))
const frontendUrl =
  'devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:3456/devtools/page/target-1&panel=elements&noJavaScriptCompletion=true'
describe('Inspector Host actions', () => {
  it('returns only an acknowledgement while Host opens/copies its validated target', async () => {
    const backend = {
      inspectorDevtools: { discover: () => Promise.resolve({ available: true, frontendUrl }) },
    } as unknown as DshBackend
    const handler = createFeatureRequestHandler({
      backendService: { requireBackend: () => backend },
    } as unknown as FeatureRequestHandlerDependencies)
    for (const action of ['status', 'open', 'copy'] as const) {
      const request = featureRequestSchema.parse({
        type: `inspector.devtools.${action}`,
        requestId: action,
        payload: {},
      })
      const result = featureResponsePayloadSchema.parse(
        await handler.handleFeatureRequest(request, new AbortController().signal),
      )
      expect(result).toEqual({
        kind: 'inspector.devtools',
        available: true,
        outcome: action === 'open' ? 'opened' : action === 'copy' ? 'copied' : 'status',
      })
      expect(JSON.stringify(result)).not.toContain('127.0.0.1')
    }
    expect(native.open).toHaveBeenCalledWith(frontendUrl)
    expect(native.copy).toHaveBeenCalledWith(frontendUrl)
    native.open.mockResolvedValueOnce(false)
    await expect(
      handler.handleFeatureRequest(
        { type: 'inspector.devtools.open', requestId: 'failed', payload: {} },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_FAILED' })
  })
  it('does not open a target from a replaced connection or accept a Webview URL', async () => {
    native.open.mockClear()
    let backend: DshBackend
    backend = {
      inspectorDevtools: {
        discover: () => {
          backend = {} as DshBackend
          return Promise.resolve({ available: true, frontendUrl })
        },
      },
    } as unknown as DshBackend
    const handler = createFeatureRequestHandler({
      backendService: { requireBackend: () => backend },
    } as unknown as FeatureRequestHandlerDependencies)
    await expect(
      handler.handleFeatureRequest(
        { type: 'inspector.devtools.open', requestId: 'r', payload: {} },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(native.open).not.toHaveBeenCalled()
    expect(
      featureRequestSchema.safeParse({
        type: 'inspector.devtools.open',
        requestId: 'r',
        payload: { url: 'https://evil' },
      }).success,
    ).toBe(false)
    expect(
      featureResponsePayloadSchema.safeParse({
        kind: 'inspector.devtools',
        available: true,
        outcome: 'status',
        frontendUrl,
      }).success,
    ).toBe(false)
  })
})
