// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState, AppStore } from './app/store.js'

let currentStore: AppStore

vi.mock('./app/store.js', () => ({
  createAppStore: () => currentStore,
}))

vi.mock('./features/chat/Timeline.js', () => ({
  Timeline: () => <div data-testid="timeline">Timeline</div>,
}))

import { App } from './App.js'
import { I18nProvider } from './i18n.js'

function connectedState(activeSession: boolean): AppState {
  return {
    // The current connection.snapshot protocol intentionally exposes only
    // the connection kind to the Webview, so connected state may not carry
    // the full Extension Host backend object.
    backend: { kind: 'connected' } as AppState['backend'],
    connectedDshVersion: '0.1.0-rc.6',
    dshCompatibilityWarning: undefined,
    dshUpdate: undefined,
    sessions: activeSession
      ? [
          {
            id: 's1',
            title: 'Session',
            workspaceId: 'w1',
            blank: false,
            status: 'idle',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]
      : [],
    archivedSessionIds: [],
    workspaces: [
      {
        id: 'w1',
        name: 'Workspace',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sessionIds: activeSession ? ['s1'] : [],
        sessionCount: activeSession ? 1 : 0,
      },
    ],
    activeSessionId: activeSession ? 's1' : undefined,
    preferredOpenFileId: undefined,
    timeline: { sessionId: activeSession ? 's1' : undefined, nodes: [], lastSequence: -1 },
    history: [],
    historyHasMore: false,
    historyBeforeSequence: undefined,
    historyLoading: false,
    projections: {},
    configuration: activeSession
      ? {
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: '', modelId: '' },
        }
      : undefined,
    providers: [],
    models: [],
    sessionModels: [],
    presets: [],
    permissionPresets: [],
    commands: [],
    goals: [],
    todos: [],
    jobs: [],
    feedback: {},
    subagents: { entries: [], parentAvailable: false },
    activeSubagent: undefined,
    queue: [],
    permissions: [],
    questions: [],
    busyEnter: 'queue',
    drawer: undefined,
  }
}

function storeFor(state: AppState): AppStore {
  return {
    ...state,
    getState: () => state,
    subscribe: () => () => undefined,
    initialize: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    configureConnection: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    searchSessions: vi.fn().mockResolvedValue([]),
    refreshCommands: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn().mockResolvedValue(undefined),
    loadOlderHistory: vi.fn().mockResolvedValue(undefined),
    openSubagent: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    renameWorkspace: vi.fn().mockResolvedValue(undefined),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    moveWorkspace: vi.fn().mockResolvedValue(undefined),
    moveSession: vi.fn().mockResolvedValue(undefined),
    forkSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(undefined),
    removeSession: vi.fn().mockResolvedValue(undefined),
    configureSession: vi.fn(),
    executeCommand: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    updateQueue: vi.fn(),
    removeQueue: vi.fn(),
    steerQueue: vi.fn(),
    steerAllQueued: vi.fn().mockResolvedValue(undefined),
    loadFeedback: vi.fn().mockResolvedValue(undefined),
    toggleFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackNote: vi.fn().mockResolvedValue(undefined),
    removeFeedback: vi.fn().mockResolvedValue(undefined),
    listReferences: vi.fn().mockResolvedValue([]),
    respondToPermission: vi.fn(),
    respondToQuestion: vi.fn(),
    cancelQuestion: vi.fn(),
    pickAttachment: vi.fn().mockResolvedValue(undefined),
    ingestAttachment: vi.fn().mockResolvedValue(undefined),
    previewAttachment: vi.fn().mockResolvedValue(undefined),
    readSessionAttachment: vi.fn().mockResolvedValue(undefined),
    releaseAttachments: vi.fn().mockResolvedValue(undefined),
    listOpenFiles: vi.fn().mockResolvedValue([]),
    attachOpenFile: vi.fn().mockResolvedValue(undefined),
    rememberOpenFile: vi.fn(),
    openLink: vi.fn().mockResolvedValue(undefined),
    showInFolder: vi.fn().mockResolvedValue(undefined),
    runtimeAction: vi.fn().mockResolvedValue(undefined),
    checkDshUpdates: vi.fn().mockResolvedValue(undefined),
    installDshVersion: vi.fn().mockResolvedValue(undefined),
    readSettings: vi.fn().mockResolvedValue(undefined),
    readDshSettings: vi.fn().mockResolvedValue(undefined),
    openDshSettingsDocument: vi.fn().mockResolvedValue(undefined),
    updateDshSetting: vi.fn().mockResolvedValue(undefined),
    unsetDshSetting: vi.fn().mockResolvedValue(undefined),
    discoverModels: vi.fn().mockResolvedValue([]),
    configureProviderSecret: vi.fn().mockResolvedValue(false),
    removeProviderSecret: vi.fn().mockResolvedValue(undefined),
    refreshModelCatalog: vi.fn().mockResolvedValue(undefined),
    loadPresetRoster: vi.fn().mockResolvedValue(undefined),
    readPresetDocument: vi.fn().mockResolvedValue(undefined),
    copyPreset: vi.fn().mockResolvedValue(undefined),
    removePreset: vi.fn().mockResolvedValue(undefined),
    openPresetDocument: vi.fn().mockResolvedValue(undefined),
    loadPluginInventory: vi.fn().mockResolvedValue(undefined),
    loadSubagentChildren: vi.fn().mockResolvedValue(undefined),
    updateGoal: vi.fn().mockResolvedValue(undefined),
    clearGoal: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue(undefined),
    setDrawer: vi.fn(),
    dispose: vi.fn(),
  }
}

