// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { CONVERSATION_FONT_SIZE_STORAGE_KEY, THEME_PREFERENCE_STORAGE_KEY } from './app/ui-preferences.js'
import { I18nProvider } from './i18n.js'

function connectedState(activeSession: boolean): AppState {
  return {
    // The current connection.snapshot protocol intentionally exposes only
    // the connection kind to the Webview, so connected state may not carry
    // the full Extension Host backend object.
    backend: { kind: 'connected' },
    connectedDshVersion: '0.1.0-rc.6',
    subagentImagePrompts: false,
    dshCompatibilityWarning: undefined,
    featureProfile: undefined,
    dshUpdate: undefined,
    dshUpdateProgress: undefined,
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
    editorContext: [],
    editorContextAvailableKinds: [],
    editorContextLoading: false,
    changes: [],
    changesLoading: false,
    tasks: [],
    tasksLoading: false,
    checkpoints: [],
    checkpointsLoading: false,
    promptTemplates: [],
    promptTemplatesLoading: false,
    promptMode: 'ask',
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
    readDiagnostics: vi.fn().mockResolvedValue(undefined),
    showDiagnostics: vi.fn().mockResolvedValue(undefined),
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
    ensureFeedback: vi.fn().mockResolvedValue(undefined),
    toggleFeedback: vi.fn().mockResolvedValue(undefined),
    submitFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackNote: vi.fn().mockResolvedValue(undefined),
    removeFeedback: vi.fn().mockResolvedValue(undefined),
    listReferences: vi.fn().mockResolvedValue([]),
    respondToPermission: vi.fn(),
    respondToQuestion: vi.fn(),
    cancelQuestion: vi.fn(),
    captureEditorContext: vi.fn().mockResolvedValue(undefined),
    refreshEditorContext: vi.fn().mockResolvedValue(undefined),
    previewEditorContext: vi.fn().mockResolvedValue(undefined),
    releaseEditorContext: vi.fn().mockResolvedValue(undefined),
    refreshChanges: vi.fn().mockResolvedValue(undefined),
    getChangeDetail: vi.fn().mockResolvedValue(undefined),
    markChangeReviewed: vi.fn().mockResolvedValue(undefined),
    openChange: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(undefined),
    stopTask: vi.fn().mockResolvedValue(undefined),
    answerTask: vi.fn().mockResolvedValue(undefined),
    refreshCheckpoints: vi.fn().mockResolvedValue(undefined),
    createCheckpoint: vi.fn().mockResolvedValue(undefined),
    previewCheckpoint: vi.fn().mockResolvedValue(undefined),
    deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
    restoreCheckpoint: vi.fn().mockResolvedValue(undefined),
    refreshPromptTemplates: vi.fn().mockResolvedValue(undefined),
    readPromptTemplate: vi.fn().mockResolvedValue(undefined),
    insertPromptTemplate: vi.fn().mockResolvedValue(undefined),
    createPromptTemplate: vi.fn().mockResolvedValue(undefined),
    updatePromptTemplate: vi.fn().mockResolvedValue(undefined),
    deletePromptTemplate: vi.fn().mockResolvedValue(undefined),
    setPromptMode: vi.fn().mockResolvedValue(true),
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
    createCustomProvider: vi.fn().mockResolvedValue({
      profileCommitted: true,
      credentialConfigured: false,
    }),
    discoverModels: vi.fn().mockResolvedValue([]),
    discoverCustomProviderModels: vi.fn().mockResolvedValue([]),
    configureProviderSecret: vi.fn().mockResolvedValue(false),
    removeProviderSecret: vi.fn().mockResolvedValue(undefined),
    configurePluginCredential: vi.fn().mockResolvedValue(false),
    removePluginCredential: vi.fn().mockResolvedValue(undefined),
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

  it('shows the create-session page when DSH is connected without an active session', () => {
    currentStore = storeFor(connectedState(false))
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Create a session to begin.' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'New session here' })).toBeDefined()
    expect(screen.queryByText('Create a session to begin.')).toBeDefined()
    expect(document.querySelector('.dsh-empty-state')).toBeNull()
  })

  it.each([
    ['idle', 'Preparing DSH connection'],
    ['starting', 'Opening DSH'],
    ['connecting', 'Connecting to DSH'],
  ] as const)('shows connection progress instead of an empty-session message (%s)', (kind, title) => {
    currentStore = storeFor({ ...connectedState(false), backend: { kind } })
    render(<App />)

    expect(screen.getByRole('heading', { name: title })).toBeDefined()
    expect(screen.queryByText('No active session')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New session here' })).toBeNull()
  })

  it('shows catalog loading after DSH connects before workspace data arrives', () => {
    currentStore = storeFor({ ...connectedState(false), workspaces: [] })
    render(<App />)

    expect(screen.getByRole('heading', { name: 'Loading sessions' })).toBeDefined()
    expect(screen.queryByText('No active session')).toBeNull()
  })

  it('renders the shared application header controls', () => {
    currentStore = storeFor(connectedState(true))
    render(<App />)

    expect(screen.getByRole('banner')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Switch session: Session' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'New Session' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined()
  })

  it('restores and applies the conversation font size from General settings', () => {
    window.localStorage.setItem(CONVERSATION_FONT_SIZE_STORAGE_KEY, 'large')
    currentStore = storeFor({ ...connectedState(true), drawer: 'settings' })
    render(<App />)

    expect(document.querySelector('.dsh-conversation')?.getAttribute('data-conversation-font-size')).toBe(
      'large',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Small' }))

    expect(document.querySelector('.dsh-conversation')?.getAttribute('data-conversation-font-size')).toBe(
      'small',
    )
    expect(window.localStorage.getItem(CONVERSATION_FONT_SIZE_STORAGE_KEY)).toBe('small')
  })

  it('restores the selected Webview theme on the application root', () => {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'light')
    currentStore = storeFor(connectedState(true))

    render(<App />)

    expect(document.documentElement.dataset.dshTheme).toBe('light')
    expect(screen.getByRole('main').getAttribute('data-dsh-theme')).toBe('light')
  })

  it('keeps the session picker available while an existing session is not active', () => {
    const state = connectedState(false)
    const existingSession = {
      id: 's1',
      title: 'Existing session',
      workspaceId: 'w1',
      blank: false,
      status: 'completed' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    currentStore = storeFor({
      ...state,
      sessions: [existingSession],
      workspaces: [
        {
          ...state.workspaces[0]!,
          sessionIds: ['s1'],
          sessionCount: 1,
        },
      ],
      drawer: 'sessions',
    })

    render(<App />)

    expect(document.querySelector('.dsh-conversation__utility')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open sessions' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Sessions' })).toBeDefined()
    expect(screen.getByText('Existing session')).toBeDefined()
  })

  it('loads the trajectory surface when the user selects it', async () => {
    currentStore = storeFor(connectedState(true))
    render(<App />)

    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))

    await waitFor(() => expect(screen.getByLabelText('Trajectory ledger')).toBeDefined())
  })

  it('exposes tabpanel relationships and arrow-key navigation for conversation views', () => {
    currentStore = storeFor(connectedState(true))
    render(<App />)

    const chat = screen.getByRole('tab', { name: 'Chat' })
    const trajectory = screen.getByRole('tab', { name: 'Trajectory' })
    expect(chat.getAttribute('aria-controls')).toBe('dsh-conversation-panel-chat')
    expect(trajectory.getAttribute('aria-controls')).toBe('dsh-conversation-panel-trajectory')
    expect(chat.getAttribute('tabindex')).toBe('0')
    expect(trajectory.getAttribute('tabindex')).toBe('-1')

    fireEvent.keyDown(chat, { key: 'ArrowRight' })
    expect(trajectory.getAttribute('aria-selected')).toBe('true')
    expect(chat.getAttribute('tabindex')).toBe('-1')
    expect(trajectory.getAttribute('tabindex')).toBe('0')
    expect(document.activeElement).toBe(trajectory)
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

    const updateNotice = screen.getByText('DSH update available').closest('.dsh-app__runtime-update')
    expect(updateNotice?.classList.contains('dsh-toast')).toBe(true)
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

    const updateNotice = screen.getByText('DSH update available').closest('.dsh-app__runtime-update')
    expect(updateNotice?.classList.contains('dsh-toast')).toBe(true)
  })

  it('hides the top update notice once the latest version is installed globally', () => {
    currentStore = storeFor({
      ...connectedState(false),
      dshUpdate: {
        status: 'ready',
        currentVersion: '0.1.0-rc.8',
        globalVersion: '0.1.0-rc.9',
        latestVersion: '0.1.0-rc.9',
        availableVersions: ['0.1.0-rc.9', '0.1.0-rc.8'],
        updateAvailable: true,
        restartRequired: true,
        checkedAt: '2026-08-21T00:00:00.000Z',
      },
    })

    render(<App />)

    expect(screen.queryByText('DSH update available')).toBeNull()
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

  it('keeps the subagent catalog trigger visible when the host reports children', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subagents: 1' })).toBeDefined())
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

    expect(screen.getByText('One-shot tasks do not accept follow-up messages.')).toBeDefined()
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
    expect(screen.getByRole('button', { name: 'Editor context' }).hasAttribute('disabled')).toBe(true)
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

  it('does not render a partial token-usage projection as a complete total', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      projections: { s1: { tokenUsage: { outputTokens: 100 } } },
    })
    render(<App />)

    expect(screen.queryByText('↓100')).toBeNull()
  })

  it('does not render a partial context-pressure projection as complete', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      projections: { s1: { contextPressure: { pressureTokens: 1_024, contextWindow: 'broken' } } },
    })
    render(<App />)

    expect(screen.queryByRole('button', { name: /Context/u })).toBeNull()
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

  it('does not use a partially malformed image-limit projection as an admission policy', async () => {
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
              mediaTypes: ['image/png', 'text/plain'],
            },
          },
        },
      }),
      ingestAttachment,
    }
    render(<App />)
    fireEvent.paste(screen.getByRole('textbox', { name: 'Prompt' }), {
      clipboardData: { files: [new File(['small'], 'screenshot.png', { type: 'image/png' })] },
    })

    await waitFor(() => expect(ingestAttachment).toHaveBeenCalled())
    expect(screen.queryByText(/DSH image limit/u)).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach file' }))
    const remove = await screen.findByRole('button', { name: 'Remove notes.txt' })
    fireEvent.click(remove)

    await waitFor(() => expect(releaseAttachments).toHaveBeenCalledWith([uri]))
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull()
  })

  it('keeps one draft chip when the same picker file is selected twice', async () => {
    const state = connectedState(true)
    const firstUri = 'dsh-attachment:00000000-0000-4000-8000-000000000001'
    const secondUri = 'dsh-attachment:00000000-0000-4000-8000-000000000002'
    const pickAttachment = vi
      .fn()
      .mockResolvedValueOnce({ uri: firstUri, name: 'notes.txt', mimeType: 'text/plain' })
      .mockResolvedValueOnce({ uri: secondUri, name: 'notes.txt', mimeType: 'text/plain' })
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor(state),
      pickAttachment,
      releaseAttachments,
    }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach file' }))
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach file' }))

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove notes.txt' })).toHaveLength(1))
    expect(releaseAttachments).toHaveBeenCalledWith([secondUri])
  })

  it('applies the selected interface language across the conversation and export surfaces', async () => {
    const updateDshSetting = vi.fn().mockResolvedValue(undefined)
    currentStore = { ...storeFor(connectedState(true)), updateDshSetting }
    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    fireEvent.click(screen.getByRole('button', { name: 'Interface language' }))
    fireEvent.click(screen.getByRole('option', { name: '中文' }))

    expect(screen.getByRole('banner', { name: '对话' })).toBeDefined()
    expect(screen.getByPlaceholderText('输入消息…')).toBeDefined()
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDefined()
    expect(document.documentElement.lang).toBe('zh-CN')

    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '导出会话' })).toBeDefined())
    expect(screen.getByText('包含附件')).toBeDefined()
    expect(screen.getByRole('button', { name: '选择保存位置并导出' })).toBeDefined()
    await waitFor(() => expect(updateDshSetting).toHaveBeenCalledWith('locale.preference', 'zh'))
  })

  it('uses the Settings language control for the shared extension and DSH preference', async () => {
    const updateDshSetting = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor({ ...connectedState(true), drawer: 'settings' }),
      updateDshSetting,
    }

    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    const group = await screen.findByRole('group', { name: 'Interface language' })
    fireEvent.click(within(group).getByRole('button', { name: '中文' }))

    expect(document.documentElement.lang).toBe('zh-CN')
    await waitFor(() => expect(updateDshSetting).toHaveBeenCalledWith('locale.preference', 'zh'))
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
    const todoToggle = todoList?.querySelector<HTMLButtonElement>('.dsh-todo-list__toggle')
    expect(todoToggle?.textContent).toContain('执行子代理调研')
    expect(todoToggle?.textContent).not.toContain('查询系统信息')
    expect(container.querySelector('.dsh-conversation > .dsh-goal-strip')).toBeNull()
  })

  it('floats pending questions outside the composer layout', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      questions: [
        {
          id: 'question-1',
          sessionId: 's1',
          prompt: 'Choose a mode',
          choices: [{ id: 'chat', label: 'Chat' }],
          allowFreeText: false,
        },
      ],
    })
    const { container } = render(<App />)

    const interactions = container.querySelector('.dsh-conversation__interactions')
    expect(interactions).not.toBeNull()
    expect(interactions?.parentElement?.classList.contains('dsh-conversation')).toBe(true)
    expect(interactions?.getAttribute('aria-live')).toBe('polite')
    expect(container.querySelector('.dsh-compose-area .dsh-interaction')).toBeNull()
  })
})
