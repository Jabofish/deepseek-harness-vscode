import { describe, expect, it, vi } from 'vitest'
import type { DshBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'
import {
  createFeatureRequestHandler,
  type FeatureRequestHandlerDependencies,
} from './feature-request-handler.js'
import { Alpha211ModsBandRepository } from '@dsh-vscode/dsh-adapter'
import { featureRequestSchema } from '@dsh-vscode/webview-protocol'
import { featureResponsePayloadSchema } from '@dsh-vscode/webview-protocol'
vi.mock('vscode', () => ({}))

describe('mod drawing Host boundary', () => {
  it('projects an adapter snapshot through Application, session authorization and strict protocol', async () => {
    const modsBand = new Alpha211ModsBandRepository({
      openRemoteStream: async function* () {
        await Promise.resolve()
        yield {
          generation: 1,
          tree: [
            {
              type: 'Button',
              props: { label: 'Apply', endpoint: 'http://private' },
              children: [],
              actionId: 'a0',
            },
          ],
        }
      },
      remoteRequest: () => Promise.resolve({ ok: true, value: { generation: 2, tree: null } }),
    })
    const backend = { modsBand } as unknown as DshBackend
    const authorize = vi.fn(() => Promise.resolve())
    const handler = createFeatureRequestHandler({
      backendService: { requireBackend: () => backend },
      requireCurrentWorkspaceSession: authorize,
    } as unknown as FeatureRequestHandlerDependencies)
    const read = featureRequestSchema.parse({
      type: 'mods.band.read',
      requestId: 'r1',
      payload: { sessionId: 's1' },
    })
    const value = featureResponsePayloadSchema.parse(
      await handler.handleFeatureRequest(read, new AbortController().signal),
    )
    expect(value).toEqual({
      kind: 'mods.band',
      available: true,
      snapshot: {
        generation: 1,
        tree: [{ kind: 'button', label: 'Apply', disabled: false, actionId: 'a0' }],
      },
    })
    const press = featureRequestSchema.parse({
      type: 'mods.band.press',
      requestId: 'p1',
      payload: { sessionId: 's1', generation: 1, actionId: 'a0' },
    })
    expect(
      featureResponsePayloadSchema.parse(
        await handler.handleFeatureRequest(press, new AbortController().signal),
      ),
    ).toMatchObject({ snapshot: { generation: 2, tree: null } })
    await modsBand.close()
  })

  it('rejects unauthorized sessions and connection replacement before publishing', async () => {
    const read = vi.fn(() => Promise.resolve({ available: true, snapshot: null }))
    const original = { modsBand: { read } } as unknown as DshBackend
    let backend = original
    const authorize = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new AppError({ code: 'PATH_NOT_ALLOWED', message: 'safe', retryable: false })),
    )
    const handler = createFeatureRequestHandler({
      backendService: { requireBackend: () => backend },
      requireCurrentWorkspaceSession: authorize,
    } as unknown as FeatureRequestHandlerDependencies)
    const request = { type: 'mods.band.read' as const, requestId: 'r1', payload: { sessionId: 's1' } }
    await expect(handler.handleFeatureRequest(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    expect(read).not.toHaveBeenCalled()
    authorize.mockResolvedValue(undefined)
    read.mockImplementationOnce(() => {
      backend = {} as DshBackend
      return Promise.resolve({ available: true, snapshot: null })
    })
    await expect(handler.handleFeatureRequest(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
  })

  it('rejects arbitrary Remote forwarding, raw props, deep trees and Host-only values', () => {
    expect(
      featureRequestSchema.safeParse({
        type: 'mods.band.press',
        requestId: 'p',
        payload: { sessionId: 's', generation: 1, actionId: 'a0', endpoint: 'http://bad' },
      }).success,
    ).toBe(false)
    const payload = (tree: unknown): unknown => ({
      kind: 'mods.band',
      available: true,
      snapshot: { generation: 1, tree },
    })
    for (const tree of [
      [{ kind: 'button', label: 'x', disabled: false, props: { html: 'raw' } }],
      ['C:\\private\\secret'],
      ['http://127.0.0.1:1234'],
      ['Cookie=session=private'],
      ['pid=12345'],
    ])
      expect(featureResponsePayloadSchema.safeParse(payload(tree)).success).toBe(false)
    expect(
      featureResponsePayloadSchema.safeParse({ ...(payload([]) as object), available: false }).success,
    ).toBe(false)
    let tree: unknown = []
    for (let depth = 0; depth < 20; depth++)
      tree = [
        {
          kind: 'text',
          color: 'green',
          bold: false,
          dim: false,
          italic: false,
          underline: false,
          children: tree,
        },
      ]
    expect(featureResponsePayloadSchema.safeParse(payload(tree)).success).toBe(false)
  })
})
