import * as vscode from 'vscode'
import { AppError } from '@dsh-vscode/domain'
import { sessionEditorResource } from '@dsh-vscode/webview-protocol'
import type { SessionDirectoryView, SessionNavigation } from '../composition/session-navigation.js'

export const SESSION_LIST_VIEW_ID = 'dsh.sessionList'
const PAGE_SIZE = 100
type Workspace = SessionDirectoryView['workspaces'][number]
type Session = SessionDirectoryView['sessions'][number]
type SessionNode = { readonly kind: 'session'; readonly session: Session }
type WorkspaceNode = { readonly kind: 'workspace'; readonly workspace: Workspace }
export type SessionListNode =
  WorkspaceNode | SessionNode | { readonly kind: 'more'; readonly workspace: Workspace }

/** A lazy native presentation of summaries, with no transcript or event replay. */
export class NativeSessionList
  implements
    vscode.TreeDataProvider<SessionListNode>,
    vscode.TreeDragAndDropController<SessionListNode>,
    vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<SessionListNode | undefined>()
  public readonly onDidChangeTreeData = this.changed.event
  public readonly dragMimeTypes = ['text/uri-list']
  public readonly dropMimeTypes: readonly string[] = []
  private directory: SessionDirectoryView | undefined
  private loading: Promise<void> | undefined
  private dirty = true
  private read = new AbortController()
  private readonly limits = new Map<string, number>()
  private readonly nodes = new Map<string, SessionNode>()
  private readonly workspaces = new Map<string, WorkspaceNode>()
  private visible = false
  private disposed = false

  public constructor(
    private readonly navigation: SessionNavigation,
    private readonly loaded: (message?: string) => void,
  ) {}

  public setVisible(visible: boolean): void {
    if (visible === this.visible || this.disposed) return
    this.visible = visible
    if (!visible) this.invalidate()
    else this.changed.fire(undefined)
  }

  public invalidate(): void {
    this.read.abort()
    this.read = new AbortController()
    this.loading = undefined
    this.dirty = true
    this.directory = undefined
    this.nodes.clear()
    this.workspaces.clear()
    if (!this.disposed) this.loaded(undefined)
    if (this.visible && !this.disposed) this.changed.fire(undefined)
  }

  /** Finish the current pull, then perform at most one queued refresh. */
  public refresh(restart = false): void {
    if (this.disposed) return
    if (restart) {
      this.read.abort()
      this.read = new AbortController()
      this.loading = undefined
    }
    this.dirty = true
    if (this.visible) void this.load()
  }

  public selectionChanged(): SessionNode | undefined {
    if (this.disposed) return undefined
    this.updateMessage()
    this.changed.fire(undefined)
    const id = this.navigation.activeSessionId
    return id === undefined ? undefined : this.nodes.get(id)
  }

  public async getChildren(node?: SessionListNode): Promise<SessionListNode[]> {
    if (!this.visible || this.disposed) return []
    if (this.directory === undefined) await this.load()
    else if (this.dirty) void this.load()
    if (!this.visible || this.disposed) return []
    if (node === undefined) {
      const workspaces = [...this.workspaces.values()]
      const only = workspaces.length === 1 ? workspaces[0] : undefined
      return only === undefined ? workspaces : this.sessionRows(only.workspace)
    }
    return node.kind === 'workspace' ? this.sessionRows(node.workspace) : []
  }

  private sessionRows(workspace: Workspace): SessionListNode[] {
    const sessions = (this.directory?.sessions ?? []).filter(
      (session) =>
        session.workspaceId === workspace.id &&
        (!session.blank || session.id === this.navigation.activeSessionId),
    )
    const limit = this.limits.get(workspace.id) ?? PAGE_SIZE
    const result: SessionListNode[] = sessions.slice(0, limit).map((session) => {
      let row = this.nodes.get(session.id)
      if (row === undefined) {
        row = { kind: 'session', session }
        this.nodes.set(session.id, row)
      }
      return row
    })
    if (sessions.length > limit) result.push({ kind: 'more', workspace })
    return result
  }

  public getParent(node: SessionListNode): WorkspaceNode | undefined {
    if (node.kind === 'workspace' || this.workspaces.size === 1) return undefined
    const id = node.kind === 'session' ? node.session.workspaceId : node.workspace.id
    return this.workspaces.get(id)
  }

  public getTreeItem(node: SessionListNode): vscode.TreeItem {
    if (node.kind === 'workspace') {
      const item = new vscode.TreeItem(node.workspace.name, vscode.TreeItemCollapsibleState.Expanded)
      item.id = `workspace:${node.workspace.id}`
      item.iconPath = new vscode.ThemeIcon('folder')
      return item
    }
    if (node.kind === 'more') {
      const title = label('Load more', '加载更多')
      const item = new vscode.TreeItem(title)
      item.id = `more:${node.workspace.id}`
      item.command = { command: 'dsh.sessions.loadMore', title, arguments: [node] }
      item.iconPath = new vscode.ThemeIcon('ellipsis')
      return item
    }
    const item = new vscode.TreeItem(
      node.session.title.replace(/\s+/gu, ' ').trim() || label('New Session', '新会话'),
    )
    item.id = `session:${node.session.id}`
    item.resourceUri = vscode.Uri.parse(sessionEditorResource(node.session.id))
    item.contextValue = 'dsh.session'
    item.iconPath = new vscode.ThemeIcon('comment-discussion')
    item.command = {
      command: 'dsh.sessions.open',
      title: label('Open Session', '打开会话'),
      arguments: [node],
    }
    return item
  }

  public handleDrag(
    source: readonly SessionListNode[],
    transfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): void {
    if (token.isCancellationRequested) return
    const uris = source.flatMap((node) =>
      node.kind === 'session' ? [sessionEditorResource(node.session.id)] : [],
    )
    // This is the public TreeView editor-drag contract. The Workbench owns
    // the drag source and split overlay; no iframe or cursor-position fallback.
    if (uris.length > 0) transfer.set('text/uri-list', new vscode.DataTransferItem(uris.join('\r\n')))
  }

  public loadMore(value: unknown): void {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      value.kind !== 'more' ||
      !('workspace' in value)
    )
      return
    const workspace = value.workspace
    if (
      typeof workspace !== 'object' ||
      workspace === null ||
      !('id' in workspace) ||
      typeof workspace.id !== 'string'
    )
      return
    const parent = this.workspaces.get(workspace.id)
    if (parent === undefined) return
    this.limits.set(workspace.id, (this.limits.get(workspace.id) ?? PAGE_SIZE) + PAGE_SIZE)
    this.changed.fire(this.workspaces.size === 1 ? undefined : parent)
  }

  public session(value: unknown): Session | undefined {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      value.kind !== 'session' ||
      !('session' in value)
    )
      return undefined
    const candidate = value.session
    if (typeof candidate !== 'object' || candidate === null || !('id' in candidate)) return undefined
    return this.directory?.sessions.find(({ id }) => id === candidate.id)
  }

  public dispose(): void {
    this.disposed = true
    this.invalidate()
    this.limits.clear()
    this.changed.dispose()
  }

  private updateMessage(): void {
    const visible = this.directory?.sessions.some(
      (session) => !session.blank || session.id === this.navigation.activeSessionId,
    )
    if (visible !== undefined) this.loaded(visible ? undefined : label('No sessions', '暂无会话'))
  }

  private load(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    if (this.directory !== undefined && !this.dirty) return Promise.resolve()
    this.dirty = false
    this.loaded(undefined)
    const signal = this.read.signal
    const loading = this.navigation
      .read(signal)
      .then((directory) => {
        if (signal.aborted || this.disposed) return
        this.directory = directory
        this.nodes.clear()
        this.workspaces.clear()
        for (const workspace of directory.workspaces)
          this.workspaces.set(workspace.id, { kind: 'workspace', workspace })
        for (const id of this.limits.keys())
          if (!directory.workspaces.some((workspace) => workspace.id === id)) this.limits.delete(id)
        this.updateMessage()
        this.changed.fire(undefined)
      })
      .catch((error: unknown) => {
        if (!signal.aborted && !this.disposed)
          this.loaded(
            error instanceof AppError && error.code === 'BACKEND_UNREACHABLE' && !this.navigation.connected
              ? label('Connect to DSH to see sessions', '连接 DSH 后查看会话')
              : label('Unable to load sessions. Refresh to retry.', '无法加载会话，请刷新重试。'),
          )
      })
      .finally(() => {
        if (this.loading !== loading) return
        this.loading = undefined
        if (this.dirty && this.visible && !this.disposed) void this.load()
      })
    this.loading = loading
    return loading
  }
}

