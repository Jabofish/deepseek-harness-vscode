import { transcriptWindowFixture, sessionWatchFixture } from '../view/transcript-window.fixture.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError, type BackendEvent, type InteractionRepository } from '@dsh-vscode/domain'

// Exercise the real Adapter's remembered options without making the Extension
// TypeScript project import implementation files from another project.
const { Rc6InteractionRepository } = await vi.importActual<{
  Rc6InteractionRepository: new (transport: unknown) => InteractionRepository & {
    remember(event: BackendEvent): void
  }
}>('../../../../packages/dsh-adapter/src/repositories/interaction-repository.js')

const host = vi.hoisted(() => ({ isTrusted: true, commands: [] as string[] }))

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() {
      return host.isTrusted
    },
  },
  commands: {
    executeCommand: (command: string) => {
      host.commands.push(command)
      return Promise.resolve(undefined)
    },
  },
}))

import { createRequestGateway } from './request-handler.js'
import { WebviewSurfaceRegistry } from '../view/webview-surface-registry.js'

type Sent = {
  readonly type: string
  readonly requestId: string
  readonly ok: boolean
  readonly error?: { readonly code?: string }
}

function buildGateway(isTrusted: boolean): {
  gateway: ReturnType<typeof createRequestGateway>
  sent: Sent[]
  retries: number[]
  controls: string[]
  permissionOwnership: ReturnType<typeof vi.fn<() => Promise<void>>>
} {
  host.isTrusted = isTrusted
  host.commands = []
  const sent: Sent[] = []
  const retries: number[] = []
  const controls: string[] = []
  const permissionOwnership = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const interactions = new Rc6InteractionRepository({})
  interactions.remember({
    type: 'permission.requested',
    request: {
      id: 'permission-owned',
      rpcId: 'permission-wire',
      sessionId: 's1',
      title: 'Run fixture tool',
      description: 'Pending fixture operation',
      risk: 'unknown',
      options: [
        { id: 'opaque-stop', label: 'Allow', kind: 'deny' },
        { id: 'deny', label: 'Deny', kind: 'allow-once' },
      ],
    },
  })
  const gateway = createRequestGateway({
    postTo: () => Promise.resolve(true),
    postEvent: () => Promise.resolve(true),
    postEventTo: () => Promise.resolve(true),
    surfaces: new WebviewSurfaceRegistry(),
    transcript: transcriptWindowFixture(),
    sessionWatch: sessionWatchFixture(),
    post: (message: unknown) => {
      sent.push(message as Sent)
      return Promise.resolve(true)
    },
    diagnostics: { log: () => {}, show: () => {}, recentEvents: () => [] },
    context: {
      extensionUri: { fsPath: '/extension' },
      subscriptions: [],
      workspaceState: { update: () => Promise.resolve() },
    },
    currentWorkspaceFolders: () => [{ uri: { fsPath: '/project' }, name: 'project', index: 0 }],
    reconnect: (signal?: AbortSignal) => {
      retries.push(signal === undefined ? 0 : 1)
      return Promise.resolve({ connected: true })
    },
    requireCurrentWorkspaceSession: () => Promise.resolve({ id: 's1' }),
    requireOwnedQuestion: () => Promise.resolve(),
    requireOwnedPermission: permissionOwnership,
    backendService: { requireBackend: () => ({ interactions }) },
    sessionUseCases: {
      cancel: (id: string) => {
        controls.push(`cancel:${id}`)
        return Promise.resolve()
      },
    },
    interactionUseCases: {
      respondToPermission: (id: string, optionId: string) => {
        controls.push(`permission:${id}:${optionId}`)
        return Promise.resolve()
      },
      cancelQuestion: (id: string) => {
        controls.push(`question:${id}`)
        return Promise.resolve()
      },
    },
  } as never)
  return { gateway, sent, retries, controls, permissionOwnership }
}

const envelope = (type: string, requestId: string): unknown => ({
  protocolVersion: 1,
  message: { type, requestId },
})

