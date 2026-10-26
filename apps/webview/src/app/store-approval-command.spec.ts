// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'
import { approvalCommand } from '../features/interactions/approval-command.js'

const SESSION_ID = 'session-approval-command'
const COMMAND = 'rm -rf build && pnpm install --frozen-lockfile && pnpm build'

class StreamClient {
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    return Promise.resolve(this.response(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
  }

  private response(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open':
        return {
          id: SESSION_ID,
          workspaceId: 'workspace-approval',
          title: 'Approval fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
          history: [],
          permissionPresets: ['workspace-write'],
          configuration: {
            preset: 'standard',
            toolMode: 'native',
            permissionPreset: 'workspace-write',
            planMode: false,
            model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          },
        }
      case 'models.session.list':
        return {
          models: [],
          failures: [],
          current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          routable: true,
        }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }
}

function settle(milliseconds = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function toolCallEvent(sequence: number, presentation: unknown, title: string): HostMessage {
  return {
    type: 'event',
    name: 'tool.updated',
    sequence,
    payload: {
      sessionId: SESSION_ID,
      tool: {
        id: 'call-bash-1',
        name: 'bash',
        status: 'running',
        title,
        category: 'terminal',
        turn: 0,
        step: 0,
        presentation,
      },
    },
  }
}

function approvalEvent(sequence: number, callId?: string, displayReason?: unknown): HostMessage {
  return {
    type: 'event',
    name: 'permission.requested',
    sequence,
    payload: {
      sessionId: SESSION_ID,
      request: {
        id: 'approval-1',
        sessionId: SESSION_ID,
        title: 'bash',
        description: 'The command needs approval.',
        ...(displayReason === undefined ? {} : { displayReason }),
        ...(callId === undefined ? {} : { callId }),
        risk: 'medium',
        options: [
          { id: 'allowed-once', label: 'Allow once', kind: 'allow-once' },
          { id: 'rejected', label: 'Reject', kind: 'deny' },
        ],
      },
    },
  }
}

describe('approval command resolution', () => {
  it('resolves the command from the tool call the approval is paired with', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The host sends `{ toolName, callId?, reason? }` and nothing else: DSH's
    // own approval panel derives the command from the paired running call
    // (a shell call card's title IS the command). Without the pairing the
    // takeover strip asks the user to authorize a decision they cannot read.
    client.emit(toolCallEvent(1, { phase: 'call', card: 'terminal', title: COMMAND }, COMMAND))
    client.emit(approvalEvent(2, 'call-bash-1'))
    await settle()

    const request = store.permissions[0]
    expect(request?.callId).toBe('call-bash-1')
    expect(request?.displayReason).toBeUndefined()
    expect(request === undefined ? undefined : approvalCommand(request, store.timeline.nodes)).toBe(COMMAND)
    store.dispose()
  })

  it('discards malformed localized display reasons instead of creating an approval', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    client.emit(approvalEvent(1, undefined, { en: 'Approval required', zh: 42 }))
    await settle()

    expect(store.permissions).toEqual([])
    store.dispose()
  })

  it('keeps a host-supplied command preview ahead of the paired call', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    client.emit({
      type: 'event',
      name: 'permission.requested',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        request: {
          id: 'approval-1',
          sessionId: SESSION_ID,
          title: 'bash',
          description: 'The command needs approval.',
          commandLine: 'pnpm test',
          risk: 'medium',
          options: [{ id: 'rejected', label: 'Reject', kind: 'deny' }],
        },
      },
    })
    await settle()

    const request = store.permissions[0]
    expect(request === undefined ? undefined : approvalCommand(request, store.timeline.nodes)).toBe(
      'pnpm test',
    )
    store.dispose()
  })
})