export function registerNativeSessionList(navigation: SessionNavigation): vscode.Disposable {
  const provider = new NativeSessionList(navigation, (message) => {
    tree.message = message ?? ''
  })
  const tree = vscode.window.createTreeView(SESSION_LIST_VIEW_ID, {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
  })
  provider.setVisible(tree.visible)
  const lifetime = new AbortController()
  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      if (!lifetime.signal.aborted)
        void vscode.window.showErrorMessage(
          error instanceof AppError
            ? error.message
            : label('Unable to update or open this session.', '无法更新或打开此会话。'),
        )
    }
  }
  const subscriptions = [
    tree,
    provider,
    tree.onDidChangeVisibility(({ visible }) => provider.setVisible(visible)),
    navigation.onDidChange((change) => {
      if (change === 'connection') provider.invalidate()
      else if (change === 'directory') provider.refresh()
      else {
        const node = provider.selectionChanged()
        if (tree?.visible && node !== undefined)
          void tree.reveal(node, { select: true, focus: false }).then(undefined, () => undefined)
      }
    }),
    vscode.commands.registerCommand('dsh.sessions.refresh', () => provider.refresh(true)),
    vscode.commands.registerCommand('dsh.sessions.loadMore', (node: unknown) => provider.loadMore(node)),
    ...(['open', 'openInEditor', 'rename', 'archive'] as const).map((action) =>
      vscode.commands.registerCommand(`dsh.sessions.${action}`, (node: unknown) =>
        run(async () => {
          const session = provider.session(node)
          if (session === undefined) return
          if (action === 'rename') {
            const title = await vscode.window.showInputBox({
              title: label('Rename Session', '重命名会话'),
              value: session.title,
              validateInput: (value) =>
                value.trim() === '' ? label('Enter a name', '请输入名称') : undefined,
            })
            if (title !== undefined && !lifetime.signal.aborted)
              await navigation.rename(session.id, title, lifetime.signal)
          } else if (action === 'archive') await navigation.archive(session.id, lifetime.signal)
          else await navigation.open(session.id, action === 'openInEditor', lifetime.signal)
        }),
      ),
    ),
  ]
  return {
    dispose: () => {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      for (const subscription of subscriptions) subscription.dispose()
    },
  }
}

function label(english: string, chinese: string): string {
  return vscode.env.language.toLowerCase().startsWith('zh') ? chinese : english
}
