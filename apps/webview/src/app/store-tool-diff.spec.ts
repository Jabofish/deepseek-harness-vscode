// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'session-diff'

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
          workspaceId: 'workspace-diff',
          title: 'Diff fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
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
        return { models: [] }
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

function locationsOf(store: ReturnType<typeof createAppStore>, callId: string): unknown {
  const node = store.timeline.nodes.find((entry) => entry.kind === 'tool' && entry.tool.id === callId)
  return node?.kind === 'tool' ? node.tool.locations : undefined
}

describe('store tool diff presentations', () => {
  it('keeps a removal-only hunk whose new text is legitimately empty', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The pinned DSH `edit` result carries `newText: ''` for a hunk that only
    // removes lines, and the `write` call view does the same for a file written
    // with empty content. The webview parse is the last gate before the card.
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-removal',
          name: 'edit',
          status: 'completed',
          title: 'Edit src/feature.ts',
          category: 'diff',
          turn: 0,
          step: 0,
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Edit src/feature.ts',
            diffs: [{ path: 'src/feature.ts', oldText: 'const removed = 1', newText: '' }],
          },
        },
      },
    })
    await settle()

    expect(presentationOf(store, 'call-removal')).toMatchObject({
      card: 'diff',
      diffs: [{ path: 'src/feature.ts', oldText: 'const removed = 1', newText: '' }],
    })

    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 2,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-cleared',
          name: 'write',
          status: 'running',
          title: 'Write notes.md',
          category: 'diff',
          presentation: {
            phase: 'call',
            card: 'diff',
            title: 'Write notes.md',
            diffs: [{ path: 'notes.md', oldText: null, newText: '' }],
          },
        },
      },
    })
    await settle()

    expect(presentationOf(store, 'call-cleared')).toMatchObject({
      card: 'diff',
      diffs: [{ path: 'notes.md', oldText: null, newText: '' }],
    })
    store.dispose()
  })
})

describe('store tool locations', () => {
  it('keeps a 0-based first-line hint and drops values no position could use', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The adapter already converted upstream's 1-based hint, so line 0 is the
    // first line of the file and must survive; a negative or fractional value
    // is not a position and is dropped while its path stays usable.
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-located',
          name: 'edit',
          status: 'running',
          title: 'Edit src/first.ts',
          category: 'diff',
          locations: [
            { path: 'src/first.ts', line: 0 },
            { path: 'src/negative.ts', line: -1 },
            { path: 'src/fractional.ts', line: 2.5 },
          ],
          presentation: {
            phase: 'call',
            card: 'diff',
            title: 'Edit src/first.ts',
            diffs: [{ path: 'src/first.ts', oldText: null, newText: 'first line\n' }],
            locations: [{ path: 'src/first.ts', line: 0 }],
          },
        },
      },
    })
    await settle()

    expect(locationsOf(store, 'call-located')).toEqual([
      { path: 'src/first.ts', line: 0 },
      { path: 'src/negative.ts' },
      { path: 'src/fractional.ts' },
    ])
    expect(presentationOf(store, 'call-located')).toMatchObject({
      card: 'diff',
      locations: [{ path: 'src/first.ts', line: 0 }],
    })
    store.dispose()
  })
})

describe('store tool diff hunk windows', () => {
  it('keeps every hunk of a scattered multi-hunk edit', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The pinned `write`/`edit` result carries one diff per applied hunk with
    // no count cap (DIFF_CONTEXT = 3 merges only adjacent changes), and the
    // adapter forwards them all. A `replace_all` scattered through a file
    // legitimately exceeds any small client cap.
    const diffs = Array.from({ length: 40 }, (_, index) => ({
      path: 'src/scattered.ts',
      oldText: `const old${index} = ${index}`,
      newText: `const renamed${index} = ${index}`,
    }))
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-many-hunks',
          name: 'edit',
          status: 'completed',
          title: 'Edit src/scattered.ts',
          category: 'diff',
          turn: 0,
          step: 0,
          presentation: {
            phase: 'result',
            card: 'diff',
            title: 'Edit src/scattered.ts',
            diffs,
          },
        },
      },
    })
    await settle()

    const presentation = presentationOf(store, 'call-many-hunks') as {
      readonly card?: string
      readonly diffs?: readonly unknown[]
    }
    expect(presentation.card).toBe('diff')
    expect(presentation.diffs).toHaveLength(40)
    store.dispose()
  })
})

describe('store tool presentation text', () => {
  it('keeps a written file longer than 4096 characters in the diff card', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // The pinned `write` presents the whole `content` argument as the diff's
    // `newText`, so the value is a real file body with no 4096-character host
    // bound. The card folds its rows for display and copies the projected diff
    // whole, so a clip here is invisible until the copy turns out incomplete.
    const file = 'const value = 1\n'.repeat(700)
    expect(file.length).toBeGreaterThan(4_096)
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-long-write',
          name: 'write',
          status: 'running',
          title: 'Write notes.md',
          category: 'diff',
          turn: 0,
          step: 0,
          presentation: {
            phase: 'call',
            card: 'diff',
            title: 'Write notes.md',
            diffs: [{ path: 'notes.md', oldText: null, newText: file }],
          },
        },
      },
    })
    await settle()

    expect(presentationOf(store, 'call-long-write')).toMatchObject({
      card: 'diff',
      diffs: [{ path: 'notes.md', oldText: null, newText: file }],
    })
    store.dispose()
  })

  it('keeps a terminal output longer than 4096 characters', async () => {
    const client = new StreamClient()
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(SESSION_ID)

    // `bash` presents the executor's collected text body, whose default
    // in-memory cap is `maxOutputBytes = 64_000` per stream — the terminal card
    // folds its lines but copies the whole output.
    const output = 'stdout line\n'.repeat(5_300)
    expect(output.length).toBeGreaterThan(4_096)
    client.emit({
      type: 'event',
      name: 'tool.updated',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        tool: {
          id: 'call-long-output',
          name: 'bash',
          status: 'completed',
          title: 'pnpm test',
          category: 'terminal',
          turn: 0,
          step: 0,
          presentation: {
            phase: 'result',
            card: 'terminal',
            title: 'pnpm test',
            output,
            exitCode: 0,
          },
        },
      },
    })
    await settle()

    expect(presentationOf(store, 'call-long-output')).toMatchObject({
      card: 'terminal',
      title: 'pnpm test',
      output,
      exitCode: 0,
    })
    store.dispose()
  })
})
