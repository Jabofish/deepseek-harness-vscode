// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'session-presentation-window'

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
          workspaceId: 'workspace-window',
          title: 'Presentation window fixture',
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
        return { models: [], failures: [], routable: true }
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

function presentationOf(store: ReturnType<typeof createAppStore>, callId: string): unknown {
  const node = store.timeline.nodes.find((entry) => entry.kind === 'tool' && entry.tool.id === callId)
  return node?.kind === 'tool' ? node.tool.presentation : undefined
}

function readLines(value: unknown): readonly { readonly number: number; readonly text: string }[] {
  const presentation = value as {
    readonly card?: string
    readonly lines?: readonly { readonly number: number; readonly text: string }[]
  }
  expect(presentation.card).toBe('read')
  return presentation.lines ?? []
}

describe('store tool presentation windows', () => {
  it('keeps every line of a read window the host is allowed to return', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The pinned `read` tool caps one call at READ_LIMIT = 2000 lines, and the
    // adapter keeps the whole window. Dropping any of them here loses file
    // content the card then reports as a shorter, complete-looking window.
    const lines = Array.from({ length: 2_000 }, (_, index) => ({
      number: index + 1,
      text: `line ${index + 1} of the pinned read window`,
    }))
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-read-window',
          name: 'read',
          status: 'completed',
          title: 'read',
          category: 'read',
          turn: 0,
          step: 0,
          presentation: {
            phase: 'result',
            card: 'read',
            path: 'src/large.ts',
            offset: 1,
            totalLines: 2_000,
            lang: 'typescript',
            lines,
          },
        },
      },
    })
    await settle()

    const kept = readLines(presentationOf(store, 'call-read-window'))
    expect(kept).toHaveLength(2_000)
    expect(kept.at(-1)).toEqual({ number: 2_000, text: 'line 2000 of the pinned read window' })
  })

  it('keeps every match group of a capped grep result', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // GREP_MAX_MATCHES = 250 matches survive the host's inline cap, grouped by
    // file: one match in each of 250 files is a legal card, and the meta byte
    // cap drops trailing groups instead of vanishing them silently.
    const files = Array.from({ length: 250 }, (_, index) => ({
      path: `src/file-${String(index).padStart(3, '0')}.ts`,
      matches: [{ lineNumber: index + 1, line: `export const value${index} = ${index}` }],
    }))
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 2,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-grep-window',
          name: 'grep',
          status: 'completed',
          title: 'grep export const',
          category: 'search',
          turn: 0,
          step: 0,
          presentation: {
            phase: 'result',
            card: 'search',
            shape: 'matches',
            files,
            truncated: false,
            total: 250,
          },
        },
      },
    })
    await settle()

    const presentation = presentationOf(store, 'call-grep-window') as {
      readonly card?: string
      readonly files?: readonly { readonly matches: readonly unknown[] }[]
    }
    expect(presentation.card).toBe('search')
    expect(presentation.files).toHaveLength(250)
    expect(presentation.files?.reduce((sum, file) => sum + file.matches.length, 0)).toBe(250)
  })
})
