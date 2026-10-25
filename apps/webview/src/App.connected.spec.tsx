// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { HostMessage, FeatureHostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState, AppStore, DshSettingsSnapshot, OpenFileCandidate } from './app/store.js'
import type * as StoreModule from './app/store.js'

let currentStore: AppStore

vi.mock('./app/store.js', () => ({
  createAppStore: () => currentStore,
}))

vi.mock('./features/chat/Timeline.js', () => ({
  Timeline: (props: {
    readonly transcriptView?: string
    readonly performanceUsage?: string
    readonly codingToolsEnabled?: boolean
  }) => (
    <div
      data-testid="timeline"
      data-transcript-view={props.transcriptView}
      data-performance-usage={props.performanceUsage}
      data-coding-tools-enabled={props.codingToolsEnabled}
    >
      Timeline
    </div>
  ),
}))

import { App } from './App.js'
import { ConversationLayoutProvider } from './app/ConversationLayoutProvider.js'
import { CONVERSATION_FONT_SIZE_STORAGE_KEY, THEME_PREFERENCE_STORAGE_KEY } from './app/ui-preferences.js'
import { I18nProvider, LOCALE_EXPLICIT_STORAGE_KEY, LOCALE_STORAGE_KEY, useI18n } from './i18n.js'

function connectedState(activeSession: boolean): AppState {
  return {
    // The connection snapshot is a safe Host projection, not the full
    // Extension Host backend object.
    backend: { kind: 'connected' },
    connectionEpoch: 1,
    connectedDshVersion: '0.1.0-rc.6',
    subagentImagePrompts: false,
    dshCompatibilityWarning: undefined,
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
    archivedSessions: [],
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
    pendingSession: undefined,
    preferredOpenFileId: undefined,
    timeline: { sessionId: activeSession ? 's1' : undefined, nodes: [], lastSequence: -1 },
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
    sessionModelFailures: [],
    sessionModelCurrent: undefined,
    sessionModelRoutable: undefined,
    sessionModelDirectoryLoading: false,
    sessionModelDirectoryError: undefined,
    presets: [],
    permissionPresets: [],
    commands: [],
    pluginInventoryRevision: 0,
    pluginInstallProgress: undefined,
    pluginInstallOperation: undefined,
    accountLifecycleAvailable: false,
    accountLifecycle: null,
    accountLifecycleLoading: false,
    accountLifecycleBusy: false,
    accountLifecycleImpact: undefined,
    accountSessionExpired: false,
    accountLifecycleError: undefined,
    accountLifecycleRequestFailed: false,
    accountProfileDetails: null,
    accountProfileLoading: false,
    accountProfileRequestFailed: false,
    goals: [],
    todos: [],
    jobs: [],
    jobControllerAvailable: false,
    jobFollow: undefined,
    feedback: {},
    subagents: { entries: [], parentAvailable: false },
    activeSubagent: undefined,
    queue: [],
    editorContext: [],
    editorContextAvailableKinds: [],
    editorContextLoading: false,
    changes: [],
    changesLoading: false,
    changesRefreshFailed: false,
    tasks: [],
    tasksLoading: false,
    taskScope: 'current-session',
    tasksComplete: true,
    tasksOmittedSessions: 0,
    checkpoints: [],
    checkpointsLoading: false,
    promptTemplates: [],
    promptTemplatesLoading: false,
    promptMode: 'ask',
    permissions: [],
    questions: [],
    busyEnter: 'queue',
    drawer: undefined,
    surface: undefined,
    editorChats: 0,
  }
}

function dshUiSettingsSnapshot(
  enabled?: boolean,
  busyEnter?: 'queue' | 'steer',
  performanceUsage?: 'compact' | 'detailed',
): DshSettingsSnapshot {
  const fields: DshSettingsSnapshot['schema']['fields'][number][] = []
  const values: Record<string, unknown> = {}
  if (enabled !== undefined) {
    fields.push({
      path: 'ui-settings.enabled',
      label: 'enabled',
      type: 'boolean',
      required: false,
      restartRequired: false,
    })
    values['ui-settings'] = { enabled }
  }
  if (busyEnter !== undefined) {
    fields.push({
      path: 'ui-conversation.busyEnter',
      label: 'busyEnter',
      type: 'enum',
      required: false,
      enumValues: ['queue', 'steer'],
      restartRequired: false,
    })
    values['ui-conversation'] = { busyEnter }
  }
  if (performanceUsage !== undefined) {
    fields.push({
      path: 'ui-chat.performanceUsage',
      label: 'performanceUsage',
      type: 'enum',
      required: false,
      enumValues: ['compact', 'detailed'],
      restartRequired: false,
    })
    values['ui-chat'] = { performanceUsage }
  }
  return {
    schema: {
      version: 'rc2-settings-v1',
      writable: true,
      hasDocument: false,
      fields,
      namespaces: [
        ...(enabled === undefined
          ? []
          : [
              {
                ns: 'ui-settings',
                applies: 'live' as const,
                revision: 1,
                userFields: ['enabled'],
                secrets: [],
              },
            ]),
        ...(busyEnter === undefined
          ? []
          : [
              {
                ns: 'ui-conversation',
                applies: 'live' as const,
                revision: 1,
                userFields: ['busyEnter'],
                secrets: [],
              },
            ]),
        ...(performanceUsage === undefined
          ? []
          : [
              {
                ns: 'ui-chat',
                applies: 'live' as const,
                revision: 1,
                userFields: ['performanceUsage'],
                secrets: [],
              },
            ]),
      ],
    },
    values,
  }
}

function dshLocaleSettingsSnapshot(preference: string, advertised = true): DshSettingsSnapshot {
  const base = dshUiSettingsSnapshot()
  return {
    ...base,
    schema: {
      ...base.schema,
      fields: advertised
        ? [
            ...base.schema.fields,
            {
              path: 'locale.preference',
              label: 'preference',
              type: 'string',
              required: false,
              restartRequired: false,
            },
          ]
        : base.schema.fields,
      namespaces: advertised
        ? [
            ...base.schema.namespaces,
            {
              ns: 'locale',
              applies: 'live',
              revision: 1,
              userFields: ['preference'],
              secrets: [],
            },
          ]
        : base.schema.namespaces,
    },
    values: { locale: { preference } },
  }
}

function storeFor(state: AppState): AppStore {
  return {
    ...state,
    getState: () => state,
    subscribe: () => () => undefined,
    watchSessionTurnEnd: vi.fn(() => ({ completion: Promise.resolve(), dispose: vi.fn() })),
    initialize: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    readDiagnostics: vi.fn().mockResolvedValue(undefined),
    showDiagnostics: vi.fn().mockResolvedValue(undefined),
    configureConnection: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    searchSessions: vi.fn().mockResolvedValue({ items: [] }),
    refreshCommands: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn().mockResolvedValue(undefined),
    openSessionInEditor: vi.fn().mockResolvedValue(undefined),
    runMovetoCommand: vi.fn().mockResolvedValue('editor'),
    loadOlderHistory: vi.fn().mockResolvedValue(undefined),
    navigateTranscript: vi.fn().mockResolvedValue(undefined),
    openTranscriptContent: vi.fn().mockResolvedValue(undefined),
    loadTranscriptContent: vi.fn().mockResolvedValue(''),
    loadTranscriptNode: vi.fn().mockRejectedValue(new Error('Unavailable')),
    dismissPendingPrompt: vi.fn(),
    forgetDirectPromptRequests: vi.fn(),
    refreshQueue: vi.fn().mockResolvedValue([]),
    openSubagent: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    renameWorkspace: vi.fn().mockResolvedValue(undefined),
    addWorkspaceFolder: vi.fn().mockResolvedValue(undefined),
    openSkillDocument: vi.fn().mockResolvedValue(undefined),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    moveWorkspace: vi.fn().mockResolvedValue(undefined),
    moveSession: vi.fn().mockResolvedValue(undefined),
    forkSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(undefined),
    stageSession: vi.fn().mockResolvedValue(undefined),
    configurePendingSession: vi.fn(),
    sendPendingPrompt: vi.fn().mockResolvedValue(undefined),
    removeSession: vi.fn().mockResolvedValue(undefined),
    loadArchivedSessions: vi.fn().mockResolvedValue(undefined),
    restoreSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    configureSession: vi.fn(),
    executeCommand: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    followJob: vi.fn().mockResolvedValue(undefined),
    stopFollowingJob: vi.fn().mockResolvedValue(undefined),
    killJob: vi.fn().mockResolvedValue('requested'),
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
    readDshSettings: vi.fn().mockResolvedValue(dshUiSettingsSnapshot()),
    openDshSettingsDocument: vi.fn().mockResolvedValue(undefined),
    openKeyboardShortcuts: vi.fn().mockResolvedValue(undefined),
    updateDshSetting: vi.fn().mockResolvedValue(undefined),
    unsetDshSetting: vi.fn().mockResolvedValue(undefined),
    mutateDshSettings: vi.fn().mockResolvedValue(undefined),
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
    refreshSessionModels: vi.fn().mockResolvedValue(undefined),
    loadPresetRoster: vi.fn().mockResolvedValue(undefined),
    readPresetDocument: vi.fn().mockResolvedValue(undefined),
    copyPreset: vi.fn().mockResolvedValue(undefined),
    removePreset: vi.fn().mockResolvedValue(undefined),
    openPresetDocument: vi.fn().mockResolvedValue(undefined),
    loadPluginInventory: vi.fn().mockResolvedValue(undefined),
    startPluginInstall: vi.fn().mockResolvedValue(undefined),
    cancelPluginInstall: vi.fn().mockResolvedValue(undefined),
    recoverPluginInstall: vi.fn().mockResolvedValue(undefined),
    loadSubagentChildren: vi.fn().mockResolvedValue(undefined),
    updateGoal: vi.fn().mockResolvedValue(undefined),
    clearGoal: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue(undefined),
    moveChatToSidebar: vi.fn().mockResolvedValue(undefined),
    setDrawer: vi.fn(),
    featureRequest: vi.fn().mockResolvedValue(undefined),
    subscribeFeature: vi.fn(() => () => undefined),
    loadAccountLifecycle: vi.fn().mockResolvedValue(undefined),
    startAccountSignIn: vi.fn().mockResolvedValue(undefined),
    cancelAccountSignIn: vi.fn().mockResolvedValue(undefined),
    checkAccountSignOutImpact: vi.fn().mockResolvedValue(undefined),
    signOutAccount: vi.fn().mockResolvedValue(undefined),
    loadAccountDetails: vi.fn().mockResolvedValue(undefined),
    acknowledgeAccountBonus: vi.fn().mockResolvedValue(true),
    openAccountPage: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  }
}

function ActiveLocaleOutput(): ReactElement {
  const { locale } = useI18n()
  return <output data-testid="active-locale">{locale}</output>
}

function renderWithMutableState(initialState: AppState): {
  readonly stageSessionCalls: Array<[string | undefined, string | undefined]>
  readonly updateState: (state: AppState) => void
} {
  let currentState = initialState
  const stageSessionCalls: Array<[string | undefined, string | undefined]> = []
  const store: AppStore = {
    ...storeFor(initialState),
    getState: () => currentState,
    stageSession: vi.fn((workspaceId?: string, presetId?: string) => {
      stageSessionCalls.push([workspaceId, presetId])
      return Promise.resolve()
    }),
  }
  currentStore = store
  const view = render(<App />)
  return {
    stageSessionCalls,
    updateState: (state) => {
      currentState = state
      view.rerender(<App />)
    },
  }
}

function presetSelectionState(enabled: boolean, defaultPresetId: string | undefined): AppState {
  return {
    ...connectedState(false),
    presetSelectionEnabled: enabled,
    presets: ['standard', 'alternate', 'updated-default'].map((id) => ({
      id,
      trust: 'system' as const,
      isDefault: id === defaultPresetId,
      name: id,
    })),
  }
}

