// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { HostMessage, FeatureHostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState, AppStore, DshSettingsSnapshot } from './app/store.js'
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

import { I18nProvider } from './i18n.js'

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
    responseRendered: vi.fn().mockResolvedValue(false),
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

    await waitFor(() => expect(readDshSettings).toHaveBeenCalled())

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
