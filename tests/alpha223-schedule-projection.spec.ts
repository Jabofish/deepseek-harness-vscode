import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshBackend } from '@dsh-vscode/domain'
import { Alpha223ScheduleRepository } from '../packages/dsh-adapter/src/versions/alpha223/schedule-repository.js'
import type { DshTransport } from '@dsh-vscode/dsh-adapter'
import { featureRequestSchema, featureResponsePayloadSchema } from '../packages/webview-protocol/src/index.js'
import {
  createFeatureRequestHandler,
  type FeatureRequestHandlerDependencies,
} from '../apps/extension/src/composition/feature-request-handler.js'
import { alpha223Task } from '../packages/dsh-adapter/test/fixtures/alpha223-contract.js'
import { ProtocolClient } from '../apps/webview/src/app/protocol-client.js'
import { createAppStore } from '../apps/webview/src/app/store.js'
import { WebviewMessageRouter } from '../apps/extension/src/view/message-router.js'
import { PROTOCOL_VERSION } from '../packages/webview-protocol/src/index.js'
const trust = vi.hoisted(() => ({ isTrusted: true }))
vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return trust.isTrusted
    },
  },
}))
function harness(options: { onReply?: (method: string) => void; beforeWorkspace?: () => void } = {}): {
  handler: ReturnType<typeof createFeatureRequestHandler>
  invoke: (type: string, payload: unknown) => Promise<unknown>
  calls: { method: string; args: unknown }[]
  changeBackend: () => void
} {
  const calls: { method: string; args: unknown }[] = []
  const transport: DshTransport = {
    remoteRequest: <T>(method: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ method, args })
      const value =
        method === 'schedule/catalog'
          ? [
              alpha223Task,
              {
                ...alpha223Task,
                id: 'outside',
                target: { ...alpha223Task.target, create: { cwd: '/other/project' } },
              },
            ]
          : method === 'schedule/create'
            ? alpha223Task
            : { id: alpha223Task.id, deleted: true }
      options.onReply?.(method)
      return Promise.resolve({ ok: true, value } as T)
    },
    request: () => Promise.reject(new Error('Unexpected ordinary RPC')),
    openEventStream: async function* () {
      yield await Promise.reject(new Error('Unexpected stream'))
    },
    close: () => Promise.resolve(),
  }
  let backend = { schedules: new Alpha223ScheduleRepository(transport) } as unknown as DshBackend
  const handler = createFeatureRequestHandler({
    backendService: { requireBackend: () => backend },
    listCurrentWorkspaces: () => {
      options.beforeWorkspace?.()
      return Promise.resolve([
        {
          id: 'w',
          name: 'Fixture workspace',
          path: '/fixture/workspace',
          sessionIds: [],
          createdAt: '',
          updatedAt: '',
          sessionCount: 0,
        },
      ])
    },
    requireCurrentWorkspaceSession: () => Promise.resolve(),
  } as unknown as FeatureRequestHandlerDependencies)
  return {
    calls,
    handler,
    changeBackend: () => {
      backend = { ...backend }
    },
    invoke: async (type: string, payload: unknown) =>
      featureResponsePayloadSchema.parse(
        await handler.handleFeatureRequest(
          featureRequestSchema.parse({ type, requestId: 'r', payload }),
          new AbortController().signal,
        ),
      ),
  }
}

function connect(handler: ReturnType<typeof createFeatureRequestHandler>): {
  store: ReturnType<typeof createAppStore>
  dispose: () => void
} {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    clearTimeout,
  })
  const client = new ProtocolClient({
    postMessage: (message) => {
      void router.handle(message, 'schedule-sidebar')
    },
    getState: () => undefined,
    setState: () => undefined,
  })
  const router = new WebviewMessageRouter({
    handleFeatureRequest: handler.handleFeatureRequest,
    postMessage: (message, surfaceId) => {
      expect(surfaceId).toBe('schedule-sidebar')
      client.handle({ protocolVersion: PROTOCOL_VERSION, message })
      return Promise.resolve(true)
    },
  })
  const store = createAppStore(client)
  return {
    store,
    dispose: () => {
      router.cancelAll()
      store.dispose()
    },
  }
}