async function selectEmptySessionPreset(presetId: string): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector('.dsh-empty-session__preset .dsh-select-menu__trigger')).not.toBeNull(),
  )
  const trigger = document.querySelector('.dsh-empty-session__preset .dsh-select-menu__trigger')
  if (trigger === null) throw new Error('preset selection did not appear after DSH settings loaded')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('option', { name: presetId }))
}

describe('App connected rendering', () => {
  it.each(['ordinary', 'approval', 'question'] as const)(
    'delivers %s Stop through the real store, protocol and Host router despite a failed model catalog',
    async (mode) => {
      const { createAppStore } = await vi.importActual<typeof StoreModule>('./app/store.js')
      const { ProtocolClient } = await import('./app/protocol-client.js')
      // Load the actual Host at runtime: it belongs to a separate TypeScript
      // project. This narrow test port keeps Host implementation types out of UI.
      const { WebviewMessageRouter } = await vi.importActual<{
        WebviewMessageRouter: new (dependencies: {
          postMessage: (message: HostMessage | FeatureHostMessage) => Promise<boolean>
          handleRequest: (request: WebviewRequest) => Promise<unknown>
          handleFeatureRequest: () => Promise<unknown>
        }) => { handle(message: unknown, surfaceId: string): Promise<void>; cancelAll(): void }
      }>('../../extension/src/view/message-router.js')
      const { AppError } = await import('@dsh-vscode/domain')
      const { transcriptWindowFixture } = await vi.importActual<{
        transcriptWindowFixture: () => {
          forSurface(surfaceId: string): {
            begin(sessionId: string): number
            installPage(
              sessionId: string,
              page: { readonly events: readonly never[]; readonly hasMore: boolean },
              generation: number,
            ): unknown
          }
          dispose(): void
        }
      }>('../../extension/src/view/transcript-window.fixture.js')
      const transcripts = transcriptWindowFixture()
      const transcript = transcripts.forSurface('sidebar')
      const initial = connectedState(true)
      const requests: Array<{ type: string; payload?: unknown }> = []
      let failStop = true
      const router = new WebviewMessageRouter({
        postMessage: (message) => {
          window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: 1, message } }))
          return Promise.resolve(true)
        },
        handleRequest: (request) => {
          requests.push(request)
          if (request.type === 'session.open')
            return Promise.resolve({
              ...initial.sessions[0],
              configuration: initial.configuration,
              history: [],
              transcript: transcript.installPage(
                request.payload.sessionId,
                { events: [], hasMore: false },
                transcript.begin(request.payload.sessionId),
              ),
            })
          if (request.type === 'models.session.list')
            throw new AppError({
              code: 'BACKEND_UNREACHABLE',
              message: 'Catalog unavailable',
              retryable: true,
            })
          if (request.type === 'session.cancel' && failStop)
            throw new AppError({
              code: 'BACKEND_UNREACHABLE',
              message: 'Stop delivery failed',
              retryable: true,
            })
          if (request.type === 'subagent.list') return Promise.resolve({ entries: [], parentAvailable: true })
          return Promise.resolve([])
        },
        handleFeatureRequest: () => Promise.resolve({ kind: 'empty' }),
      })
      const client = new ProtocolClient({
        getState: () => undefined,
        setState: () => undefined,
        postMessage: (message) => {
          void router.handle(message, 'sidebar')
        },
      })
      const realStore = createAppStore(client)
      try {
        await realStore.openSession('s1')
        const permissions: AppState['permissions'] =
          mode === 'approval'
            ? [
                {
                  id: 'p1',
                  sessionId: 's1',
                  title: 'User approval',
                  description: 'Choose an action',
                  risk: 'low',
                  options: [{ id: 'custom-deny-id', label: 'Reject', kind: 'deny' }],
                },
              ]
            : []
        const questions: AppState['questions'] =
          mode === 'question'
            ? [
                {
                  id: 'q1',
                  sessionId: 's1',
                  prompt: 'Choose a mode',
                  choices: [],
                  allowFreeText: true,
                },
              ]
            : []
        const sessions = initial.sessions.map((session) => ({ ...session, status: 'running' as const }))
        const backend = { kind: 'connected' as const }
        let source = realStore.getState()
        let snapshot = { ...source, backend, permissions, questions, sessions }
        currentStore = {
          ...realStore,
          initialize: () => Promise.resolve(),
          getState: () => {
            const next = realStore.getState()
            if (next !== source) {
              source = next
              snapshot = { ...next, backend, permissions, questions, sessions }
            }
            return snapshot
          },
        }
        render(<App />)
        const stop = screen.getByRole('button', { name: 'Stop response' })
        expect(stop.hasAttribute('disabled')).toBe(false)
        fireEvent.click(stop)
        await screen.findByText('The local DSH instance is unreachable.')
        expect(requests.filter((request) => request.type === 'session.cancel')).toEqual([
          expect.objectContaining({ payload: { sessionId: 's1' } }),
        ])
        failStop = false
        fireEvent.click(stop)
        await waitFor(() =>
          expect(requests.filter((request) => request.type === 'session.cancel')).toHaveLength(2),
        )
        if (mode === 'approval') {
          fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
          await waitFor(() =>
            expect(requests).toContainEqual(
              expect.objectContaining({
                type: 'interaction.permission.respond',
                payload: { interactionId: 'p1', optionId: 'custom-deny-id' },
              }),
            ),
          )
        }
      } finally {
        cleanup()
        realStore.dispose()
        transcripts.dispose()
        router.cancelAll()
      }
    },
    30_000,
  )

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    document.documentElement.lang = 'en'
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

  it('keeps sidebar composition and new-session controls available beside editor chats', () => {
    const stageSession = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor({ ...connectedState(true), surface: { kind: 'sidebar' }, editorChats: 2 }),
      stageSession,
    }
    render(<App />)

    expect(screen.getByTestId('timeline')).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    expect(stageSession).toHaveBeenCalledWith('w1', undefined)
  })

  it('runs the client /moveto command instead of sending it to DSH', async () => {
    const executeCommand = vi.fn().mockResolvedValue(true)
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const runMovetoCommand = vi.fn().mockResolvedValue('editor')
    currentStore = {
      ...storeFor({
        ...connectedState(true),
        commands: [{ name: 'moveto', description: 'Move the chat', input: { hint: '[editor|sidebar]' } }],
      }),
      executeCommand,
      sendPrompt,
      runMovetoCommand,
    }
    render(<App />)

    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: '/moveto:editor' } })
    await act(async () => {
      fireEvent.keyDown(prompt, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(runMovetoCommand).toHaveBeenCalledWith('/moveto editor')
    expect(executeCommand).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('reports an unusable /moveto target on the error surface', async () => {
    const executeCommand = vi.fn().mockResolvedValue(true)
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const runMovetoCommand = vi.fn().mockResolvedValue('unknown-target')
    currentStore = {
      ...storeFor({
        ...connectedState(true),
        commands: [{ name: 'moveto', description: 'Move the chat', input: { hint: '[editor|sidebar]' } }],
      }),
      executeCommand,
      sendPrompt,
      runMovetoCommand,
    }
    render(<App />)

    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: '/moveto:bogus' } })
    await act(async () => {
      fireEvent.keyDown(prompt, { key: 'Enter' })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unknown /moveto'))
    expect(executeCommand).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('renders the conversation on an editor surface even while editor tabs exist', () => {
    currentStore = storeFor({
      ...connectedState(true),
      surface: { kind: 'editor', sessionId: 's1' },
      editorChats: 1,
    })
    render(<App />)

    expect(screen.queryByRole('heading', { name: 'Chat is open in the editor area' })).toBeNull()
    expect(screen.getByTestId('timeline')).toBeDefined()
  })

  it('releases an accepted idle send before its durable message while reconciling Inbox state', async () => {
    let state = connectedState(true)
    const listeners = new Set<() => void>()
    const publish = (next: AppState): void => {
      state = next
      for (const listener of listeners) listener()
    }
    let acknowledge!: () => void
    const ack = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    currentStore = {
      ...storeFor(state),
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      sendPrompt: vi.fn(() => {
        publish({
          ...state,
          directPromptRequestIds: ['direct-request'],
          directPromptReceipts: [
            {
              id: 'pending:direct-request',
              rpcId: 'direct-request',
              sessionId: 's1',
              text: 'Hello',
              attachments: [],
              textOnly: true,
              mode: 'queue',
              createdAt: '2026-01-01T00:00:00.000Z',
              queueIdsBefore: [],
            },
          ],
          queue: [
            {
              id: 'direct-message',
              rpcId: 'direct-request',
              textOnly: true,
              sessionId: 's1',
              text: 'Hello',
              attachments: [],
              mode: 'queue',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
        return ack
      }),
    }
    render(<App />)
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.change(input, { target: { value: 'Hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('Hello')
    // The direct send remains in the composer even when native inbox admission
    // briefly projects a queue row. It must never flash in the queue dock.
    expect(state.queue).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'Queued prompts' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel sending' }).getAttribute('aria-busy')).toBe('true')
    await act(async () => {
      acknowledge()
      await ack
    })
    expect(input.value).toBe('')
    expect(screen.queryByRole('button', { name: 'Cancel sending' })).toBeNull()
    // Identity wins even if DSH expands a reference in the displayed text.
    act(() => {
      publish({
        ...state,
        queue: [],
        timeline: {
          ...state.timeline,
          nodes: [
            {
              kind: 'user-message',
              id: 'direct-message',
              rpcId: 'direct-request',
              markdown: 'Hello (expanded reference)',
            },
          ],
        },
      })
    })
    await waitFor(() => {
      expect(input.value).toBe('')
      expect(screen.queryByRole('button', { name: 'Cancel sending' })).toBeNull()
    })
    expect(screen.queryByRole('region', { name: 'Queued prompts' })).toBeNull()
  })

  it.each([
    { cancelled: false, receipt: 'matching' },
    { cancelled: true, receipt: 'matching' },
    { cancelled: false, receipt: 'different' },
    { cancelled: false, receipt: 'failed' },
    { cancelled: false, receipt: 'recovered' },
    { cancelled: true, receipt: 'recovered' },
  ])(
    'checks a long admitted prompt against full content: $receipt, cancelled=$cancelled',
    async ({ cancelled, receipt }) => {
      let state = connectedState(true)
      const listeners = new Set<() => void>()
      const publish = (next: AppState): void => {
        state = next
        for (const listener of listeners) listener()
      }
      const text = 'Long prompt '.repeat(12_000)
      const loadTranscriptContent =
        receipt === 'recovered'
          ? vi.fn().mockRejectedValueOnce(new Error('Transient history failure')).mockResolvedValue(text)
          : receipt === 'failed'
            ? vi.fn().mockRejectedValue(new Error('History unavailable'))
            : vi.fn().mockResolvedValue(receipt === 'matching' ? text : `${text}different suffix`)
      currentStore = {
        ...storeFor(state),
        getState: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        sendPrompt: vi.fn((_id, _text, _attachments, _mode, signal?: AbortSignal) => {
          publish({ ...state, directPromptRequestIds: ['request'] })
          if (cancelled)
            return new Promise<void>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
                once: true,
              })
            })
          return Promise.resolve()
        }),
        loadTranscriptContent,
      }
      render(<App />)
      const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
      fireEvent.change(input, { target: { value: text } })
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' })
        await Promise.resolve()
      })
      if (cancelled)
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Cancel sending' }))
          await Promise.resolve()
        })
      const nodes: AppState['timeline']['nodes'] = [
        { kind: 'user-message', id: 'admitted', markdown: text.slice(0, 128 * 1024) },
      ]
      act(() =>
        publish({
          ...state,
          timeline: { ...state.timeline, nodes },
          transcript: {
            sessionId: 's1',
            revision: 1,
            nodes,
            lastSequence: 1,
            hasMore: false,
            historical: false,
            omittedNodeIds: ['admitted'],
            eventFacts: [],
          },
        }),
      )
      await waitFor(() => expect(loadTranscriptContent).toHaveBeenCalledWith('admitted'))
      if (!cancelled || receipt === 'matching' || receipt === 'recovered')
        await waitFor(() => expect(input.value.length).toBe(0))
      else expect(input.value).toBe(text)
    },
  )

  it('accepts a direct send that DSH actually queued when the row has no request identity', async () => {
    vi.useFakeTimers()
    try {
      let state = connectedState(true)
      const listeners = new Set<() => void>()
      const publish = (next: AppState): void => {
        state = next
        for (const listener of listeners) listener()
      }
      const queuedRow = {
        id: 'queued-behind-direct',
        sessionId: 's1',
        text: 'Hello',
        attachments: [],
        textOnly: true,
        mode: 'queue' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
      }
      const refreshQueue = vi.fn(() => {
        publish({ ...state, queue: [queuedRow] })
        return Promise.resolve([queuedRow])
      })
      currentStore = {
        ...storeFor(state),
        getState: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        sendPrompt: vi.fn(() => {
          publish({ ...state, directPromptRequestIds: ['direct-request'] })
          return Promise.resolve()
        }),
        refreshQueue,
      }
      render(<App />)
      const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
      fireEvent.change(input, { target: { value: 'Hello' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await act(async () => {
        await Promise.resolve()
      })
      expect(input.value).toBe('')

      // rc.6 queue rows cannot name the request, so the timeout check must
      // recognize this new row by its content instead of failing the send.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(refreshQueue).toHaveBeenCalledWith('s1')
      expect(input.value).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases an accepted draft immediately and preserves a newer draft when its transcript arrives', async () => {
    let state = connectedState(true)
    const listeners = new Set<() => void>()
    const publish = (next: AppState): void => {
      state = next
      for (const listener of listeners) listener()
    }
    const sendPrompt = vi.fn(() => {
      publish({ ...state, directPromptRequestIds: ['accepted-request'] })
      return Promise.resolve()
    })
    currentStore = {
      ...storeFor(state),
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      forgetDirectPromptRequests: (ids) =>
        publish({
          ...state,
          directPromptRequestIds: (state.directPromptRequestIds ?? []).filter((id) => !ids.includes(id)),
        }),
      sendPrompt,
    }
    render(<App />)
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.change(input, { target: { value: 'accepted before cancel' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: 'Cancel sending' })).toBeNull()
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'new draft' } })
    act(() =>
      publish({
        ...state,
        timeline: {
          ...state.timeline,
          nodes: [
            {
              kind: 'user-message',
              id: 'accepted-message',
              rpcId: 'accepted-request',
              markdown: 'accepted before cancel',
            },
          ],
        },
      }),
    )
    await waitFor(() => expect(input.value).toBe('new draft'))
  })

  it('clears the cancelled draft when the accepted direct turn arrives late', async () => {
    let state = connectedState(true)
    const listeners = new Set<() => void>()
    const publish = (next: AppState): void => {
      state = next
      for (const listener of listeners) listener()
    }
    const sendPrompt = vi.fn(
      (
        _sessionId: string,
        _text: string,
        _attachments: Parameters<AppStore['sendPrompt']>[2],
        _mode: Parameters<AppStore['sendPrompt']>[3],
        signal?: AbortSignal,
      ) => {
        publish({ ...state, directPromptRequestIds: ['direct-request'] })
        return new Promise<void>((_resolve, reject) => {
          const abort = (): void => reject(new DOMException('Cancelled', 'AbortError'))
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
    )
    currentStore = {
      ...storeFor(state),
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      sendPrompt,
    }
    render(<App />)
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.change(input, { target: { value: 'late delivery' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel sending' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sending' }))
    await act(async () => {
      await Promise.resolve()
    })
    // The RPC was already accepted; the durable row proves the cancellation
    // stopped only the local wait and must release the sent draft.
    act(() => {
      publish({
        ...state,
        timeline: {
          ...state.timeline,
          nodes: [
            {
              kind: 'user-message',
              id: 'late-message',
              rpcId: 'direct-request',
              markdown: 'late delivery',
            },
          ],
        },
      })
    })
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('shows the native permission default through the main new-session composer', async () => {
    const configuration = { ...connectedState(true).configuration!, permissionPresetKnown: false }
    const state = {
      ...connectedState(false),
      pendingSession: { revision: 1, workspaceId: 'w1', configuration },
      newSessionPermissionPresets: ['read-only', 'organization-safe'],
      newSessionPermissionDefault: 'read-only',
    }
    const choose = vi.fn()
    currentStore = { ...storeFor(state), configurePendingSession: choose }
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Access: Unknown permission' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Access: Read Only' }))
    fireEvent.click(screen.getByRole('option', { name: 'Organization Safe' }))
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({ permissionPreset: 'organization-safe', permissionPresetKnown: true }),
    )
  })

  it('renders a local draft and routes its first message through deferred creation', async () => {
    const state = connectedState(false)
    const sendPendingPrompt = vi.fn().mockResolvedValue(undefined)
    const createSession = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor({
        ...state,
        pendingSession: {
          revision: 1,
          workspaceId: 'w1',
          configuration: connectedState(true).configuration!,
        },
      }),
      sendPendingPrompt,
      createSession,
    }
    render(<App />)

    const input = document.querySelector('.dsh-composer textarea')
    expect(input).toBeInstanceOf(HTMLTextAreaElement)
    expect(screen.queryByText('Welcome to DSH')).toBeNull()
    fireEvent.change(input!, { target: { value: 'Hello' } })
    const form = input?.closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form!)

    await waitFor(() =>
      expect(sendPendingPrompt).toHaveBeenCalledWith('Hello', [], 'queue', expect.any(AbortSignal)),
    )
    expect(createSession).not.toHaveBeenCalled()
  })

  it('keeps a failed active prompt for retry without rendering an untrusted error message', async () => {
    let rejectSubmission: (reason: Error) => void = () => undefined
    const submission = new Promise<void>((_resolve, reject) => {
      rejectSubmission = reject
    })
    const sendPrompt = vi.fn().mockReturnValueOnce(submission).mockResolvedValue(undefined)
    currentStore = { ...storeFor(connectedState(true)), sendPrompt }
    render(<App />)

    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: 'retry this prompt' } })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith(
        's1',
        'retry this prompt',
        [],
        'queue',
        expect.any(AbortSignal),
      ),
    )
    expect(screen.getByRole('button', { name: 'Cancel sending' }).hasAttribute('disabled')).toBe(false)

    await act(async () => {
      rejectSubmission(new Error('Host delivery failed: raw prompt diagnostics'))
      await submission.catch(() => undefined)
    })

    expect(await screen.findByText('Prompt failed.')).toBeDefined()
    expect(screen.queryByText('Host delivery failed: raw prompt diagnostics')).toBeNull()
    expect(prompt.value).toBe('retry this prompt')
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false)

    fireEvent.keyDown(prompt, { key: 'Enter' })
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2))
  })

  it('sanitizes a failed empty-draft queue steer and permits retry after settlement', async () => {
    const active = connectedState(true)
    const runningState = {
      ...active,
      sessions: active.sessions.map((session) => ({ ...session, status: 'running' as const })),
      queue: [
        {
          id: 'queue-1',
          sessionId: 's1',
          text: 'queued follow-up',
          attachments: [],
          textOnly: true,
          mode: 'queue' as const,
          createdAt: '2026-08-17T05:00:00.000Z',
        },
      ],
    }
    const steerAllQueued = vi
      .fn()
      .mockRejectedValueOnce(new Error('raw queue transport diagnostic'))
      .mockResolvedValue(undefined)
    currentStore = { ...storeFor(runningState), steerAllQueued }
    render(<App />)

    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true })
    expect(steerAllQueued).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Steering the queue failed.')).toBeDefined()
    expect(screen.queryByText('raw queue transport diagnostic')).toBeNull()

    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(steerAllQueued).toHaveBeenCalledTimes(2))
  })

  it('retains attachments after a failed busy steer and retries with the accelerated queue mode', async () => {
    const active = connectedState(true)
    const runningState = {
      ...active,
      sessions: active.sessions.map((session) => ({ ...session, status: 'running' as const })),
    }
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000021'
    const attachment = { uri, name: 'notes.txt', mimeType: 'text/plain' }
    let rejectFirstSubmission: ((reason: Error) => void) | undefined
    const firstSubmission = new Promise<void>((_resolve, reject) => {
      rejectFirstSubmission = reject
    })
    const sendPrompt = vi.fn().mockReturnValueOnce(firstSubmission).mockResolvedValue(undefined)
    const ingestAttachment = vi.fn().mockResolvedValue(attachment)
    const readDshSettings = vi.fn().mockResolvedValue(dshUiSettingsSnapshot(true, 'steer'))
    currentStore = {
      ...storeFor(runningState),
      ingestAttachment,
      readDshSettings,
      sendPrompt,
    }
    render(<App />)

    await waitFor(() => expect(readDshSettings).toHaveBeenCalled())
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.paste(prompt, {
      clipboardData: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(ingestAttachment).toHaveBeenCalled())
    await screen.findByRole('button', { name: 'Remove notes.txt' })

    fireEvent.change(prompt, { target: { value: 'retry with the attachment' } })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith(
        's1',
        'retry with the attachment',
        [attachment],
        'steer',
        expect.any(AbortSignal),
      ),
    )
    fireEvent.keyDown(prompt, { key: 'Enter' })
    expect(sendPrompt).toHaveBeenCalledTimes(1)

    await act(async () => {
      rejectFirstSubmission?.(new Error('Host delivery failed: raw prompt diagnostics'))
      await firstSubmission.catch(() => undefined)
    })
    expect(await screen.findByText('Prompt failed.')).toBeDefined()
    expect(prompt.value).toBe('retry with the attachment')
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeDefined()

    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith(
        's1',
        'retry with the attachment',
        [attachment],
        'queue',
        expect.any(AbortSignal),
      ),
    )
    expect(sendPrompt).toHaveBeenCalledTimes(2)
  })

  it('lets the Host resolve the default after preset selection is disabled', async () => {
    const initialState = presetSelectionState(true, 'standard')
    const { stageSessionCalls, updateState } = renderWithMutableState(initialState)
    await selectEmptySessionPreset('alternate')

    updateState(presetSelectionState(false, 'standard'))
    fireEvent.click(screen.getByRole('button', { name: 'New session here' }))

    expect(stageSessionCalls).toEqual([['w1', undefined]])
  })

  it('tracks the Host default while the new-session page is open', async () => {
    const initialState = presetSelectionState(true, 'standard')
    const { stageSessionCalls, updateState } = renderWithMutableState(initialState)
    updateState(presetSelectionState(true, 'updated-default'))
    await waitFor(() =>
      expect(document.querySelector('.dsh-empty-session__preset .dsh-select-menu__trigger')).not.toBeNull(),
    )
    const presetPicker = document.querySelector('.dsh-empty-session__preset .dsh-select-menu__trigger')
    expect(presetPicker?.textContent ?? '').toContain('updated-default')
    fireEvent.click(screen.getByRole('button', { name: 'New session here' }))

    expect(stageSessionCalls).toEqual([['w1', undefined]])
  })

  it('uses a manual preset for one new task, then returns to the latest Host default', async () => {
    const { stageSessionCalls, updateState } = renderWithMutableState(presetSelectionState(true, 'standard'))
    await selectEmptySessionPreset('alternate')
    fireEvent.click(screen.getByRole('button', { name: 'New session here' }))

    updateState(connectedState(true))
    updateState(presetSelectionState(true, 'updated-default'))
    await waitFor(() =>
      expect(document.querySelector('.dsh-empty-session__preset .dsh-select-menu__trigger')).not.toBeNull(),
    )
    const presetPicker = document.querySelector('.dsh-empty-session__preset .dsh-select-menu__trigger')
    expect(presetPicker?.textContent ?? '').toContain('updated-default')
    fireEvent.click(screen.getByRole('button', { name: 'New session here' }))

    expect(stageSessionCalls).toEqual([
      ['w1', 'alternate'],
      ['w1', undefined],
    ])
  })

  it('creates through Host composition when the optional preset registry is empty', () => {
    const state = { ...connectedState(false), presetSelectionEnabled: false, presets: [] }
    const { stageSessionCalls } = renderWithMutableState(state)
    const createButton = screen.getByRole('button', { name: 'New session here' })

    expect((createButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(createButton)

    expect(stageSessionCalls).toEqual([['w1', undefined]])
  })

  it('blocks session creation when preset selection is disabled and the roster has no default', () => {
    const { stageSessionCalls } = renderWithMutableState(presetSelectionState(false, undefined))
    const createButton = screen.getByRole('button', { name: 'New session here' })

    expect((createButton as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(/DSH did not provide a default preset, and preset selection is unavailable/),
    ).toBeDefined()
    fireEvent.click(createButton)

    expect(stageSessionCalls).toEqual([])
  })

  it.each([
    ['idle', 'Preparing DSH connection'],
    ['starting', 'Starting DSH'],
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

  it('restores and applies the conversation font size from General settings', async () => {
    window.localStorage.setItem(CONVERSATION_FONT_SIZE_STORAGE_KEY, 'large')
    currentStore = storeFor({ ...connectedState(true), drawer: 'settings' })
    render(<App />)

    expect(document.querySelector('.dsh-conversation')?.getAttribute('data-conversation-font-size')).toBe(
      'large',
    )
    // The first settings opening loads a separate chunk; allow module loading
    // under the full parallel suite before checking the actual preference write.
    fireEvent.click(await screen.findByRole('button', { name: 'Small' }, { timeout: 5_000 }))

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

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Trajectory' })).toBeDefined())
    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))

    await waitFor(() => expect(screen.getByLabelText('Trajectory ledger')).toBeDefined())
  })

  it('keeps both conversation views available when Coding Tools is disabled', async () => {
    const readDshSettings = vi.fn().mockResolvedValue(dshUiSettingsSnapshot(false))
    currentStore = { ...storeFor(connectedState(true)), readDshSettings }
    render(<App />)

    await waitFor(() => expect(readDshSettings).toHaveBeenCalled())
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'Trajectory' })).toBeDefined()
    expect(screen.getByTestId('timeline')).toBeDefined()
    fireEvent.click(screen.getByRole('tab', { name: 'Trajectory' }))
    await screen.findByLabelText('Trajectory ledger')
  })

  it.each(['pending', 'unavailable', 'disabled'] as const)(
    'shows usable view tabs when opening a session from the initial page with %s settings',
    async (settings) => {
      let state: AppState = {
        ...connectedState(false),
        pendingSession: {
          revision: 1,
          workspaceId: 'w1',
          configuration: connectedState(true).configuration!,
        },
      }
      const listeners = new Set<() => void>()
      let resolveSettings!: (value: DshSettingsSnapshot) => void
      const pendingSettings = new Promise<DshSettingsSnapshot>((resolve) => {
        resolveSettings = resolve
      })
      const readDshSettings = vi.fn(() =>
        settings === 'pending'
          ? pendingSettings
          : settings === 'unavailable'
            ? Promise.reject(new Error('settings unavailable'))
            : Promise.resolve(dshUiSettingsSnapshot(false)),
      )
      currentStore = {
        ...storeFor(state),
        getState: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        readDshSettings,
        openSession: vi.fn(() => {
          state = { ...connectedState(true), pendingSession: undefined }
          for (const listener of listeners) listener()
          return Promise.resolve()
        }),
      }
      render(<App />)
      expect(screen.queryByRole('tab', { name: 'Trajectory' })).toBeNull()
      await act(async () => {
        await currentStore.openSession('s1')
      })
      const chat = screen.getByRole('tab', { name: 'Chat' })
      const trajectory = screen.getByRole('tab', { name: 'Trajectory' })
      expect(chat.getAttribute('aria-selected')).toBe('true')
      fireEvent.keyDown(chat, { key: 'ArrowRight' })
      await screen.findByLabelText('Trajectory ledger')
      expect(trajectory.getAttribute('aria-selected')).toBe('true')
      // A late settings response must not reset the reader's chosen view.
      if (settings === 'pending')
        await act(async () => {
          resolveSettings(dshUiSettingsSnapshot(false))
          await pendingSettings
        })
      expect(screen.getByRole('tab', { name: 'Trajectory' }).getAttribute('aria-selected')).toBe('true')
      fireEvent.click(chat)
      expect(screen.getByTestId('timeline')).toBeDefined()
    },
  )

  it('uses the accepted Host busy-send value after a successful write even if refresh fails', async () => {
    const active = connectedState(true)
    const runningState = {
      ...active,
      drawer: 'settings' as const,
      sessions: active.sessions.map((session) => ({ ...session, status: 'running' as const })),
    }
    const readDshSettings = vi
      .fn()
      .mockResolvedValueOnce(dshUiSettingsSnapshot(true, 'queue'))
      .mockResolvedValueOnce(dshUiSettingsSnapshot(true, 'queue'))
      .mockRejectedValue(new Error('refresh unavailable'))
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const updateDshSetting = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor(runningState),
      readDshSettings,
      sendPrompt,
      updateDshSetting,
    }
    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    const busyEnter = await screen.findByRole('group', { name: 'Enter while running' })
    fireEvent.click(within(busyEnter).getByRole('button', { name: 'steer' }))
    await waitFor(() =>
      expect(updateDshSetting).toHaveBeenCalledWith('ui-conversation.busyEnter', 'steer', 1),
    )
    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(3))
    expect(within(busyEnter).getByRole('button', { name: 'steer' }).getAttribute('aria-pressed')).toBe('true')

    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: 'follow-up' } })
    fireEvent.keyDown(prompt, { key: 'Enter' })

    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith('s1', 'follow-up', [], 'steer', expect.any(AbortSignal)),
    )
    expect(updateDshSetting).toHaveBeenCalledTimes(1)
  })

  it('does not replay a rejected settings write when its refresh also fails', async () => {
    const readDshSettings = vi
      .fn()
      .mockResolvedValueOnce(dshUiSettingsSnapshot(true, 'queue'))
      .mockResolvedValueOnce(dshUiSettingsSnapshot(true, 'queue'))
      .mockRejectedValue(new Error('refresh unavailable'))
    const updateDshSetting = vi.fn().mockRejectedValue(new Error('write rejected'))
    const state = { ...connectedState(true), drawer: 'settings' as const }
    const store: AppStore = {
      ...storeFor(state),
      getState: () => state,
      readDshSettings,
      updateDshSetting,
    }
    currentStore = store
    const view = render(<App />)

    const busyEnter = await screen.findByRole('group', { name: 'Enter while running' })
    fireEvent.click(within(busyEnter).getByRole('button', { name: 'steer' }))
    await waitFor(() => expect(updateDshSetting).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(3))

    view.rerender(<App />)

    expect(updateDshSetting).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('timeline').getAttribute('data-coding-tools-enabled')).toBe('false')
  })

  it('keeps new-session mode selection when rc2 Developer Tools is off', async () => {
    // Coding Tools only removes the shipped PTC/Minimal presets upstream; it
    // never refuses a preset switch. The Host's own roster answer is the only
    // refusal that may withdraw the choice.
    const state = presetSelectionState(true, 'standard')
    const readDshSettings = vi.fn().mockResolvedValue(dshUiSettingsSnapshot(false))
    currentStore = {
      ...storeFor(state),
      readDshSettings,
    }
    render(<App />)

    await waitFor(() => expect(readDshSettings).toHaveBeenCalled())
    await waitFor(() =>
      expect(document.querySelector('.dsh-empty-session__preset .dsh-select-menu__trigger')).not.toBeNull(),
    )
  })

  it('exposes tabpanel relationships and arrow-key navigation for conversation views', async () => {
    currentStore = storeFor(connectedState(true))
    render(<App />)

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Trajectory' })).toBeDefined())
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

    const updateNotice = screen.getByText('DSH update available').closest('.dsh-app__notice-summary')
    const notices = document.querySelector('.dsh-app__notices')
    expect(updateNotice?.parentElement).toBe(notices)
    expect(document.querySelector('.dsh-app__notice-list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show notifications (2)' }))
    expect(screen.getByText('Welcome to DSH').closest('article')?.parentElement?.parentElement).toBe(notices)
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

    expect(screen.getByText('DSH update available').closest('.dsh-app__notice-summary')).not.toBeNull()
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

    expect(screen.getByRole('heading', { name: 'DSH was not found' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(setDrawer).toHaveBeenCalledWith('settings')
  })

  it('opens reminder management from the connected conversation header', () => {
    const setDrawer = vi.fn()
    currentStore = { ...storeFor(connectedState(true)), setDrawer }

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Schedules' }))
    expect(setDrawer).toHaveBeenCalledWith('schedules')
  })

  it.each([
    ['Sessions', 'sessions'],
    ['Schedules', 'schedules'],
    ['Settings', 'settings'],
  ] as const)('opens %s from the compact conversation menu', (label, drawer) => {
    const setDrawer = vi.fn()
    currentStore = { ...storeFor(connectedState(true)), setDrawer }
    render(<App />)

    const tools = screen.getByRole('button', { name: 'Conversation tools' })
    fireEvent.click(tools)
    const menu = screen.getByRole('dialog', { name: 'Conversation tools' })
    fireEvent.click(within(menu).getByRole('button', { name: label }))

    expect(setDrawer).toHaveBeenCalledWith(drawer)
    expect(screen.queryByRole('dialog', { name: 'Conversation tools' })).toBeNull()
    expect(document.activeElement).toBe(tools)
  })

  it('starts a draft in the current workspace from the compact conversation menu', () => {
    const stageSession = vi.fn().mockResolvedValue(undefined)
    currentStore = { ...storeFor(connectedState(true)), stageSession }
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    const menu = screen.getByRole('dialog', { name: 'Conversation tools' })
    fireEvent.click(within(menu).getByRole('button', { name: 'New Session' }))

    expect(stageSession).toHaveBeenCalledWith('w1', undefined)
    expect(screen.queryByRole('dialog', { name: 'Conversation tools' })).toBeNull()
  })

  it('keeps compact navigation available before the first draft message is sent', () => {
    const state = connectedState(true)
    const setDrawer = vi.fn()
    currentStore = {
      ...storeFor({
        ...state,
        activeSessionId: undefined,
        pendingSession: { revision: 1, workspaceId: 'w1', configuration: state.configuration! },
      }),
      setDrawer,
    }
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    const menu = screen.getByRole('dialog', { name: 'Conversation tools' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Sessions' }))

    expect(setDrawer).toHaveBeenCalledWith('sessions')
    expect(screen.queryByRole('dialog', { name: 'Conversation tools' })).toBeNull()
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
    expect(screen.getByRole('button', { name: 'Editor context' }).hasAttribute('disabled')).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'continue' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(sendPrompt).toHaveBeenCalledWith('child-1', 'continue', [], 'queue', expect.any(AbortSignal))
  })

  it('opens the named subagent task even when the current catalog does not list it', async () => {
    const state = connectedState(true)
    const openSession = vi.fn().mockResolvedValue(undefined)
    const openSubagent = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor({
        ...state,
        // Workspace-scoped task list: this child belongs to another parent, so
        // the catalog of the session being viewed cannot name it.
        tasks: [
          {
            taskId: 'subagent:other:child-2',
            sourceId: 'child-2',
            sessionId: 'other',
            parentTaskId: 'session:other',
            workspaceFolderId: 'w1',
            kind: 'subagent',
            title: 'Worker',
            sessionTitle: 'Other parent',
            status: 'running',
            needsUserAction: false,
            startedAt: 0,
            updatedAt: 1,
            childCount: 0,
            canOpen: true,
            canAnswer: false,
            canSessionCancel: true,
            ownerKind: 'unknown',
            taskRevision: 1,
          },
        ],
      }),
      openSession,
      openSubagent,
    }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    fireEvent.click(await screen.findByRole('button', { name: /active tasks/u }))
    fireEvent.click(await screen.findByRole('button', { name: /Subagent/u }))

    await waitFor(() => expect(openSession).toHaveBeenCalled())
    expect(openSubagent).not.toHaveBeenCalled()
    expect(openSession).toHaveBeenCalledWith('child-2')
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

  it('derives the RC2 projected total from its complete four-bucket aggregate', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      projections: {
        s1: {
          tokenUsage: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2 },
        },
      },
    })
    render(<App />)

    expect(screen.getByText('Σ 117 tokens')).toBeDefined()
  })

  it('does not infer a projected total from incomplete legacy cache buckets', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      projections: { s1: { tokenUsage: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 5 } } },
    })
    render(<App />)

    expect(screen.queryByText(/Σ/u)).toBeNull()
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

  it('pre-checks image limits that also list a type this client cannot encode', () => {
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
              mediaTypes: ['image/png', 'image/avif'],
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

    // The unknown type only narrows what may be sent; the advertised byte
    // limit still applies to the types this Webview can produce.
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

  it('pre-checks the message image byte total before sending bytes to the Extension Host', () => {
    const state = connectedState(true)
    const ingestAttachment = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor({
        ...state,
        projections: {
          s1: {
            imageLimits: {
              maxImageBytes: 100,
              maxImagesPerMessage: 20,
              maxMessageImageBytes: 15,
              maxImagePixels: 100,
              mediaTypes: ['image/png'],
            },
          },
        },
      }),
      ingestAttachment,
    }
    render(<App />)
    fireEvent.paste(screen.getByRole('textbox', { name: 'Prompt' }), {
      clipboardData: { files: [new File(['x'.repeat(20)], 'screenshot.png', { type: 'image/png' })] },
    })

    // The single image fits the per-image limit; only the message total
    // rejects it, so the adapter must never see the bytes first.
    expect(screen.getByRole('alert').textContent).toContain(
      'The combined image size exceeds the DSH image limit of 15 B.',
    )
    expect(ingestAttachment).not.toHaveBeenCalled()
  })

  it('counts image pastes that are still being read toward the per-message image limit', async () => {
    const state = connectedState(true)
    let resolveIngest: ((value: undefined) => void) | undefined
    const ingestAttachment = vi
      .fn()
      .mockImplementation(() => new Promise<undefined>((resolve) => (resolveIngest = resolve)))
    currentStore = {
      ...storeFor({
        ...state,
        projections: {
          s1: {
            imageLimits: {
              maxImageBytes: 100,
              maxImagesPerMessage: 1,
              maxMessageImageBytes: 100_000,
              maxImagePixels: 100,
              mediaTypes: ['image/png'],
            },
          },
        },
      }),
      ingestAttachment,
    }
    render(<App />)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.paste(prompt, {
      clipboardData: { files: [new File(['first'], 'first.png', { type: 'image/png' })] },
    })
    await waitFor(() => expect(ingestAttachment).toHaveBeenCalledTimes(1))

    // The first image has not landed in the draft yet; the second paste has
    // to be measured against it instead of slipping past the limit.
    fireEvent.paste(prompt, {
      clipboardData: { files: [new File(['second'], 'second.png', { type: 'image/png' })] },
    })
    expect(screen.getByRole('alert').textContent).toContain('accepts at most 1 images')
    expect(ingestAttachment).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveIngest?.(undefined)
      await Promise.resolve()
    })
  })

  it('waits for a pasted attachment to finish ingesting before sending', async () => {
    const state = connectedState(true)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000014'
    let resolveIngest: ((value: { uri: string; name: string; mimeType: string }) => void) | undefined
    const ingestAttachment = vi.fn(
      () =>
        new Promise<{ uri: string; name: string; mimeType: string }>((resolve) => {
          resolveIngest = resolve
        }),
    )
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    currentStore = { ...storeFor(state), ingestAttachment, sendPrompt }
    render(<App />)

    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: 'send this with the file' } })
    fireEvent.paste(prompt, {
      clipboardData: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(ingestAttachment).toHaveBeenCalledTimes(1))
    fireEvent.submit(prompt.closest('form')!)
    expect(sendPrompt).not.toHaveBeenCalled()

    await act(async () => {
      resolveIngest?.({ uri, name: 'notes.txt', mimeType: 'text/plain' })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith(
        's1',
        'send this with the file',
        [expect.objectContaining({ uri })],
        'queue',
        expect.any(AbortSignal),
      ),
    )
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' }).value).toBe('')
  })

  it('keeps a pending first-message attachment handle until its send settles', async () => {
    const state = connectedState(false)
    let resolveSend: (() => void) | undefined
    const sendPendingPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        }),
    )
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000015'
    const ingestAttachment = vi.fn().mockResolvedValue({ uri, name: 'notes.txt', mimeType: 'text/plain' })
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    const { updateState } = renderWithMutableState({
      ...state,
      pendingSession: { revision: 1, workspaceId: 'w1', configuration: connectedState(true).configuration! },
    })
    Object.assign(currentStore, { sendPendingPrompt, ingestAttachment, releaseAttachments })

    const input = document.querySelector('.dsh-composer textarea')
    expect(input).toBeInstanceOf(HTMLTextAreaElement)
    fireEvent.change(input!, { target: { value: 'first message' } })
    fireEvent.paste(input!, {
      clipboardData: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    })
    await screen.findByRole('button', { name: 'Remove notes.txt' })
    fireEvent.submit(input!.closest('form')!)
    await waitFor(() => expect(sendPendingPrompt).toHaveBeenCalled())

    // Opening the created session changes the composer owner while the Host is
    // still resolving the attachment. Releasing here would make it reject.
    updateState(connectedState(true))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull())
    expect(releaseAttachments).not.toHaveBeenCalledWith([uri])

    await act(async () => {
      resolveSend?.()
      await Promise.resolve()
    })
    expect(releaseAttachments).not.toHaveBeenCalledWith([uri])
  })

  it('releases a detached first-message attachment after a definite send failure', async () => {
    const state = connectedState(false)
    let rejectSend: ((reason: unknown) => void) | undefined
    const sendPendingPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject
        }),
    )
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000016'
    const ingestAttachment = vi.fn().mockResolvedValue({ uri, name: 'notes.txt', mimeType: 'text/plain' })
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    const { updateState } = renderWithMutableState({
      ...state,
      pendingSession: { revision: 1, workspaceId: 'w1', configuration: connectedState(true).configuration! },
    })
    Object.assign(currentStore, { sendPendingPrompt, ingestAttachment, releaseAttachments })

    const input = document.querySelector('.dsh-composer textarea')
    fireEvent.change(input!, { target: { value: 'first message' } })
    fireEvent.paste(input!, {
      clipboardData: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    })
    await screen.findByRole('button', { name: 'Remove notes.txt' })
    fireEvent.submit(input!.closest('form')!)
    await waitFor(() => expect(sendPendingPrompt).toHaveBeenCalled())
    updateState(connectedState(true))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull())

    await act(async () => {
      rejectSend?.(new Error('Host rejected the prompt'))
      await Promise.resolve()
    })
    await waitFor(() => expect(releaseAttachments).toHaveBeenCalledWith([uri]))
    expect(await screen.findByText('Prompt failed.')).toBeDefined()
  })

  it('abandons a waiting attachment send after navigating away and back', async () => {
    const initial = connectedState(true)
    let resolveIngest: ((value: { uri: string; name: string; mimeType: string }) => void) | undefined
    const ingestAttachment = vi.fn(
      () =>
        new Promise<{ uri: string; name: string; mimeType: string }>((resolve) => {
          resolveIngest = resolve
        }),
    )
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    const { updateState } = renderWithMutableState(initial)
    Object.assign(currentStore, { ingestAttachment, sendPrompt, releaseAttachments })
    const input = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(input, { target: { value: 'needs the file' } })
    fireEvent.paste(input, {
      clipboardData: { files: [new File(['data'], 'slow.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(ingestAttachment).toHaveBeenCalledTimes(1))
    fireEvent.submit(input.closest('form')!)
    updateState({
      ...initial,
      pendingSession: { revision: 99, workspaceId: 'w1', configuration: initial.configuration! },
    })
    updateState(initial)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000018'
    await act(async () => {
      resolveIngest?.({ uri, name: 'slow.txt', mimeType: 'text/plain' })
      await Promise.resolve()
    })
    await waitFor(() => expect(releaseAttachments).toHaveBeenCalledWith([uri]))
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' }).value).toBe('needs the file')
  })

  it('does not release a detached handle after an unconfirmed send timeout', async () => {
    const initial = connectedState(true)
    let rejectSend: ((reason: unknown) => void) | undefined
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject
        }),
    )
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000019'
    const { updateState } = renderWithMutableState(initial)
    Object.assign(currentStore, {
      sendPrompt,
      releaseAttachments,
      ingestAttachment: vi.fn().mockResolvedValue({ uri, name: 'slow.txt', mimeType: 'text/plain' }),
    })
    const input = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(input, { target: { value: 'slow send' } })
    fireEvent.paste(input, {
      clipboardData: { files: [new File(['data'], 'slow.txt', { type: 'text/plain' })] },
    })
    await screen.findByRole('button', { name: 'Remove slow.txt' })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1))
    updateState({
      ...initial,
      pendingSession: { revision: 99, workspaceId: 'w1', configuration: initial.configuration! },
    })
    await act(async () => {
      rejectSend?.(Object.assign(new Error('Delivery unconfirmed'), { retryable: true }))
      await Promise.resolve()
    })
    await screen.findByRole('alert')
    expect(releaseAttachments).not.toHaveBeenCalled()
  })

  it('keeps the draft when an attachment read fails before sending', async () => {
    const state = connectedState(true)
    let rejectIngest: ((reason: unknown) => void) | undefined
    const ingestAttachment = vi.fn(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectIngest = reject
        }),
    )
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    currentStore = { ...storeFor(state), ingestAttachment, sendPrompt }
    render(<App />)

    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(prompt, { target: { value: 'keep this draft' } })
    fireEvent.paste(prompt, {
      clipboardData: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    })
    await waitFor(() => expect(ingestAttachment).toHaveBeenCalledTimes(1))
    fireEvent.submit(prompt.closest('form')!)
    await act(async () => {
      rejectIngest?.(new Error('Unable to attach pasted file.'))
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Unable to attach pasted file.'),
    )
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' }).value).toBe('keep this draft')
  })

  it('keeps a removed chip handle alive while the Host still resolves its submission', async () => {
    const state = connectedState(true)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000017'
    let rejectSend: ((reason: unknown) => void) | undefined
    const sendPrompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject
        }),
    )
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor(state),
      sendPrompt,
      releaseAttachments,
      ingestAttachment: vi.fn().mockResolvedValue({ uri, name: 'retained.txt', mimeType: 'text/plain' }),
    }
    render(<App />)
    const input = screen.getByRole('textbox', { name: 'Prompt' })
    fireEvent.change(input, { target: { value: 'with attachment' } })
    fireEvent.paste(input, {
      clipboardData: { files: [new File(['data'], 'retained.txt', { type: 'text/plain' })] },
    })
    const remove = await screen.findByRole('button', { name: 'Remove retained.txt' })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1))
    fireEvent.click(remove)
    expect(releaseAttachments).not.toHaveBeenCalled()
    await act(async () => {
      rejectSend?.(new Error('Host rejected the prompt'))
      await Promise.resolve()
    })
    await waitFor(() => expect(releaseAttachments).toHaveBeenCalledWith([uri]))
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
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    const remove = await screen.findByRole('button', { name: 'Remove notes.txt' })
    fireEvent.click(remove)

    await waitFor(() => expect(releaseAttachments).toHaveBeenCalledWith([uri]))
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull()
  })

  it('reports an unavailable attachment preview instead of a permanent loading state', async () => {
    const state = connectedState(true)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000002'
    const pickAttachment = vi.fn().mockResolvedValue({ uri, name: 'photo.png', mimeType: 'image/png' })
    // A dead or expired Host handle answers with `{cancelled: true}`, which the
    // store flattens to `undefined` — an outcome the lightbox must not dress up
    // as "still loading".
    const previewAttachment = vi.fn().mockResolvedValue(undefined)
    currentStore = { ...storeFor(state), pickAttachment, previewAttachment }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview photo.png' }))

    const lightbox = await screen.findByRole('dialog', { name: 'Preview photo.png' })
    await waitFor(() => expect(within(lightbox).getByText('Unable to load image')).toBeDefined())
    expect(within(lightbox).queryByText('Loading preview…')).toBeNull()
    // The failure is terminal: it must not re-request the same handle forever.
    await waitFor(() => expect(previewAttachment).toHaveBeenCalledTimes(1))
  })

  it('shows the resolved attachment preview in the lightbox', async () => {
    const state = connectedState(true)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000003'
    const pickAttachment = vi.fn().mockResolvedValue({ uri, name: 'photo.png', mimeType: 'image/png' })
    const previewAttachment = vi.fn().mockResolvedValue('data:image/png;base64,AAAA')
    currentStore = { ...storeFor(state), pickAttachment, previewAttachment }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview photo.png' }))

    const lightbox = await screen.findByRole('dialog', { name: 'Preview photo.png' })
    await waitFor(() =>
      expect(within(lightbox).getByRole('img', { name: 'photo.png' }).getAttribute('src')).toBe(
        'data:image/png;base64,AAAA',
      ),
    )
    expect(within(lightbox).queryByText('Unable to load image')).toBeNull()
  })

  it('retries the preview after a failed attachment is removed and picked again', async () => {
    const state = connectedState(true)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000004'
    const pickAttachment = vi.fn().mockResolvedValue({ uri, name: 'photo.png', mimeType: 'image/png' })
    const previewAttachment = vi.fn().mockResolvedValue(undefined)
    currentStore = { ...storeFor(state), pickAttachment, previewAttachment }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview photo.png' }))
    const lightbox = await screen.findByRole('dialog', { name: 'Preview photo.png' })
    await waitFor(() => expect(within(lightbox).getByText('Unable to load image')).toBeDefined())
    fireEvent.click(within(lightbox).getByRole('button', { name: 'Close preview' }))

    fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    await screen.findByRole('button', { name: 'Preview photo.png' })

    await waitFor(() => expect(previewAttachment).toHaveBeenCalledTimes(2))
  })

  it('offers the open-file picker on a session whose candidate list was never listed', async () => {
    const state = connectedState(true)
    const listOpenFiles = vi
      .fn()
      .mockResolvedValue([{ id: 'dsh-open-file-1', name: 'LICENSE', active: true, supported: true }])
    const attachOpenFile = vi.fn().mockResolvedValue({
      uri: 'dsh-attachment:00000000-0000-4000-8000-000000000001',
      name: 'LICENSE',
      mimeType: 'text/plain',
    })
    currentStore = { ...storeFor(state), listOpenFiles, attachOpenFile }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Choose an open file' }))
    fireEvent.click(await screen.findByRole('option', { name: /LICENSE/u }))

    await waitFor(() => expect(attachOpenFile).toHaveBeenCalledWith('dsh-open-file-1', expect.any(Function)))
    expect(await screen.findByRole('button', { name: 'Remove LICENSE' })).toBeDefined()
  })

  it('restarts the error dismissal window when the same failure repeats', async () => {
    vi.useFakeTimers()
    try {
      const state = connectedState(true)
      const pickAttachment = vi.fn().mockRejectedValue(new Error('Host refused the attachment'))
      currentStore = { ...storeFor(state), pickAttachment }

      render(<App />)
      const failAttachment = async (): Promise<void> => {
        fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
        fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
        await act(async () => {
          await Promise.resolve()
        })
      }

      await failAttachment()
      expect(screen.queryByText('Host refused the attachment')).not.toBeNull()

      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      await failAttachment()

      // 3s after the repeat the toast must still be up: the second failure owns
      // a fresh window, it does not inherit the first one's deadline.
      act(() => {
        vi.advanceTimersByTime(3_000)
      })
      expect(screen.queryByText('Host refused the attachment')).not.toBeNull()

      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      expect(screen.queryByText('Host refused the attachment')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses the error toast on demand', async () => {
    const state = connectedState(true)
    const pickAttachment = vi.fn().mockRejectedValue(new Error('Host refused the attachment'))
    currentStore = { ...storeFor(state), pickAttachment }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    await screen.findByText('Host refused the attachment')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))

    expect(screen.queryByText('Host refused the attachment')).toBeNull()
  })

  it('keeps the open-file row hidden when the listed open files cannot be attached', async () => {
    const state = connectedState(true)
    const listOpenFiles = vi
      .fn()
      .mockResolvedValue([{ id: 'dsh-open-file-1', name: 'archive.bin', active: true, supported: false }])
    currentStore = { ...storeFor(state), listOpenFiles }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(listOpenFiles).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Choose an open file' })).toBeNull()
  })

  it('does not leave the open-file picker open after its menu is dismissed', async () => {
    const state = connectedState(true)
    currentStore = {
      ...storeFor(state),
      listOpenFiles: vi
        .fn()
        .mockResolvedValue([{ id: 'dsh-open-file-1', name: 'LICENSE', active: true, supported: true }]),
    }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Choose an open file' }))
    await screen.findByRole('option', { name: /LICENSE/u })

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))

    expect(screen.queryByRole('dialog', { name: 'Open files' })).toBeNull()
  })

  it('keeps the picker loading while a superseded open-file request is still settling', async () => {
    const state = connectedState(true)
    const deferred: Array<(value: OpenFileCandidate[]) => void> = []
    const candidates: OpenFileCandidate[] = [
      { id: 'dsh-open-file-1', name: 'LICENSE', active: true, supported: true },
    ]
    // The menu-open refresh answers; both picker requests hang until the test
    // settles them out of order.
    const listOpenFiles = vi
      .fn<() => Promise<OpenFileCandidate[]>>()
      .mockImplementationOnce(() => Promise.resolve(candidates))
      .mockImplementation(() => new Promise((resolve) => deferred.push(resolve)))
    currentStore = { ...storeFor(state), listOpenFiles }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Choose an open file' }))
    await screen.findByRole('dialog', { name: 'Open files' })
    expect(screen.getByText('Loading…')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Close open files' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Choose an open file' }))
    expect(await screen.findByRole('dialog', { name: 'Open files' })).toBeDefined()
    expect(screen.getByText('Loading…')).toBeDefined()

    // The first picker request settles after being superseded; ending the
    // loading here would strand the user on a stale or empty candidate list.
    await act(async () => {
      deferred[0]?.([])
      await Promise.resolve()
    })
    expect(screen.getByText('Loading…')).toBeDefined()

    await act(async () => {
      deferred[1]?.(candidates)
      await Promise.resolve()
    })
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByRole('option', { name: /LICENSE/u })).toBeDefined()
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
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove notes.txt' })).toHaveLength(1))
    expect(releaseAttachments).toHaveBeenCalledWith([secondUri])
  })

  it.each(['rejected', 'superseded'])('keeps the draft when another-session open is %s', async (outcome) => {
    const state = connectedState(true)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000009'
    const pickAttachment = vi.fn().mockResolvedValue({ uri, name: 'notes.txt', mimeType: 'text/plain' })
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    // A disconnected or restarted DSH rejects the open after the store's own
    // bounded retries, so a rejected `session.open` is a normal outcome.
    // Superseded opens resolve without changing the active session.
    const openSession =
      outcome === 'rejected'
        ? vi.fn().mockRejectedValue(new Error('Unable to open session.'))
        : vi.fn().mockResolvedValue(undefined)
    const withSecond: AppState = {
      ...state,
      sessions: [
        ...state.sessions,
        {
          id: 's2',
          title: 'Another',
          workspaceId: 'w1',
          blank: false,
          status: 'idle' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      workspaces: [{ ...state.workspaces[0]!, sessionIds: ['s1', 's2'], sessionCount: 2 }],
      drawer: 'sessions',
    }
    currentStore = { ...storeFor(withSecond), pickAttachment, releaseAttachments, openSession }

    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'a prompt I do not want to retype' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    await screen.findByRole('button', { name: 'Remove notes.txt' })

    fireEvent.click(await screen.findByText('Another'))
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('s2'))

    // The open failed, so the user is still in the session that owns the draft.
    // Losing it here would cost them both the text and the host-file handle.
    expect(screen.getByRole('textbox', { name: 'Prompt' }).textContent).toBe(
      'a prompt I do not want to retype',
    )
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeDefined()
    expect(releaseAttachments).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'superseded'])('keeps the draft when new-session staging is %s', async (outcome) => {
    const state = connectedState(true)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000010'
    const pickAttachment = vi.fn().mockResolvedValue({ uri, name: 'notes.txt', mimeType: 'text/plain' })
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    // `stageSession` throws while no workspace is resolvable yet, which is a
    // normal transient state on first load.
    const stageSession =
      outcome === 'rejected'
        ? vi.fn().mockRejectedValue(new Error('Loading workspaces…'))
        : vi.fn().mockResolvedValue(undefined)
    currentStore = { ...storeFor(state), pickAttachment, releaseAttachments, stageSession }

    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'a prompt I do not want to retype' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    await screen.findByRole('button', { name: 'Remove notes.txt' })

    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    await waitFor(() => expect(stageSession).toHaveBeenCalled())

    // No session was staged, so the draft still belongs to the composer.
    expect(screen.getByRole('textbox', { name: 'Prompt' }).textContent).toBe(
      'a prompt I do not want to retype',
    )
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeDefined()
    expect(releaseAttachments).not.toHaveBeenCalled()
  })

  it('keeps the draft and a still-valid attachment when a superseded pending send reports cancelled', async () => {
    const state = connectedState(false)
    let rejectSend: (reason: unknown) => void = () => undefined
    const send = new Promise<void>((_resolve, reject) => {
      rejectSend = reject
    })
    const sendPendingPrompt = vi.fn().mockReturnValueOnce(send)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000012'
    const laterUri = 'dsh-attachment:00000000-0000-4000-8000-000000000013'
    const ingestAttachment = vi
      .fn()
      .mockResolvedValueOnce({ uri, name: 'notes.txt', mimeType: 'text/plain' })
      .mockResolvedValue({ uri: laterUri, name: 'later.txt', mimeType: 'text/plain' })
    const releaseAttachments = vi.fn().mockResolvedValue(undefined)
    const { updateState } = renderWithMutableState({
      ...state,
      pendingSession: { revision: 1, workspaceId: 'w1', configuration: state.configuration! },
    })
    Object.assign(currentStore, { sendPendingPrompt, ingestAttachment, releaseAttachments })

    const input = document.querySelector('.dsh-composer textarea')
    expect(input).toBeInstanceOf(HTMLTextAreaElement)
    fireEvent.change(input!, { target: { value: 'a prompt I do not want to retype' } })
    fireEvent.paste(input!, {
      clipboardData: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    })
    await screen.findByRole('button', { name: 'Remove notes.txt' })
    fireEvent.submit(input!.closest('form')!)
    await waitFor(() =>
      expect(sendPendingPrompt).toHaveBeenCalledWith(
        'a prompt I do not want to retype',
        [expect.anything()],
        'queue',
        expect.any(AbortSignal),
      ),
    )

    // The user navigates to an existing session while the send is still
    // working: the switch hides the pending composition's own attachment, but
    // its handle must stay resolvable until the Host answers, and the draft
    // text stays with its pending owner rather than entering the existing chat.
    updateState({
      ...state,
      activeSessionId: 's2',
      sessions: [
        ...state.sessions,
        {
          id: 's2',
          title: 'Another',
          workspaceId: 'w1',
          blank: false,
          status: 'idle' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      workspaces: [{ ...state.workspaces[0]!, sessionIds: ['s1', 's2'], sessionCount: 2 }],
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull())
    expect(releaseAttachments).not.toHaveBeenCalled()
    const sessionPrompt = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    expect(sessionPrompt.value).toBe('')
    fireEvent.change(sessionPrompt, { target: { value: 'draft for the existing chat' } })
    fireEvent.paste(sessionPrompt, {
      clipboardData: { files: [new File(['later'], 'later.txt', { type: 'text/plain' })] },
    })
    await screen.findByRole('button', { name: 'Remove later.txt' })

    // The send reports cancelled — nothing was delivered — so the composer
    // must keep both the visible draft and the attachment added afterwards.
    await act(async () => {
      rejectSend(Object.assign(new Error('cancelled'), { code: 'REQUEST_CANCELLED' }))
      await send.catch(() => undefined)
    })
    expect(await screen.findByText('Prompt failed.')).toBeDefined()
    // Nothing was delivered, so the hidden pending handle is now released.
    await waitFor(() => expect(releaseAttachments).toHaveBeenCalledWith([uri]))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' }).value).toBe(
      'draft for the existing chat',
    )
    expect(screen.getByRole('button', { name: 'Remove later.txt' })).toBeDefined()
  })

  it('keeps each conversation draft with its own conversation', async () => {
    const state = connectedState(true)
    const withSecond: AppState = {
      ...state,
      sessions: [
        ...state.sessions,
        {
          id: 's2',
          title: 'Another',
          workspaceId: 'w1',
          blank: false,
          status: 'idle' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      workspaces: [{ ...state.workspaces[0]!, sessionIds: ['s1', 's2'], sessionCount: 2 }],
    }
    const { updateState } = renderWithMutableState(withSecond)
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.change(input, { target: { value: 'draft for one' } })

    updateState({ ...withSecond, activeSessionId: 's2' })
    const second = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    expect(second).not.toBe(input)
    expect(second).toHaveProperty('value', '')
    // Undo history belongs to the composer instance, not to the Webview: a
    // switch must not let Ctrl+Z restore the previous conversation's draft.
    fireEvent.keyDown(second, { key: 'z', ctrlKey: true })
    expect(second.value).toBe('')
    fireEvent.change(second, { target: { value: 'draft for two' } })

    updateState(withSecond)
    expect(await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })).toHaveProperty(
      'value',
      'draft for one',
    )
    updateState({ ...withSecond, activeSessionId: 's2' })
    expect(await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })).toHaveProperty(
      'value',
      'draft for two',
    )
  })

  it('clears a submitted draft from the conversation that sent it after a switch', async () => {
    const state = connectedState(true)
    const withSecond: AppState = {
      ...state,
      sessions: [
        ...state.sessions,
        {
          id: 's2',
          title: 'Another',
          workspaceId: 'w1',
          blank: false,
          status: 'idle' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      workspaces: [{ ...state.workspaces[0]!, sessionIds: ['s1', 's2'], sessionCount: 2 }],
    }
    const { updateState } = renderWithMutableState(withSecond)
    let resolveSend: () => void = () => undefined
    Object.assign(currentStore, {
      sendPrompt: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSend = resolve
          }),
      ),
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
      target: { value: 'sent from one' },
    })
    fireEvent.submit(screen.getByRole('textbox', { name: 'Prompt' }).closest('form')!)

    // The conversation changes while the RPC settles; the submitted text must
    // not reappear in the new conversation or linger in the old one.
    updateState({ ...withSecond, activeSessionId: 's2' })
    expect(await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })).toHaveProperty(
      'value',
      '',
    )
    await act(async () => {
      resolveSend()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel sending' })).toBeNull())
    updateState(withSecond)
    expect(await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })).toHaveProperty(
      'value',
      '',
    )
  })

  it('releases the previous attachment handles only when the displayed draft changes', async () => {
    const state = connectedState(true)
    const { updateState } = renderWithMutableState(state)
    const uri = 'dsh-attachment:00000000-0000-4000-8000-000000000011'
    vi.spyOn(currentStore, 'pickAttachment').mockResolvedValue({
      uri,
      name: 'notes.txt',
      mimeType: 'text/plain',
    })
    const releaseAttachments = vi.spyOn(currentStore, 'releaseAttachments')
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Old draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Editor context' }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))
    await screen.findByRole('button', { name: 'Remove notes.txt' })

    updateState({
      ...state,
      activeSessionId: undefined,
      pendingSession: { revision: 1, workspaceId: 'w1', configuration: state.configuration! },
    })
    await waitFor(() => expect(releaseAttachments).toHaveBeenCalledWith([uri]))
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' }).value).toBe('')
    updateState({
      ...state,
      activeSessionId: undefined,
      pendingSession: { revision: 1, workspaceId: 'w1', configuration: state.configuration! },
    })
    expect(releaseAttachments).toHaveBeenCalledOnce()
  })

  it('applies the selected interface language across the conversation and export surfaces', async () => {
    let dshLocale = 'en'
    const readDshSettings = vi.fn(() => Promise.resolve(dshLocaleSettingsSnapshot(dshLocale)))
    const updateDshSetting = vi.fn((path: string, value: unknown) => {
      if (path === 'locale.preference' && typeof value === 'string') dshLocale = value
      return Promise.resolve()
    })
    currentStore = {
      ...storeFor(connectedState(true)),
      readDshSettings,
      updateDshSetting,
    }
    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    fireEvent.click(screen.getByRole('button', { name: /^Interface language:/ }))
    fireEvent.click(screen.getByRole('option', { name: '中文' }))

    expect(screen.getByRole('banner', { name: '对话' })).toBeDefined()
    expect(screen.getByPlaceholderText('输入消息…')).toBeDefined()
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDefined()
    expect(document.documentElement.lang).toBe('zh-CN')

    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '导出会话' })).toBeDefined())
    expect(screen.getByText('包含附件')).toBeDefined()
    expect(screen.getByRole('button', { name: '选择保存位置并导出' })).toBeDefined()
    await waitFor(() => expect(updateDshSetting).toHaveBeenCalledWith('locale.preference', 'zh', 1))
  })

  it('switches and restores layout from Settings without changing DSH or offering it in the conversation menu', async () => {
    const updateDshSetting = vi.fn()
    currentStore = { ...storeFor({ ...connectedState(true), drawer: 'settings' }), updateDshSetting }
    const view = render(
      <ConversationLayoutProvider>
        <App />
      </ConversationLayoutProvider>,
    )
    expect(document.querySelector('.dsh-app')?.getAttribute('data-conversation-layout')).toBe('focused')
    fireEvent.click(await screen.findByRole('button', { name: /^Conversation layout:/ }))
    fireEvent.click(screen.getByRole('option', { name: 'Classic' }))
    expect(document.querySelector('.dsh-app')?.getAttribute('data-conversation-layout')).toBe('classic')
    view.unmount()
    expect(updateDshSetting).not.toHaveBeenCalled()
    currentStore = storeFor(connectedState(true))
    render(
      <ConversationLayoutProvider>
        <App />
      </ConversationLayoutProvider>,
    )
    expect(document.querySelector('.dsh-app')?.getAttribute('data-conversation-layout')).toBe('classic')
    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    expect(screen.queryByRole('combobox', { name: 'Conversation layout' })).toBeNull()
  })

  it('opens the Inspector from conversation tools and restores focus after menu dismissal', () => {
    currentStore = storeFor(connectedState(true))
    render(<App />)

    const tools = screen.getByRole('button', { name: 'Conversation tools' })
    expect(screen.queryByRole('button', { name: 'Session Inspector' })).toBeNull()
    fireEvent.click(tools)
    fireEvent.click(screen.getByRole('button', { name: 'Session Inspector' }))
    const inspector = screen.getByRole('dialog', { name: 'Session Inspector' })
    expect(screen.queryByRole('dialog', { name: 'Conversation tools' })).toBeNull()
    expect(document.activeElement).toBe(inspector)

    fireEvent.keyDown(inspector, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Session Inspector' })).toBeNull()
    expect(document.activeElement).toBe(tools)

    fireEvent.click(tools)
    fireEvent.click(screen.getByRole('button', { name: 'Session Inspector' }))
    expect(screen.getByRole('dialog', { name: 'Session Inspector' })).toBeDefined()
  })

  it('keeps the conversation tools panel open when Escape closes the interface-language menu', () => {
    currentStore = storeFor(connectedState(true))
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    fireEvent.click(screen.getByRole('button', { name: /^Interface language:/ }))
    expect(screen.getByRole('listbox', { name: 'Interface language' })).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox', { name: 'Interface language' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Conversation tools' })).toBeDefined()

    // The listbox still dismisses on an outside press, and the panel stays
    // reachable for the Escape that no nested surface consumes any more.
    fireEvent.click(screen.getByRole('button', { name: /^Interface language:/ }))
    expect(screen.getByRole('listbox', { name: 'Interface language' })).toBeDefined()
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Conversation tools' }))
    expect(screen.queryByRole('listbox', { name: 'Interface language' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Conversation tools' })).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Conversation tools' })).toBeNull()
  })

  it('opens export above the conversation, dismisses its parent and restores focus after nested Escape', async () => {
    currentStore = storeFor(connectedState(true))
    render(<App />)
    const tools = screen.getByRole('button', { name: 'Conversation tools' })
    fireEvent.click(tools)
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    const dialog = await screen.findByRole('dialog', { name: 'Export session' })
    expect(screen.queryByRole('dialog', { name: 'Conversation tools' })).toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.pointerDown(screen.getByRole('checkbox', { name: 'Include attachments' }))
    expect(screen.getByRole('dialog', { name: 'Export session' })).toBe(dialog)
    fireEvent.click(screen.getByRole('button', { name: 'Format: Markdown' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Format' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Export session' })).toBe(dialog)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Export session' })).toBeNull()
    expect(document.activeElement).toBe(tools)
  })

  it('drops the export form when the conversation it was opened for is left', async () => {
    const state = connectedState(true)
    let live: AppState = {
      ...state,
      sessions: [
        ...state.sessions,
        {
          id: 's2',
          title: 'Other session',
          workspaceId: 'w1',
          blank: false,
          status: 'idle',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    }
    const listeners = new Set<() => void>()
    const exportSession = vi.fn().mockResolvedValue(undefined)
    currentStore = {
      ...storeFor(state),
      exportSession,
      getState: () => live,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await screen.findByRole('heading', { name: 'Export session' })

    // The form names no session of its own, so carrying it into another
    // conversation would export whichever one happens to be active.
    await act(async () => {
      live = { ...live, activeSessionId: 's2', timeline: { ...live.timeline, sessionId: 's2' } }
      for (const listener of listeners) listener()
      await Promise.resolve()
    })

    expect(screen.queryByRole('heading', { name: 'Export session' })).toBeNull()

    // Reopening it targets the conversation the user is looking at now.
    fireEvent.click(screen.getByRole('button', { name: 'Conversation tools' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose destination and export' }))
    expect(exportSession).toHaveBeenCalledWith({
      sessionId: 's2',
      format: 'markdown',
      includeAttachments: true,
      includeReasoning: true,
    })
  })

  it('uses the Settings language control for the shared extension and DSH preference', async () => {
    let dshLocale = 'en'
    const readDshSettings = vi.fn(() => Promise.resolve(dshLocaleSettingsSnapshot(dshLocale)))
    const updateDshSetting = vi.fn((path: string, value: unknown) => {
      if (path === 'locale.preference' && typeof value === 'string') dshLocale = value
      return Promise.resolve()
    })
    currentStore = {
      ...storeFor({ ...connectedState(true), drawer: 'settings' }),
      readDshSettings,
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
    await waitFor(() => expect(updateDshSetting).toHaveBeenCalledWith('locale.preference', 'zh', 1))
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')
  })

  it.each([
    { preference: 'en', local: 'zh', advertised: true, expected: 'Message…', lang: 'en' },
    { preference: 'zh-Hans', local: 'en', advertised: true, expected: '输入消息…', lang: 'zh-CN' },
    { preference: 'fr-FR', local: 'zh', advertised: true, expected: 'Message…', lang: 'en' },
    { preference: 'en', local: 'zh', advertised: false, expected: '输入消息…', lang: 'zh-CN' },
  ])(
    'adopts only an advertised DSH locale preference ($preference, advertised=$advertised)',
    async ({ preference, local, advertised, expected, lang }) => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, local)
      window.localStorage.setItem(LOCALE_EXPLICIT_STORAGE_KEY, 'true')
      document.documentElement.lang = local === 'zh' ? 'en' : 'zh-CN'
      const updateDshSetting = vi.fn().mockResolvedValue(undefined)
      const readDshSettings = vi.fn().mockResolvedValue(dshLocaleSettingsSnapshot(preference, advertised))
      currentStore = {
        ...storeFor(connectedState(true)),
        readDshSettings,
        updateDshSetting,
      }

      render(
        <I18nProvider>
          <App />
        </I18nProvider>,
      )

      await screen.findByPlaceholderText(expected)
      await waitFor(() => expect(document.documentElement.lang).toBe(lang))
      expect(readDshSettings).toHaveBeenCalled()
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe(local)
      expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')
      expect(updateDshSetting).not.toHaveBeenCalled()
    },
  )

  it('keeps the editor language fallback when DSH settings cannot be read', async () => {
    document.documentElement.lang = 'zh-Hant'
    const readDshSettings = vi.fn().mockRejectedValue(new Error('settings are unavailable'))
    currentStore = { ...storeFor(connectedState(true)), readDshSettings }

    render(
      <I18nProvider>
        <App />
      </I18nProvider>,
    )

    await screen.findByPlaceholderText('输入消息…')
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBeNull()
  })

  it('restores the editor locale after the connected DSH disconnects', async () => {
    document.documentElement.lang = 'zh-Hans'
    let state = connectedState(true)
    const store: AppStore = {
      ...storeFor(state),
      getState: () => state,
      readDshSettings: vi.fn().mockResolvedValue(dshLocaleSettingsSnapshot('en')),
    }
    currentStore = store
    const tree = (): ReactElement => (
      <I18nProvider>
        <>
          <ActiveLocaleOutput />
          <App />
        </>
      </I18nProvider>
    )
    const view = render(tree())

    await screen.findByPlaceholderText('Message…')
    expect(screen.getByTestId('active-locale').textContent).toBe('en')
    expect(document.documentElement.lang).toBe('en')

    state = { ...state, backend: { kind: 'idle' } }
    view.rerender(tree())

    await waitFor(() => expect(screen.getByTestId('active-locale').textContent).toBe('zh'))
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBeNull()
  })

  it('keeps an explicit local locale through disconnect and DSH version replacement', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh')
    window.localStorage.setItem(LOCALE_EXPLICIT_STORAGE_KEY, 'true')
    document.documentElement.lang = 'en'
    let state = connectedState(true)
    const readDshSettings = vi
      .fn()
      .mockResolvedValueOnce(dshLocaleSettingsSnapshot('en'))
      .mockResolvedValue(dshUiSettingsSnapshot())
    const store: AppStore = {
      ...storeFor(state),
      getState: () => state,
      readDshSettings,
    }
    currentStore = store
    const tree = (): ReactElement => (
      <I18nProvider>
        <>
          <ActiveLocaleOutput />
          <App />
        </>
      </I18nProvider>
    )
    const view = render(tree())

    await waitFor(() => expect(screen.getByTestId('active-locale').textContent).toBe('en'))
    expect(document.documentElement.lang).toBe('en')

    state = { ...state, backend: { kind: 'idle' } }
    view.rerender(tree())
    await waitFor(() => expect(screen.getByTestId('active-locale').textContent).toBe('zh'))
    expect(document.documentElement.lang).toBe('zh-CN')

    state = {
      ...state,
      backend: { kind: 'connected' },
      connectedDshVersion: '0.1.0-rc.7',
    }
    view.rerender(tree())
    await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('active-locale').textContent).toBe('zh'))
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh')
    expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')
  })

  it.each(['disconnect', 'version replacement'] as const)(
    'ignores a successful settings read that arrives after %s',
    async (transition) => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh')
      window.localStorage.setItem(LOCALE_EXPLICIT_STORAGE_KEY, 'true')
      document.documentElement.lang = 'en'
      let resolveOldRead: (snapshot: DshSettingsSnapshot) => void = () => undefined
      let resolveNewRead: (snapshot: DshSettingsSnapshot) => void = () => undefined
      const oldRead = new Promise<DshSettingsSnapshot>((resolve) => {
        resolveOldRead = resolve
      })
      const newRead = new Promise<DshSettingsSnapshot>((resolve) => {
        resolveNewRead = resolve
      })
      let state = connectedState(true)
      const readDshSettings = vi
        .fn()
        .mockImplementationOnce(() => oldRead)
        .mockImplementation(() => newRead)
      const store: AppStore = {
        ...storeFor(state),
        getState: () => state,
        readDshSettings,
      }
      currentStore = store
      const tree = (): ReactElement => (
        <I18nProvider>
          <>
            <ActiveLocaleOutput />
            <App />
          </>
        </I18nProvider>
      )
      const view = render(tree())

      await screen.findByPlaceholderText('输入消息…')
      await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(1))
      if (transition === 'disconnect') {
        state = { ...state, backend: { kind: 'idle' } }
      } else {
        state = { ...state, connectedDshVersion: '0.1.0-rc.7' }
      }
      view.rerender(tree())

      if (transition === 'version replacement') {
        await waitFor(() => expect(readDshSettings).toHaveBeenCalledTimes(2))
      }
      await waitFor(() => expect(screen.getByTestId('active-locale').textContent).toBe('zh'))
      await act(async () => {
        resolveOldRead(dshLocaleSettingsSnapshot('en'))
        await oldRead
      })
      expect(screen.getByTestId('active-locale').textContent).toBe('zh')
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh')
      expect(window.localStorage.getItem(LOCALE_EXPLICIT_STORAGE_KEY)).toBe('true')

      if (transition === 'version replacement') {
        await act(async () => {
          resolveNewRead(dshUiSettingsSnapshot())
          await newRead
        })
        await waitFor(() => expect(screen.getByTestId('active-locale').textContent).toBe('zh'))
      }
      await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
    },
  )

  it('folds todo content into the goals/tasks header dock', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      todos: [
        { id: 'todo-1', content: '查询系统信息', status: 'completed' },
        { id: 'todo-2', content: '执行子代理调研', status: 'in-progress' },
      ],
    })
    const { container } = render(<App />)

    const dock = container.querySelector('.dsh-goals-tasks')
    expect(dock).not.toBeNull()
    const todoList = dock?.querySelector('.dsh-todo-list')
    expect(todoList).not.toBeNull()
    const todoToggle = todoList?.querySelector<HTMLButtonElement>('.dsh-todo-list__toggle')
    expect(todoToggle?.textContent).toContain('执行子代理调研')
    expect(todoToggle?.textContent).not.toContain('查询系统信息')
    expect(container.querySelector('.dsh-compose-area .dsh-todo-list')).toBeNull()
    expect(container.querySelector('.dsh-conversation > .dsh-goal-strip')).toBeNull()
  })

  it('keeps the goals/tasks dock in flow above the transcript', () => {
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      goals: [{ id: 'goal-1', title: 'Ship the dock placement', status: 'in-progress' }],
    })
    const { container } = render(<App />)

    const dock = container.querySelector<HTMLElement>('.dsh-goals-tasks')
    const timeline = screen.getByTestId('timeline')
    expect(dock).not.toBeNull()
    // jsdom has no layout engine, so containment and document order stand in
    // for geometry: the dock is ordinary conversation content that sits above
    // the transcript, never a modal or a floating overlay.
    expect(dock?.closest('.dsh-conversation')).not.toBeNull()
    expect(dock?.closest('[role="dialog"]')).toBeNull()
    expect(dock?.getAttribute('role')).not.toBe('dialog')
    expect(dock!.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('hides the performance line when performance usage is compact', async () => {
    const readDshSettings = vi.fn().mockResolvedValue(dshUiSettingsSnapshot(undefined, undefined, 'compact'))
    currentStore = { ...storeFor(connectedState(true)), readDshSettings }
    const { container } = render(<App />)

    await waitFor(() => expect(readDshSettings).toHaveBeenCalled())
    expect(container.querySelector('.dsh-composer__status')).toBeNull()
  })

  it('keeps the performance line when performance usage is detailed', async () => {
    const readDshSettings = vi.fn().mockResolvedValue(dshUiSettingsSnapshot(undefined, undefined, 'detailed'))
    currentStore = { ...storeFor(connectedState(true)), readDshSettings }
    const { container } = render(<App />)

    await waitFor(() => expect(readDshSettings).toHaveBeenCalled())
    expect(container.querySelector('.dsh-composer__status')).not.toBeNull()
  })

  it('preserves the draft when the same call transitions from foreground to continued', () => {
    const base = connectedState(true)
    const question = {
      id: 'first',
      rpcId: 'rpc-first',
      callId: 'call-first',
      sessionId: 's1',
      prompt: 'Choose scope',
      allowFreeText: true,
      state: 'open' as const,
    }
    const view = renderWithMutableState({ ...base, questions: [question] })
    const input = screen.getByLabelText<HTMLTextAreaElement>('Answer for Choose scope')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'keep this draft' } })
    view.updateState({
      ...base,
      questions: [],
      projections: {
        s1: {
          userQuestions: {
            active: [
              {
                callId: question.callId,
                state: 'continued',
                questions: [{ id: 'first', prompt: question.prompt, allowFreeText: true }],
              },
            ],
            settled: [],
          },
        },
      },
    })
    expect(screen.getByLabelText('Answer for Choose scope')).toBe(input)
    expect(input.value).toBe('keep this draft')
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
    // The slot itself must not be a live region. A timed question rewrites its
    // countdown every 250ms, and a `polite` container turns that into a stream
    // of interruptions for as long as the card is visible.
    expect(interactions?.getAttribute('aria-live')).toBeNull()
    expect(interactions?.getAttribute('role')).toBeNull()
    expect(container.querySelector('.dsh-compose-area .dsh-interaction')).toBeNull()
  })

  it('shows the command of the paired tool call on a pending approval', () => {
    const command = 'rm -rf build && pnpm install --frozen-lockfile && pnpm build'
    const state = connectedState(true)
    currentStore = storeFor({
      ...state,
      permissions: [
        {
          id: 'approval-1',
          sessionId: 's1',
          title: 'bash',
          description: 'The command needs approval.',
          callId: 'call-bash-1',
          risk: 'medium',
          options: [
            { id: 'allowed-once', label: 'Allow once', kind: 'allow-once' },
            { id: 'rejected', label: 'Reject', kind: 'deny' },
          ],
        },
      ],
      timeline: {
        ...state.timeline,
        nodes: [
          {
            kind: 'tool',
            id: 'call-bash-1',
            tool: {
              id: 'call-bash-1',
              name: 'bash',
              category: 'terminal',
              title: command,
              status: 'running',
              presentation: { phase: 'call', card: 'terminal', title: command },
              metadata: {},
            },
          },
        ],
      },
    })
    render(<App />)

    // The request itself names the tool, not the command: what the user is
    // authorizing only exists on the paired call.
    expect(screen.getByText(command)).toBeDefined()
  })
})
