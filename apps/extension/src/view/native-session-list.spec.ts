import { describe, expect, it, vi, type Mock, type Mocked } from 'vitest'
import * as vscode from 'vscode'
import { sessionEditorResource } from '@dsh-vscode/webview-protocol'
import { AppError } from '@dsh-vscode/domain'
import { NativeSessionList, registerNativeSessionList } from './native-session-list.js'
import { createSessionDropEditorProvider } from './session-drop-editor.js'
import type { SessionDirectoryView, SessionNavigation } from '../composition/session-navigation.js'

const host = vi.hoisted(() => ({
  create: vi.fn(),
  input: vi.fn(),
  error: vi.fn(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('vscode', () => ({
  EventEmitter: class {
    private readonly listeners = new Set<(value: unknown) => void>()
    public event = (listener: (value: unknown) => void): { dispose: () => boolean } => {
      this.listeners.add(listener)
      return { dispose: () => this.listeners.delete(listener) }
    }
    public fire(value: unknown): void {
      for (const listener of this.listeners) listener(value)
    }
    public dispose(): void {
      this.listeners.clear()
    }
  },
  TreeItem: class {
    public constructor(
      public label: string,
      public collapsibleState?: number,
    ) {}
  },
  ThemeIcon: class {
    public constructor(public id: string) {}
  },
  TreeItemCollapsibleState: { Expanded: 2 },
  DataTransfer: Map,
  DataTransferItem: class {
    public constructor(public value: string) {}
    public asString(): Promise<string> {
      return Promise.resolve(this.value)
    }
  },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  env: { language: 'en' },
  window: { createTreeView: host.create, showInputBox: host.input, showErrorMessage: host.error },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      host.commands.set(id, handler)
      return { dispose: () => host.commands.delete(id) }
    },
  },
}))

interface Fixture {
  readonly directory: SessionDirectoryView
  readonly navigation: Mocked<SessionNavigation>
  readonly loaded: Mock<(message?: string) => void>
  readonly provider: NativeSessionList
}

function fixture(count = 1, connected = false): Fixture {
  const directory: SessionDirectoryView = {
    workspaces: [
      { id: 'w1', name: 'Project' },
      { id: 'w2', name: 'Other' },
    ],
    sessions: Array.from({ length: count }, (_, index) => ({
      id: `s${index}`,
      workspaceId: 'w1',
      title: `Chat ${index}`,
      blank: false,
    })),
  }
  const navigation = {
    connected,
    read: vi.fn<SessionNavigation['read']>().mockResolvedValue(directory),
    activeSessionId: 's0',
    select: vi.fn(),
    invalidate: vi.fn(),
    acceptEvent: vi.fn(),
    onDidChange: vi.fn<SessionNavigation['onDidChange']>().mockReturnValue({ dispose: vi.fn() }),
    open: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
  } satisfies SessionNavigation
  const loaded = vi.fn()
  const provider = new NativeSessionList(navigation, loaded)
  return { provider, navigation, loaded, directory }
}

describe('native session list', () => {
  it('wires native actions, respects cancelled rename and releases its commands and pending work', async () => {
    const { navigation } = fixture()
    const disposed = vi.fn()
    const visibility = vi.fn()
    const reveal = vi.fn().mockResolvedValue(undefined)
    host.create.mockReturnValue({
      visible: true,
      dispose: disposed,
      onDidChangeVisibility: visibility.mockReturnValue({ dispose: vi.fn() }),
      reveal,
    })
    host.input.mockResolvedValue(undefined)
    const registration = registerNativeSessionList(navigation)
    const options = host.create.mock.calls.at(-1)![1] as vscode.TreeViewOptions<
      Parameters<NativeSessionList['getTreeItem']>[0]
    >
    const provider = options.treeDataProvider as NativeSessionList
    const [workspace] = await provider.getChildren()
    const [row] = await provider.getChildren(workspace)
    await host.commands.get('dsh.sessions.rename')!(row)
    expect(navigation.rename).not.toHaveBeenCalled()
    host.input.mockResolvedValue('New title')
    await host.commands.get('dsh.sessions.rename')!(row)
    expect(navigation.rename).toHaveBeenCalledWith('s0', 'New title', expect.any(AbortSignal))
    await host.commands.get('dsh.sessions.openInEditor')!(row)
    expect(navigation.open).toHaveBeenCalledWith('s0', true, expect.any(AbortSignal))
    const signal = navigation.open.mock.calls[0]![2]
    registration.dispose()
    registration.dispose()
    expect(signal.aborted).toBe(true)
    expect(disposed).toHaveBeenCalledOnce()
    expect(host.commands.size).toBe(0)
  })

  it('passes native URI drags through the existing drop provider into the accepted editor group', async () => {
    const { provider } = fixture()
    provider.setVisible(true)
    const [workspace] = await provider.getChildren()
    const rows = await provider.getChildren(workspace)
    const transfer = new vscode.DataTransfer()
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) }
    provider.handleDrag([workspace!, ...rows], transfer, token)
    const uri = await transfer.get('text/uri-list')?.asString()
    expect(uri).toBe(sessionEditorResource('s0'))
    const open = vi.fn().mockResolvedValue(undefined)
    const drop = createSessionDropEditorProvider(open, vi.fn())
    const document = await drop.openCustomDocument(
      vscode.Uri.parse(uri!),
      { backupId: undefined, untitledDocumentData: undefined },
      token,
    )
    const dispose = vi.fn()
    await drop.resolveCustomEditor(
      document,
      {
        viewColumn: 3,
        dispose,
        onDidDispose: () => ({ dispose: vi.fn() }),
      } as unknown as vscode.WebviewPanel,
      token,
    )
    expect(open).toHaveBeenCalledWith('s0', 3, expect.any(AbortSignal))
    expect(dispose).toHaveBeenCalledOnce()
    const cancelled = new vscode.DataTransfer()
    provider.handleDrag(rows, cancelled, { ...token, isCancellationRequested: true })
    expect(cancelled.get('text/uri-list')).toBeUndefined()
    provider.dispose()
  })

  it('offers retry after directory failure and rejects stale row commands after invalidation', async () => {
    const { provider, navigation, loaded } = fixture()
    navigation.read.mockRejectedValueOnce(new Error('private upstream diagnostics'))
    provider.setVisible(true)
    expect(await provider.getChildren()).toEqual([])
    expect(loaded).toHaveBeenLastCalledWith('Unable to load sessions. Refresh to retry.')
    provider.invalidate()
    const [workspace] = await provider.getChildren()
    const [row] = await provider.getChildren(workspace)
    expect(provider.session(row)?.id).toBe('s0')
    expect(loaded).toHaveBeenLastCalledWith(undefined)
    provider.invalidate()
    expect(provider.session(row)).toBeUndefined()
    provider.dispose()
  })

  it('keeps the last successful directory on refresh failure and does not label a connected read as disconnected', async () => {
    const { provider, navigation, loaded } = fixture(1, true)
    provider.setVisible(true)
    const [workspace] = await provider.getChildren()
    const [row] = await provider.getChildren(workspace)
    navigation.read.mockRejectedValueOnce(
      new AppError({ code: 'BACKEND_UNREACHABLE', message: 'network read failed', retryable: true }),
    )
    provider.refresh()
    await vi.waitFor(() =>
      expect(loaded).toHaveBeenLastCalledWith('Unable to load sessions. Refresh to retry.'),
    )
    expect(provider.session(row)?.id).toBe('s0')
    provider.refresh()
    await vi.waitFor(() => expect(loaded).toHaveBeenLastCalledWith(undefined))
    provider.dispose()
  })
})
