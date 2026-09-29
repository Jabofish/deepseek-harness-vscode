import { beforeEach, describe, expect, it, vi } from 'vitest'

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
} {
  host.isTrusted = isTrusted
  host.commands = []
  const sent: Sent[] = []
  const retries: number[] = []
  const gateway = createRequestGateway({
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
  } as never)
  return { gateway, sent, retries }
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
})