describe('request gateway workspace trust refusal', () => {
  let context: ReturnType<typeof buildGateway>

  beforeEach(() => {
    context = buildGateway(false)
  })

  it('refuses a trust-required route in an untrusted workspace without running the editor command', async () => {
    await context.gateway.router.handle(envelope('settings.openKeyboardShortcuts', 'r1'))

    expect(context.sent).toHaveLength(1)
    expect(context.sent[0]?.ok).toBe(false)
    expect(context.sent[0]?.error?.code).toBe('PERMISSION_DENIED')
    expect(host.commands).toEqual([])
  })

  it('still lets an untrusted workspace retry a connection so it can attach to a running host', async () => {
    await context.gateway.router.handle(envelope('connection.retry', 'r2'))

    expect(context.retries).toEqual([1])
    expect(context.sent[0]?.ok).toBe(true)
    expect(context.sent[0]?.error).toBeUndefined()
  })

  it('runs the same trust-required route once the workspace is trusted', async () => {
    const trusted = buildGateway(true)
    await trusted.gateway.router.handle(envelope('settings.openKeyboardShortcuts', 'r3'))

    expect(host.commands).toEqual(['workbench.action.openGlobalKeybindings'])
    expect(trusted.sent[0]?.ok).toBe(true)
  })

  it('forwards explicit stop and question cancellation after workspace trust is revoked', async () => {
    for (const [type, payload] of [
      ['session.cancel', { sessionId: 's1' }],
      ['interaction.question.cancel', { questionId: 'q1' }],
    ] as const)
      await context.gateway.router.handle({
        protocolVersion: 1,
        message: { type, requestId: type, payload },
      })
    expect(context.controls).toEqual(['cancel:s1', 'question:q1'])
    expect(context.sent.map((entry) => entry.ok)).toEqual([true, true])
  })

  const permissionResponse = (optionId: string): unknown => ({
    protocolVersion: 1,
    message: {
      type: 'interaction.permission.respond',
      requestId: `permission-${optionId}`,
      payload: { interactionId: 'permission-owned', optionId },
    },
  })

  it('admits an explicit denial after trust revocation using the actual Adapter option kind', async () => {
    await context.gateway.router.handle(permissionResponse('opaque-stop'))
    expect(context.sent[0]?.ok).toBe(true)
    expect(context.controls).toEqual(['permission:permission-owned:opaque-stop'])
    expect(context.permissionOwnership).toHaveBeenCalledOnce()
  })

  it.each(['deny', 'missing'])(
    'refuses an allowance or unknown option %s despite a deny label or ID',
    async (optionId) => {
      await context.gateway.router.handle(permissionResponse(optionId))
      expect(context.sent[0]?.error?.code).toBe('PERMISSION_DENIED')
      expect(context.controls).toEqual([])
    },
  )

  it('retains ownership validation before sending a denial', async () => {
    context.permissionOwnership.mockRejectedValueOnce(
      new AppError({
        code: 'PERMISSION_DENIED',
        message: 'Not owned by this workspace.',
        retryable: false,
      }),
    )
    await context.gateway.router.handle(permissionResponse('opaque-stop'))
    expect(context.permissionOwnership).toHaveBeenCalledOnce()
    expect(context.sent[0]?.error?.code).toBe('PERMISSION_DENIED')
    expect(context.controls).toEqual([])
  })

  it('allows the selected allowance in a trusted workspace', async () => {
    const trusted = buildGateway(true)
    await trusted.gateway.router.handle(permissionResponse('deny'))
    expect(trusted.sent[0]?.ok).toBe(true)
    expect(trusted.controls).toEqual(['permission:permission-owned:deny'])
  })

  it('rechecks trust after the asynchronous ownership lookup', async () => {
    const trusted = buildGateway(true)
    trusted.permissionOwnership.mockImplementationOnce(() => {
      host.isTrusted = false
      return Promise.resolve()
    })
    await trusted.gateway.router.handle(permissionResponse('deny'))
    expect(trusted.sent[0]?.error?.code).toBe('PERMISSION_DENIED')
    expect(trusted.controls).toEqual([])
  })
})