const nativeCreate = {
  type: 'schedule.create' as const,
  requestId: 'create',
  payload: {
    workspaceId: 'w',
    title: 'Review',
    prompt: 'Review project',
    timing: { kind: 'after' as const, seconds: 300 },
    targetMode: 'new_once' as const,
  },
}
describe('alpha223 Schedule Host and strict protocol boundary', () => {
  beforeEach(() => {
    trust.isTrusted = true
  })
  afterEach(() => vi.unstubAllGlobals())
  it('preserves a committed create receipt when trust is revoked while the native reply is returning', async () => {
    const { handler, calls } = harness({
      onReply: (method) => {
        if (method === 'schedule/create') trust.isTrusted = false
      },
    })
    const { store, dispose } = connect(handler)
    try {
      await expect(store.featureRequest(nativeCreate)).resolves.toMatchObject({
        kind: 'schedule.created',
        item: { id: alpha223Task.id },
      })
      await expect(
        store.featureRequest({ ...nativeCreate, requestId: 'later-create' }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(calls.filter((call) => call.method === 'schedule/create')).toHaveLength(1)
    } finally {
      dispose()
    }
  })
  it('rechecks trust after workspace discovery and refuses a create that has not reached DSH', async () => {
    const { handler, calls } = harness({
      beforeWorkspace: () => {
        trust.isTrusted = false
      },
    })
    const { store, dispose } = connect(handler)
    try {
      await expect(store.featureRequest(nativeCreate)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(calls).toEqual([])
    } finally {
      dispose()
    }
  })
  it('routes Store controls through the production protocol client, Host router and native Adapter', async () => {
    const { handler, calls } = harness()
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout,
      clearTimeout,
    })
    const client = new ProtocolClient({
      postMessage: (message) => {
        void router.handle(message, 'schedule-sidebar')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
    const router = new WebviewMessageRouter({
      handleFeatureRequest: handler.handleFeatureRequest,
      postMessage: (message, surfaceId) => {
        expect(surfaceId).toBe('schedule-sidebar')
        client.handle({ protocolVersion: PROTOCOL_VERSION, message })
        return Promise.resolve(true)
      },
    })
    const store = createAppStore(client)
    try {
      const catalog = await store.featureRequest({
        type: 'schedule.catalog',
        requestId: 'catalog',
        payload: {},
      })
      expect(catalog).toMatchObject({
        kind: 'schedule.catalog',
        management: 'host',
        items: [{ id: alpha223Task.id }],
      })
      const created = await store.featureRequest({
        type: 'schedule.create',
        requestId: 'create',
        payload: {
          workspaceId: 'w',
          title: 'Review',
          prompt: 'Review project',
          timing: { kind: 'after', seconds: 300 },
          targetMode: 'new_once',
        },
      })
      expect(created).toMatchObject({ kind: 'schedule.created', item: { workspaceId: 'w' } })
      expect(JSON.stringify(created)).not.toContain('/fixture/workspace')
      await expect(
        store.featureRequest({
          type: 'schedule.delete',
          requestId: 'denied',
          payload: { id: 'outside', expectedUpdatedAt: null },
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_OWNED' })
      expect(calls.filter((call) => call.method === 'schedule/create')).toHaveLength(1)
      expect(calls.some((call) => call.method === 'schedule/edit')).toBe(false)
    } finally {
      router.cancelAll()
      store.dispose()
    }
  })
  it('authorises creation paths in the Host and projects only workspace-owned targets', async () => {
    const { invoke, calls } = harness()
    const catalog = await invoke('schedule.catalog', {})
    expect(catalog).toMatchObject({
      kind: 'schedule.catalog',
      management: 'host',
      items: [{ id: alpha223Task.id, workspaceId: 'w' }],
    })
    expect(JSON.stringify(catalog)).not.toContain('/fixture/workspace')
    expect(JSON.stringify(catalog)).not.toContain('involvedSessionIds')
    expect(JSON.stringify(catalog)).not.toContain('outside')
    const created = await invoke('schedule.create', {
      workspaceId: 'w',
      title: 'Review',
      prompt: 'Review project',
      timing: { kind: 'after', seconds: 300 },
      targetMode: 'new_once',
    })
    expect(created).toMatchObject({ kind: 'schedule.created', item: { id: alpha223Task.id } })
    expect(JSON.stringify(created)).not.toContain('/fixture/workspace')
    expect(calls.at(-1)).toEqual({
      method: 'schedule/create',
      args: {
        request: {
          title: 'Review',
          prompt: 'Review project',
          timing: { kind: 'after', after_seconds: 300 },
          target: { kind: 'new_once', create: { cwd: '/fixture/workspace' } },
        },
      },
    })
  })
  it('rejects unowned ids, missing revisions, raw paths and untrusted execution before any write', async () => {
    const { invoke, calls } = harness()
    await expect(invoke('schedule.delete', { id: 'outside', expectedUpdatedAt: null })).rejects.toMatchObject(
      { code: 'RESOURCE_NOT_OWNED' },
    )
    await expect(invoke('schedule.delete', { id: alpha223Task.id })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(calls.every((call) => call.method === 'schedule/catalog')).toBe(true)
    expect(
      featureRequestSchema.safeParse({ type: 'schedule.create', requestId: 'r', payload: { cwd: '/other' } })
        .success,
    ).toBe(false)
    trust.isTrusted = false
    await expect(
      invoke('schedule.update', {
        id: alpha223Task.id,
        expected: {
          id: alpha223Task.id,
          kind: 'rrule',
          title: alpha223Task.title,
          prompt: alpha223Task.prompt,
          rrule: alpha223Task.rrule,
          scheduledAt: alpha223Task.scheduledAt,
        },
        expectedUpdatedAt: alpha223Task.updatedAt,
        active: false,
        prompt: 'Changed instruction',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(invoke('schedule.run', { id: alpha223Task.id })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    const result = await invoke('schedule.delete', {
      id: alpha223Task.id,
      expectedUpdatedAt: alpha223Task.updatedAt,
    })
    expect(result).toEqual({ kind: 'schedule.deleted', result: { id: alpha223Task.id, deleted: true } })
    expect(calls.filter((call) => call.method === 'schedule/edit')).toHaveLength(1)
  })
})
