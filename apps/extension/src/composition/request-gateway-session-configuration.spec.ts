import { transcriptWindowFixture } from '../view/transcript-window.fixture.js'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentConfiguration, DshBackend, SessionDetail, WorkspaceSummary } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'
import { BackendService, ModelSettingsUseCases, SessionUseCases } from '@dsh-vscode/application'

const host = vi.hoisted(() => ({ isTrusted: true }))
vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return host.isTrusted
    },
  },
}))

import {
  createRequestGateway,
  type RequestGateway,
  type RequestGatewayDependencies,
} from './request-handler.js'
import { WebviewSurfaceRegistry } from '../view/webview-surface-registry.js'

const configuration: AgentConfiguration = {
  preset: 'deployed-default',
  toolMode: 'native',
  permissionPreset: 'workspace-write',
  planMode: false,
  model: { providerId: 'local', modelId: 'chosen', reasoningLevel: 'high' },
}
const session: SessionDetail = {
  id: 'session',
  workspaceId: 'workspace',
  title: 'Session',
  blank: true,
  status: 'idle',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  cwd: '/project/private',
  configuration,
}
const workspace: WorkspaceSummary = {
  id: 'workspace',
  name: 'Workspace',
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  sessionCount: 1,
}

function harness(): {
  readonly gateway: RequestGateway
  readonly sent: unknown[]
  readonly list: Mock<DshBackend['presets']['list']>
  readonly create: Mock<DshBackend['sessions']['create']>
  readonly setConfiguration: Mock<DshBackend['sessions']['setConfiguration']>
  readonly guard: Mock<RequestGatewayDependencies['requireCurrentWorkspaceSession']>
} {
  const list = vi.fn<DshBackend['presets']['list']>().mockResolvedValue({
    presets: [{ id: 'deployed-default', trust: 'system', isDefault: true }],
    authorable: false,
  })
  const create = vi.fn<DshBackend['sessions']['create']>().mockResolvedValue(session)
  const setConfiguration = vi.fn<DshBackend['sessions']['setConfiguration']>().mockResolvedValue(undefined)
  const guard = vi
    .fn<RequestGatewayDependencies['requireCurrentWorkspaceSession']>()
    .mockResolvedValue(session)
  const service = new BackendService()
  service.attach(
    {
      events: { subscribe: () => () => undefined },
      presets: { list },
      sessions: { create, setConfiguration },
    } as unknown as DshBackend,
    () => undefined,
  )
  const sent: unknown[] = []
  const gateway = createRequestGateway({
    postTo: () => Promise.resolve(true),
    postEvent: () => Promise.resolve(true),
    postEventTo: () => Promise.resolve(true),
    surfaces: new WebviewSurfaceRegistry(),
    transcript: transcriptWindowFixture(),
    backendService: service,
    modelUseCases: new ModelSettingsUseCases(service),
    sessionUseCases: new SessionUseCases(service),
    ensureCurrentWorkspace: () => Promise.resolve(workspace),
    requireCurrentWorkspaceSession: guard,
    currentWorkspaceFolders: () => [{ uri: { fsPath: '/project' }, name: 'project', index: 0 }],
    workspaceFolderIdForSession: () => 'folder',
    temporaryWorkspaceManager: {},
    post: (message: unknown) => {
      sent.push(message)
      return Promise.resolve(true)
    },
    diagnostics: { log: () => {} },
    context: { extensionUri: { fsPath: '/extension' }, subscriptions: [] },
  } as unknown as RequestGatewayDependencies)
  return { gateway, sent, list, create, setConfiguration, guard }
}

function request(type: 'session.create' | 'session.configure'): unknown {
  return {
    protocolVersion: 1,
    message: {
      type,
      requestId: 'configuration-request',
      payload: {
        ...(type === 'session.create' ? { workspaceId: 'workspace' } : { sessionId: 'session' }),
        configuration,
      },
    },
  }
}

describe('session configuration routes', () => {
  beforeEach(() => {
    host.isTrusted = true
  })

  it.each(['session.create', 'session.configure'] as const)(
    '%s applies the same Application rules and preserves Host projection',
    async (type) => {
      const { gateway, sent, list, create, setConfiguration, guard } = harness()
      await gateway.router.handle(request(type))

      const signal = list.mock.calls[0]?.[0]
      expect(signal).toBeInstanceOf(AbortSignal)
      const resolved = configuration
      if (type === 'session.create') {
        expect(create).toHaveBeenCalledExactlyOnceWith(
          { workspaceId: 'workspace', configuration: resolved },
          signal,
        )
        expect(setConfiguration).not.toHaveBeenCalled()
        expect(sent[0]).toMatchObject({ ok: true, payload: { id: 'session', workspaceFolderId: 'folder' } })
        expect(JSON.stringify(sent)).not.toContain('/project/private')
      } else {
        expect(guard).toHaveBeenCalledExactlyOnceWith('session', signal)
        expect(setConfiguration).toHaveBeenCalledExactlyOnceWith('session', resolved, signal)
        expect(create).not.toHaveBeenCalled()
        expect(sent[0]).toMatchObject({ ok: true })
      }
    },
  )

  it('refuses a foreign session before reading its roster or writing configuration', async () => {
    const { gateway, sent, list, setConfiguration, guard } = harness()
    guard.mockRejectedValue(
      new AppError({ code: 'PERMISSION_DENIED', message: 'Foreign session', retryable: false }),
    )

    await gateway.router.handle(request('session.configure'))

    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(list).not.toHaveBeenCalled()
    expect(setConfiguration).not.toHaveBeenCalled()
  })

  it.each(['session.create', 'session.configure'] as const)(
    'rejects a stale preset in %s before mutation',
    async (type) => {
      const { gateway, sent, create, setConfiguration, list } = harness()
      list.mockResolvedValue({
        presets: [{ id: 'different', trust: 'system', isDefault: true }],
        authorable: false,
      })
      await gateway.router.handle(request(type))
      expect(sent[0]).toMatchObject({ ok: false, error: { code: 'INVALID_CONFIGURATION' } })
      expect(create).not.toHaveBeenCalled()
      expect(setConfiguration).not.toHaveBeenCalled()
    },
  )

  it('refuses an untrusted workspace before resolving or creating a session', async () => {
    const { gateway, sent, list, create } = harness()
    host.isTrusted = false

    await gateway.router.handle(request('session.create'))

    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(list).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})
