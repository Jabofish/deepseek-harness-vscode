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
  it('clears the real TreeView message accessor after connecting and after a successful refresh', async () => {
    const { navigation } = fixture()
    navigation.read.mockRejectedValueOnce(
      new AppError({ code: 'BACKEND_UNREACHABLE', message: 'Connect first', retryable: true }),
    )
    let message: string | undefined
    class Tree {
      public visible = true
      public disposed = false
      public dispose = vi.fn(() => {
        this.disposed = true
      })
      public reveal = vi.fn().mockResolvedValue(undefined)
      public onDidChangeVisibility = vi.fn().mockReturnValue({ dispose: vi.fn() })
      public get message(): string | undefined {
        return message
      }
      public set message(value: string | undefined) {
        expect(this.disposed).toBe(false)
        message = value
      }
    }
    const tree = new Tree()
    host.create.mockReturnValue(tree)
    const registration = registerNativeSessionList(navigation)
    const options = host.create.mock.calls.at(-1)![1] as vscode.TreeViewOptions<
      Parameters<NativeSessionList['getTreeItem']>[0]
    >
    const provider = options.treeDataProvider as NativeSessionList
    await provider.getChildren()
    expect(message).toBe('Connect to DSH to see sessions')
    provider.invalidate()
    await provider.getChildren()
    expect(message || undefined).toBeUndefined()
    registration.dispose()
  })
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
  it('loads only when visible and reveals 10,000 summaries in local pages without rereading DSH', async () => {
    const { provider, navigation } = fixture(10_000)
    expect(await provider.getChildren()).toEqual([])
    expect(navigation.read).not.toHaveBeenCalled()
    provider.setVisible(true)
    const [workspace, other] = await provider.getChildren()
    const first = await provider.getChildren(workspace)
    expect(first).toHaveLength(101)
    expect(await provider.getChildren(other)).toEqual([])
    provider.loadMore(first.at(-1))
    const more = await provider.getChildren(workspace)
    expect(more).toHaveLength(201)
    expect(navigation.read).toHaveBeenCalledOnce()
    const selected = provider.getTreeItem(more[0]!)
    expect(selected.description).toBeUndefined()
    expect(selected.resourceUri?.toString()).toBe(sessionEditorResource('s0'))
    provider.selectionChanged()
    await provider.getChildren(workspace)
    expect(navigation.read).toHaveBeenCalledOnce()
    provider.dispose()
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

  it('shows a single workspace as flat compact session rows', async () => {
    const { provider, directory, navigation } = fixture()
    navigation.read.mockResolvedValue({ ...directory, workspaces: directory.workspaces.slice(0, 1) })
    provider.setVisible(true)
    const rows = await provider.getChildren()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('session')
    expect(provider.getParent(rows[0]!)).toBeUndefined()
    expect(provider.getTreeItem(rows[0]!).description).toBeUndefined()
    provider.dispose()
  })

  it('cancels hidden reads and ignores an old response arriving after a newer directory', async () => {
    const { provider, navigation, directory } = fixture()
    let finish!: (value: SessionDirectoryView) => void
    navigation.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    provider.setVisible(true)
    const old = provider.getChildren()
    const signal = navigation.read.mock.calls[0]![0]
    provider.setVisible(false)
    expect(signal.aborted).toBe(true)
    provider.setVisible(true)
    expect(await provider.getChildren()).toHaveLength(2)
    finish({ workspaces: [{ id: 'stale', name: 'Old' }], sessions: [] })
    await old
    expect(await provider.getChildren()).toEqual(
      directory.workspaces.map((workspace) => ({ kind: 'workspace', workspace })),
    )
    provider.dispose()
    expect(await provider.getChildren()).toEqual([])
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

  it('clears an obsolete connection hint as soon as a new read starts', async () => {
    const { provider, navigation, loaded } = fixture()
    navigation.read.mockRejectedValueOnce(
      new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'Connect first',
        retryable: true,
      }),
    )
    provider.setVisible(true)
    await provider.getChildren()
    provider.invalidate()
    expect(loaded).toHaveBeenLastCalledWith(undefined)
    provider.dispose()
  })

  it('coalesces directory changes during a read without aborting it or emptying visible rows', async () => {
    const { provider, navigation, directory } = fixture()
    provider.setVisible(true)
    const [workspace] = await provider.getChildren()
    const [row] = await provider.getChildren(workspace)
    let finish!: (value: SessionDirectoryView) => void
    navigation.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    provider.refresh()
    const signal = navigation.read.mock.calls.at(-1)![0]
    for (let i = 0; i < 40; i++) provider.refresh()
    expect(signal.aborted).toBe(false)
    expect(provider.session(row)?.id).toBe('s0')
    expect(await provider.getChildren(workspace)).toHaveLength(1)
    expect(navigation.read).toHaveBeenCalledTimes(2)
    finish(directory)
    await vi.waitFor(() => expect(navigation.read).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(provider.session(row)?.id).toBe('s0'))
    expect(navigation.read.mock.calls.every(([signal]) => !signal.aborted)).toBe(true)
    provider.dispose()
  })

  it('returns no rows when a pending visible read completes after the view was hidden', async () => {
    const { provider, navigation, directory } = fixture()
    let finish!: (value: SessionDirectoryView) => void
    navigation.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    provider.setVisible(true)
    const pending = provider.getChildren()
    provider.setVisible(false)
    finish(directory)
    expect(await pending).toEqual([])
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
    expect(navigation.read).toHaveBeenCalledTimes(2)
    provider.refresh()
    await vi.waitFor(() => expect(loaded).toHaveBeenLastCalledWith(undefined))
    expect(navigation.read).toHaveBeenCalledTimes(3)
    provider.dispose()
  })

  it('lets an explicit refresh replace a hung read and ignores its eventual obsolete response', async () => {
    const { provider, navigation, directory } = fixture()
    provider.setVisible(true)
    await provider.getChildren()
    let finish!: (value: SessionDirectoryView) => void
    navigation.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    provider.refresh()
    const signal = navigation.read.mock.calls.at(-1)![0]
    provider.refresh(true)
    expect(signal.aborted).toBe(true)
    await vi.waitFor(() => expect(navigation.read).toHaveBeenCalledTimes(3))
    finish({ ...directory, sessions: [] })
    const [workspace] = await provider.getChildren()
    await vi.waitFor(async () => expect(await provider.getChildren(workspace)).toHaveLength(1))
    provider.dispose()
  })

  it('keeps empty-state text consistent with filtered drafts and the selected draft', async () => {
    const { provider, navigation, directory, loaded } = fixture(1)
    const selection: { id?: string } = {}
    Object.defineProperty(navigation, 'activeSessionId', { get: () => selection.id })
    navigation.read.mockResolvedValue({
      workspaces: directory.workspaces.slice(0, 1),
      sessions: directory.sessions.map((row) => ({ ...row, blank: true })),
    })
    provider.setVisible(true)
    expect(await provider.getChildren()).toEqual([])
    expect(loaded).toHaveBeenLastCalledWith('No sessions')
    selection.id = 's0'
    provider.selectionChanged()
    expect(loaded).toHaveBeenLastCalledWith(undefined)
    expect(await provider.getChildren()).toHaveLength(1)
    expect(navigation.read).toHaveBeenCalledOnce()
    provider.dispose()
  })
})