describe('App connected rendering', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it.each([false, true])('renders the page when connected (active=%s)', (activeSession) => {
    currentStore = storeFor(connectedState(activeSession))
    render(<App />)
    expect(screen.queryByText('DeepSeek Harness view failed')).toBeNull()
    expect(screen.getByRole('main')).toBeDefined()
  })

  it('does not render a duplicate in-webview settings trigger', () => {
    currentStore = storeFor(connectedState(false))
    render(<App />)

    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()
  })

  it('lets the user dismiss an update notice for the current upstream version', () => {
    currentStore = storeFor({
      ...connectedState(false),
      dshUpdate: {
        status: 'ready',
        currentVersion: '0.1.0-rc.8',
        latestVersion: '0.1.0-rc.9',
        availableVersions: ['0.1.0-rc.9', '0.1.0-rc.8'],
        updateAvailable: true,
        checkedAt: '2026-08-21T00:00:00.000Z',
      },
    })

    render(<App />)

    expect(screen.getByText('DSH update available')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }))
    expect(screen.queryByText('DSH update available')).toBeNull()
    expect(window.localStorage.getItem('dsh-runtime-update-dismissed-version')).toBe('0.1.0-rc.9')
  })

  it('shows a newer update after an older notice was dismissed', () => {
    window.localStorage.setItem('dsh-runtime-update-dismissed-version', '0.1.0-rc.9')
    currentStore = storeFor({
      ...connectedState(false),
      dshUpdate: {
        status: 'ready',
        currentVersion: '0.1.0-rc.8',
        latestVersion: '0.1.0-rc.10',
        availableVersions: ['0.1.0-rc.10'],
        updateAvailable: true,
        checkedAt: '2026-08-21T00:00:00.000Z',
      },
    })

    render(<App />)

    expect(screen.getByText('DSH update available')).toBeDefined()
  })

  it('keeps the settings entry point available when the runtime is missing', () => {
    const setDrawer = vi.fn()
    currentStore = {
      ...storeFor({
        ...connectedState(false),
        backend: {
          kind: 'runtime-missing',
          searchedLocations: ['C:\\Users\\Direwolf\\AppData\\Roaming\\npm\\dsh.cmd'],
        },
      }),
      setDrawer,
    }

    render(<App />)

    expect(screen.getByRole('heading', { name: "DeepSeek Harness isn't ready yet" })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(setDrawer).toHaveBeenCalledWith('settings')
  })

  it('keeps the subagent catalog trigger visible when the host reports children', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      subagents: {
        parentAvailable: true,
        entries: [
          {
            kind: 'child',
            id: 'child-1',
            label: 'Researcher',
            activity: 'inactive',
            parentSessionId: 's1',
            mode: 'continuable',
            hasChildren: false,
          },
        ],
      },
    })

    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    expect(screen.getByRole('button', { name: 'Subagents: 1' })).toBeDefined()
    expect(screen.getByText('Subagents')).toBeDefined()
  })

  it('renders one-shot subagent history as read-only', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      activeSessionId: 'child-1',
      configuration: undefined,
      activeSubagent: {
        workspaceId: 'w1',
        parentAvailable: true,
        entry: {
          kind: 'child',
          id: 'child-1',
          activity: 'inactive',
          parentSessionId: 's1',
          mode: 'one-shot',
          hasChildren: false,
        },
      },
      timeline: { sessionId: 'child-1', nodes: [], lastSequence: -1 },
    })

    render(<App />)

    expect(screen.getByRole('status').textContent).toContain(
      'One-shot tasks do not accept follow-up messages.',
    )
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
  })

  it('keeps Stop available for a running continuable child whose parent is offline', () => {
    const state = connectedState(true)
    const cancelSession = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor({
        ...state,
        activeSessionId: 'child-1',
        configuration: undefined,
        activeSubagent: {
          workspaceId: 'w1',
          parentAvailable: false,
          entry: {
            kind: 'child',
            id: 'child-1',
            label: 'Worker',
            activity: 'running',
            parentSessionId: 's1',
            mode: 'continuable',
            hasChildren: false,
          },
        },
        timeline: { sessionId: 'child-1', nodes: [], lastSequence: -1 },
      }),
      cancelSession,
    }

    render(<App />)
    expect(screen.getByRole('textbox', { name: 'Prompt' }).hasAttribute('disabled')).toBe(true)
    const stop = screen.getByRole('button', { name: 'Stop response' })
    expect(stop.hasAttribute('disabled')).toBe(false)
    fireEvent.click(stop)
    expect(cancelSession).toHaveBeenCalledWith('child-1')
  })

  it('allows text follow-up but disables attachments for an available continuable child', () => {
    const state = connectedState(true)
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor({
        ...state,
        activeSessionId: 'child-1',
        configuration: undefined,
        activeSubagent: {
          workspaceId: 'w1',
          parentAvailable: true,
          entry: {
            kind: 'child',
            id: 'child-1',
            label: 'Worker',
            activity: 'inactive',
            parentSessionId: 's1',
            mode: 'continuable',
            hasChildren: false,
          },
        },
        timeline: { sessionId: 'child-1', nodes: [], lastSequence: -1 },
      }),
      sendPrompt,
    }

    render(<App />)
    expect(screen.getByRole('button', { name: 'Attach file' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'continue' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(sendPrompt).toHaveBeenCalledWith('child-1', 'continue', [], 'queue')
  })

  it('uses DSH context pressure instead of estimating tokens from rendered text', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      projections: {
        s1: {
          contextPressure: { pressureTokens: 1_024, contextWindow: 1_000_000 },
          contextBreakdown: { systemTokens: 1_600, toolsTokens: 6_700, messageTokens: 19_500 },
        },
      },
    })
    render(<App />)

    expect(screen.getByLabelText('Context ~1.0k / 1.0m tokens')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Context ~1.0k / 1.0m tokens' }))
    expect(screen.getByRole('dialog').textContent).toContain('System prompt')
    expect(screen.getByRole('dialog').textContent).toContain('~1.6K')
    expect(screen.getByRole('dialog').textContent).toContain('Conversation messages')
  })

  it('pre-checks rc.8 image limits before sending bytes to the Extension Host', () => {
    const state = connectedState(true)
    const ingestAttachment = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor({
        ...state,
        projections: {
          s1: {
            imageLimits: {
              maxImageBytes: 2,
              maxImagesPerMessage: 20,
              maxMessageImageBytes: 100,
              maxImagePixels: 100,
              maxImageDimension: 10,
              mediaTypes: ['image/png'],
            },
          },
        },
      }),
      ingestAttachment,
    }
    render(<App />)
    const file = new File(['too-large'], 'screenshot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByRole('textbox', { name: 'Prompt' }), {
      clipboardData: { files: [file] },
    })

    expect(screen.getByRole('alert').textContent).toContain('DSH image limit of 2 B')
    expect(ingestAttachment).not.toHaveBeenCalled()
  })

  it('releases an opaque Host attachment handle when its draft chip is removed', async () => {
    const state = connectedState(true)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000001'
    const pickAttachment = vi.fn().mockResolvedValue({ uri, name: 'notes.txt', mimeType: 'text/plain' })
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor(state),
      pickAttachment,
      releaseAttachments,
    }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    const remove = await screen.findByRole('button', { name: 'Remove notes.txt' })
    fireEvent.click(remove)

    await waitFor(() => expect(releaseAttachments).toHaveBeenCalledWith([uri]))
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull()
  })

  it('applies the selected interface language across the conversation and export surfaces', () => {
    currentStore = storeFor(connectedState(true))
    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Interface language' }))
    fireEvent.click(screen.getByRole('option', { name: '中文' }))

    expect(screen.getByRole('tab', { name: '对话' })).toBeDefined()
    expect(screen.getByPlaceholderText('输入消息…')).toBeDefined()
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDefined()
    expect(document.documentElement.lang).toBe('zh-CN')

    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    expect(screen.getByRole('heading', { name: '导出会话' })).toBeDefined()
    expect(screen.getByText('包含附件')).toBeDefined()
    expect(screen.getByRole('button', { name: '选择保存位置并导出' })).toBeDefined()
  })

  it('keeps structured todo content directly above the composer', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      todos: [
        { id: 'todo-1', content: '查询系统信息', status: 'completed' },
        { id: 'todo-2', content: '执行子代理调研', status: 'in-progress' },
      ],
    })
    const { container } = render(<App />)

    const composeArea = container.querySelector('.dsh-compose-area')
    const todoList = composeArea?.querySelector('.dsh-todo-list')
    expect(todoList).not.toBeNull()
    expect(todoList?.textContent).toContain('执行子代理调研')
    expect(todoList?.textContent).not.toContain('查询系统信息')
    expect(container.querySelector('.dsh-conversation > .dsh-goal-strip')).toBeNull()
  })
})
