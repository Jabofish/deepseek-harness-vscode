import { useState, type ReactElement } from 'react'
import { EmptyState } from '@dsh-vscode/ui'
import { AppErrorBoundary } from './features/errors/AppErrorBoundary.js'
import { AppSettingsDrawer } from './features/settings/AppSettingsDrawer.js'
import { ScheduleDrawer } from './features/schedules/ScheduleDrawer.js'
import { RuntimeMissingView } from './features/runtime/RuntimeMissingView.js'
import { RuntimeConnectionView } from './features/runtime/RuntimeConnectionView.js'
import { EmptySessionPosture } from './features/sessions/EmptySessionPosture.js'
import { ConnectedComposer } from './features/composer/ConnectedComposer.js'
import { ModsBand } from './features/mods/ModsBand.js'
import { SessionInspector } from './features/inspector/SessionInspector.js'
import { AppNotices, type AppNotice } from './features/shell/AppNotices.js'
import { AppHeader } from './features/shell/AppHeader.js'
import { SessionLineage } from './features/subagents/SessionLineage.js'
import { SessionTitlePicker } from './features/sessions/SessionTitlePicker.js'
import { ConversationActionsMenu } from './features/shell/ConversationActionsMenu.js'
import { ExportDialog } from './features/export/ExportDialog.js'
import { GoalsTasksStrip } from './features/goals/GoalsTasksStrip.js'
import { Timeline } from './features/chat/Timeline.js'
import { TrajectoryView } from './features/trajectory/TrajectoryView.js'
import { QueuePanel } from './features/input/QueuePanel.js'
import { ApprovalCard } from './features/interactions/ApprovalCard.js'
import { UserQuestionCard } from './features/interactions/UserQuestionCard.js'
import { Icon } from './ui/Icon.js'
import { rememberWelcomeDismissal, rememberRuntimeUpdateDismissal } from './app/dismissed-notices.js'
import type { OpenFileCandidate } from './app/store.js'
import type { useAppController } from './AppController.js'
import { CONVERSATION_VIEW_IDS } from './app/conversation-view-ids.js'
import { useConversationLayout } from './app/ConversationLayoutProvider.js'

const EMPTY_OPEN_FILE_CANDIDATES: readonly OpenFileCandidate[] = []
export function AppView(props: ReturnType<typeof useAppController>): ReactElement {
  const layoutPreference = useConversationLayout()
  const {
    acknowledgeAccountBonusFromSettings,
    active,
    activeRunning,
    activeSubagent,
    activeSubagentState,
    adoptExplicitLocaleFromDsh,
    applyLocale,
    approvalRespondFor,
    assistantLabel,
    attachedOpenFileIds,
    attachingOpenFileId,
    attachmentPreviewFailures,
    attachmentPreviews,
    attachments,
    backend,
    beginNewDraft,
    branching,
    busyAction,
    codingToolsEnabled,
    compatibilityWarning,
    composerOnCancel,
    composerOnCaptureEditorContext,
    composerOnCommand,
    composerOnCommandQueryChange,
    composerOnConfigurationChange,
    composerOnExtrasOpenChange,
    composerOnIngestFiles,
    composerOnPickAttachment,
    composerOnPopupSelect,
    composerOnPreviewEditorContext,
    composerOnPromptModeChange,
    composerOnReferenceQueryChange,
    composerOnRemoveAttachment,
    composerOnRemoveEditorContext,
    composerOnSelectOpenFile,
    composerOnSteerQueue,
    composerOnSubmit,
    composerOnToggleOpenFilePicker,
    composerStatus,
    connectionKey,
    connectionMessage,
    contextPressure,
    contextWindowTokens,
    conversationActionItems,
    conversationActionsTriggerRef,
    conversationFontSize,
    conversationFontStyle,
    conversationView,
    dismissedConnection,
    error,
    estimatedContextTokens,
    getScheduleLinkedSession,
    goalOnClear,
    goalOnUpdate,
    headerOnNewSession,
    headerOnOpenSchedules,
    headerOnOpenSettings,
    hostConversationFontSizePx,
    imageLimits,
    lineageActiveSubagent,
    lineageOnOpenSession,
    loadAccountDetailsFromSettings,
    locale,
    modelPickerOpenRequest,
    mutateDshSettingsFromDrawer,
    newSessionPresetSelectionEnabled,
    onConversationTabKeyDown,
    openAccountPageFromSettings,
    pendingPermissions,
    pendingQuestions,
    questionWaitFor,
    performanceUsage,
    popupSelects,
    questionCancelFor,
    questionRespondFor,
    queueOnEdit,
    queueOnModeChange,
    queueOnRemove,
    readDshSettingsForUi,
    readyDshUiPreferences,
    respondingInteractionId,
    retryConnection,
    runRuntimeAction,
    runtimeUpdateVersion,
    runtimeUpdateVisible,
    scheduleOnOpenLinkedSession,
    scheduleOnStartSession,
    sessionControl,
    sessionOnOpen,
    sessionOnOpenChange,
    setConversationFontSize,
    setConversationView,
    setDismissedConnection,
    setDismissedRuntimeUpdateVersion,
    setError,
    setExportOpen,
    setThemePreference,
    setWelcomeVisible,
    settingsDrawerVersionKey,
    showDshEvents,
    state,
    store,
    streaming,
    subagentReadOnlyReason,
    t,
    themePreference,
    timelineOnBranch,
    timelineOnFeedback,
    timelineOnFeedbackPrepare,
    timelineOnFeedbackSubmit,
    timelineOnLoadImage,
    timelineOnLoadOlderHistory,
    timelineOnOpenLink,
    timelineOnOpenSession,
    timelineOnShowInFolder,
    transcriptView,
    unsetDshSettingFromDrawer,
    updateDshSettingFromDrawer,
    visibleExportSessionId,
    visibleOpenFileCandidates,
    visibleOpenFilePickerLoading,
    visibleOpenFilePickerOpen,
    visibleReferenceCandidates,
    visibleReferenceLoading,
    welcomeVisible,
  } = props
  const [inspectorOpenRequestId, setInspectorOpenRequestId] = useState<string>()
  const [inspectorReveal, setInspectorReveal] = useState<{
    readonly sessionKey: string
    readonly nodeId: string
    readonly requestId: string
  }>()
  const compactActions = (closeMenu: () => void): ReactElement => (
    <div className="dsh-conversation__compact-actions">
      <button
        type="button"
        className="dsh-conversation__navigation-trigger"
        onClick={() => {
          closeMenu()
          sessionOnOpenChange(true)
        }}
      >
        <Icon name="session" />
        {t('sessions.title')}
      </button>
      <button
        type="button"
        className="dsh-conversation__navigation-trigger"
        onClick={() => {
          closeMenu()
          headerOnNewSession()
        }}
      >
        <Icon name="add" />
        {t('sessions.new')}
      </button>
      <button
        type="button"
        className="dsh-conversation__navigation-trigger"
        onClick={() => {
          closeMenu()
          headerOnOpenSchedules()
        }}
      >
        <Icon name="clock" />
        {t('schedules.title')}
      </button>
      <button
        type="button"
        className="dsh-conversation__navigation-trigger"
        onClick={() => {
          closeMenu()
          headerOnOpenSettings()
        }}
      >
        <Icon name="settings" />
        {t('settings.title')}
      </button>
    </div>
  )
  const showWelcome =
    backend.kind === 'connected' &&
    active === undefined &&
    state.pendingSession === undefined &&
    state.sessions.length === 0 &&
    state.workspaces.length > 0 &&
    welcomeVisible
  const showConnectionAlert = connectionMessage !== undefined && connectionKey !== dismissedConnection
  const notices: AppNotice[] = []
  if (error !== undefined) {
    notices.push({
      id: 'error',
      tone: 'danger',
      title: error,
      dismissLabel: t('app.dismissError'),
      onDismiss: () => setError(undefined),
    })
  }
  if (showConnectionAlert) {
    notices.push({
      id: 'connection',
      tone: compatibilityWarning === undefined ? 'danger' : 'warning',
      title:
        compatibilityWarning !== undefined
          ? t('app.compatibilityWarning')
          : backend.kind === 'port-conflict'
            ? t('app.portConflict')
            : t('app.connectionFailed'),
      message: connectionMessage,
      dismissLabel: t('app.dismissConnectionError'),
      onDismiss: () => setDismissedConnection(connectionKey),
    })
  }
  if (runtimeUpdateVisible) {
    notices.push({
      id: 'runtime-update',
      tone: 'warning',
      title: t('runtime.updateAvailable'),
      message: t('runtime.updateAvailableDetail', { version: state.dshUpdate?.latestVersion ?? '—' }),
      dismissLabel: t('runtime.dismissUpdate'),
      onDismiss: () => {
        setDismissedRuntimeUpdateVersion(runtimeUpdateVersion)
        rememberRuntimeUpdateDismissal(runtimeUpdateVersion)
      },
      action: { label: t('runtime.openSettings'), icon: 'settings', run: () => store.setDrawer('settings') },
    })
  }
  if (showWelcome) {
    notices.push({
      id: 'welcome',
      tone: 'info',
      title: t('welcome.title'),
      message: t('welcome.description'),
      dismissLabel: t('welcome.dismiss'),
      onDismiss: () => {
        setWelcomeVisible(false)
        rememberWelcomeDismissal()
      },
    })
  }
  return (
    <AppErrorBoundary>
      <main
        className="dsh-app"
        data-dsh-theme={themePreference}
        data-conversation-layout={layoutPreference?.layout ?? 'classic'}
      >
        <AppSettingsDrawer
          key={settingsDrawerVersionKey}
          state={state}
          store={store}
          themePreference={themePreference}
          setThemePreference={setThemePreference}
          locale={locale}
          applyLocale={applyLocale}
          adoptExplicitLocaleFromDsh={adoptExplicitLocaleFromDsh}
          conversationFontSize={conversationFontSize}
          setConversationFontSize={setConversationFontSize}
          readDshSettingsForUi={readDshSettingsForUi}
          updateDshSettingFromDrawer={updateDshSettingFromDrawer}
          unsetDshSettingFromDrawer={unsetDshSettingFromDrawer}
          mutateDshSettingsFromDrawer={mutateDshSettingsFromDrawer}
          setError={setError}
          t={t}
          loadAccountDetailsFromSettings={loadAccountDetailsFromSettings}
          acknowledgeAccountBonusFromSettings={acknowledgeAccountBonusFromSettings}
          openAccountPageFromSettings={openAccountPageFromSettings}
        />
        <ScheduleDrawer
          open={state.drawer === 'schedules'}
          onClose={() => store.setDrawer(undefined)}
          featureRequest={store.featureRequest}
          subscribeFeature={store.subscribeFeature}
          onStartScheduleSession={scheduleOnStartSession}
          getLinkedSession={getScheduleLinkedSession}
          onOpenLinkedSession={scheduleOnOpenLinkedSession}
          connectionEpoch={state.connectionEpoch ?? 0}
        />
        {notices.length === 0 ? null : <AppNotices notices={notices} />}
        <section className="dsh-app__body">
          {backend.kind === 'runtime-missing' ? (
            <RuntimeMissingView
              searchedLocations={backend.searchedLocations}
              busyAction={busyAction}
              onAction={runRuntimeAction}
              onRetry={retryConnection}
              onOpenSettings={() => store.setDrawer('settings')}
              onReadDiagnostics={() => store.readDiagnostics()}
              onReconnectDiagnostics={() => store.reconnect()}
              onShowDiagnosticsOutput={() => store.showDiagnostics()}
            />
          ) : (
            <>
              {active === undefined && state.pendingSession !== undefined ? (
                <section
                  className="dsh-conversation"
                  data-conversation-font-size={conversationFontSize}
                  aria-label={t('app.createSession')}
                >
                  <div className="dsh-conversation__topbar">
                    <span className="dsh-conversation__header-title">{t('sessions.new')}</span>
                    <AppHeader
                      runtime={backend}
                      connectedDshVersion={state.connectedDshVersion}
                      compatibilityWarning={compatibilityWarning}
                      sessionControl={sessionControl}
                      onNewSession={headerOnNewSession}
                      onOpenSchedules={headerOnOpenSchedules}
                      onOpenSettings={headerOnOpenSettings}
                      onRetryConnection={retryConnection}
                    />
                    <div className="dsh-conversation__compact-menu">
                      <ConversationActionsMenu triggerRef={conversationActionsTriggerRef}>
                        {compactActions}
                      </ConversationActionsMenu>
                    </div>
                  </div>
                  <div className="dsh-app__empty">
                    <EmptyState title={t('app.createSession')} description={t('app.workspacePickerHint')} />
                  </div>
                  <div className="dsh-compose-area">
                    <ConnectedComposer
                      store={store}
                      modelScope="global"
                      key={state.pendingSession.revision}
                      draftKey={`pending:${state.pendingSession.revision}`}
                      disabled={backend.kind !== 'connected'}
                      running={false}
                      attachments={attachments}
                      configuration={state.pendingSession.configuration}
                      configurationDraft
                      permissionPresets={state.newSessionPermissionPresets ?? []}
                      {...(state.newSessionPermissionDefault === undefined
                        ? {}
                        : { defaultPermissionPreset: state.newSessionPermissionDefault })}
                      presets={state.presets}
                      presetMutable
                      {...(newSessionPresetSelectionEnabled === undefined
                        ? {}
                        : { presetSelectionEnabled: newSessionPresetSelectionEnabled })}
                      onConfigurationChange={(configuration) => store.configurePendingSession(configuration)}
                      onPickAttachment={composerOnPickAttachment}
                      onIngestFiles={composerOnIngestFiles}
                      openFileCandidates={EMPTY_OPEN_FILE_CANDIDATES}
                      openFilePickerOpen={false}
                      openFilePickerLoading={false}
                      attachedOpenFileIds={[]}
                      onToggleOpenFilePicker={() => undefined}
                      onSelectOpenFile={() => undefined}
                      onRemoveAttachment={composerOnRemoveAttachment}
                      onSubmit={composerOnSubmit}
                      onCancel={() => undefined}
                      onSteerQueue={() => undefined}
                      queue={[]}
                    />
                  </div>
                </section>
              ) : active === undefined ? (
                <>
                  {sessionControl}
                  <div className="dsh-app__empty">
                    {backend.kind === 'connected' && state.workspaces.length > 0 ? (
                      <EmptySessionPosture
                        workspaces={state.workspaces}
                        presets={state.presets}
                        {...(newSessionPresetSelectionEnabled === undefined
                          ? {}
                          : { presetSelectionEnabled: newSessionPresetSelectionEnabled })}
                        empty={state.sessions.length === 0}
                        onCreate={(workspaceId, presetId) => {
                          void beginNewDraft(workspaceId, presetId).catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : t('app.error.createSession')),
                          )
                        }}
                      />
                    ) : (
                      <RuntimeConnectionView
                        {...(state.connectionOutput === undefined ? {} : { output: state.connectionOutput })}
                        state={backend}
                        loadingSessionCatalog={backend.kind === 'connected'}
                        onRetry={retryConnection}
                        onOpenSettings={() => store.setDrawer('settings')}
                        onShowDiagnosticsOutput={() => store.showDiagnostics()}
                      />
                    )}
                  </div>
                </>
              ) : (
                <section
                  className="dsh-conversation"
                  data-conversation-font-size={conversationFontSize}
                  {...(hostConversationFontSizePx === undefined
                    ? {}
                    : { 'data-conversation-font-size-px': hostConversationFontSizePx })}
                  {...(conversationFontStyle === undefined ? {} : { style: conversationFontStyle })}
                  aria-label={active.title.trim() === '' ? t('app.conversation') : active.title}
                >
                  <div className="dsh-conversation__topbar">
                    <div
                      className="dsh-conversation__views"
                      role="tablist"
                      aria-label={t('app.conversationView')}
                    >
                      <button
                        id={CONVERSATION_VIEW_IDS.chat.tab}
                        data-conversation-view="chat"
                        className={`dsh-conversation__view-tab${
                          conversationView === 'chat' ? ' dsh-conversation__view-tab--active' : ''
                        }`}
                        type="button"
                        role="tab"
                        aria-selected={conversationView === 'chat'}
                        aria-controls={CONVERSATION_VIEW_IDS.chat.panel}
                        tabIndex={conversationView === 'chat' ? 0 : -1}
                        onKeyDown={onConversationTabKeyDown}
                        onClick={() => setConversationView('chat')}
                      >
                        {t('app.chat')}
                      </button>
                      <button
                        id={CONVERSATION_VIEW_IDS.trajectory.tab}
                        data-conversation-view="trajectory"
                        className={`dsh-conversation__view-tab${
                          conversationView === 'trajectory' ? ' dsh-conversation__view-tab--active' : ''
                        }`}
                        type="button"
                        role="tab"
                        aria-selected={conversationView === 'trajectory'}
                        aria-controls={CONVERSATION_VIEW_IDS.trajectory.panel}
                        tabIndex={conversationView === 'trajectory' ? 0 : -1}
                        onKeyDown={onConversationTabKeyDown}
                        onClick={() => setConversationView('trajectory')}
                      >
                        {t('app.trajectory')}
                      </button>
                    </div>
                    <SessionTitlePicker active={active} sessions={state.sessions} onOpen={sessionOnOpen} />
                    <GoalsTasksStrip
                      key={active.id}
                      goals={state.goals}
                      todos={state.todos}
                      onUpdateGoal={goalOnUpdate}
                      onClearGoal={goalOnClear}
                    />
                    <AppHeader
                      runtime={backend}
                      connectedDshVersion={state.connectedDshVersion}
                      compatibilityWarning={compatibilityWarning}
                      sessionControl={sessionControl}
                      onNewSession={headerOnNewSession}
                      onOpenSchedules={headerOnOpenSchedules}
                      onOpenSettings={headerOnOpenSettings}
                      onRetryConnection={retryConnection}
                    />
                    {activeSubagent !== undefined || active.parentSessionId !== undefined ? (
                      <SessionLineage
                        active={active}
                        {...(lineageActiveSubagent === undefined
                          ? {}
                          : { activeSubagent: lineageActiveSubagent })}
                        sessions={state.sessions}
                        onOpenSession={lineageOnOpenSession}
                      />
                    ) : null}
                    <ConversationActionsMenu triggerRef={conversationActionsTriggerRef}>
                      {(closeMenu) => (
                        <>
                          {compactActions(closeMenu)}
                          {conversationActionItems(closeMenu)}
                          <button
                            type="button"
                            className="dsh-button dsh-button--secondary dsh-button--compact dsh-conversation__inspector-trigger"
                            aria-haspopup="dialog"
                            onClick={() => {
                              closeMenu()
                              setInspectorOpenRequestId(crypto.randomUUID())
                            }}
                          >
                            {t('inspector.title')}
                          </button>
                        </>
                      )}
                    </ConversationActionsMenu>
                  </div>
                  {state.transcript?.historical !== true ? null : (
                    <div
                      className="dsh-timeline__history-more"
                      style={{ position: 'absolute', right: '1rem', bottom: '6rem', zIndex: 2 }}
                    >
                      <button
                        type="button"
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        onClick={() => {
                          void store.navigateTranscript('newer').catch((reason) => setError(String(reason)))
                        }}
                      >
                        {t('transcript.newer')}
                      </button>
                      <button
                        type="button"
                        className="dsh-button dsh-button--secondary dsh-button--compact"
                        onClick={() => {
                          void store.navigateTranscript('latest').catch((reason) => setError(String(reason)))
                        }}
                      >
                        {t('transcript.latest')}
                      </button>
                    </div>
                  )}
                  <SessionInspector
                    key={`${state.connectionEpoch}:${active.id}`}
                    {...(state.transcript === undefined ? {} : { eventFacts: state.transcript.eventFacts })}
                    nodes={state.timeline.nodes}
                    hasMore={state.historyHasMore}
                    loading={state.historyLoading}
                    loadOlder={timelineOnLoadOlderHistory}
                    featureRequest={store.featureRequest}
                    showDshEvents={showDshEvents}
                    transcriptView={transcriptView}
                    openRequestId={inspectorOpenRequestId}
                    showTrigger={false}
                    onRevealNode={(nodeId) => {
                      setConversationView('chat')
                      setInspectorReveal({
                        sessionKey: `${state.connectionEpoch}:${active.id}`,
                        nodeId,
                        requestId: crypto.randomUUID(),
                      })
                    }}
                  />
                  {visibleExportSessionId === undefined ? null : (
                    <ExportDialog
                      sessionId={visibleExportSessionId}
                      onClose={() => setExportOpen(false)}
                      onExport={(options) => {
                        setExportOpen(false)
                        void store
                          .exportSession(options)
                          .catch((reason: unknown) =>
                            setError(reason instanceof Error ? reason.message : t('export.failed')),
                          )
                      }}
                    />
                  )}
                  {conversationView === 'chat' ? (
                    <Timeline
                      sessionId={active.id}
                      {...(inspectorReveal?.sessionKey === `${state.connectionEpoch}:${active.id}`
                        ? { revealTarget: inspectorReveal }
                        : {})}
                      panelId={CONVERSATION_VIEW_IDS.chat.panel}
                      panelLabelledBy={CONVERSATION_VIEW_IDS.chat.tab}
                      onResponseRendered={store.responseRendered}
                      nodes={state.timeline.nodes}
                      {...(state.timeline.nodeChangeStart === undefined
                        ? {}
                        : { nodeChangeStart: state.timeline.nodeChangeStart })}
                      {...(state.timeline.nodeChangeBase === undefined
                        ? {}
                        : { nodeChangeBase: state.timeline.nodeChangeBase })}
                      streaming={streaming}
                      showDshEvents={showDshEvents}
                      transcriptView={transcriptView}
                      performanceUsage={performanceUsage}
                      codingToolsEnabled={codingToolsEnabled}
                      running={activeRunning}
                      {...(state.timeline.activeTurn === undefined
                        ? {}
                        : { activeTurn: state.timeline.activeTurn })}
                      assistantLabel={assistantLabel}
                      {...(activeSubagent === undefined ? { onBranch: timelineOnBranch } : {})}
                      branching={branching}
                      onOpenLink={timelineOnOpenLink}
                      onLoadImage={timelineOnLoadImage}
                      onShowInFolder={timelineOnShowInFolder}
                      onOpenSession={timelineOnOpenSession}
                      feedback={state.feedback}
                      feedbackUnavailable={state.feedbackUnavailable}
                      hasMoreHistory={state.historyHasMore}
                      loadingOlderHistory={state.historyLoading}
                      onLoadOlderHistory={timelineOnLoadOlderHistory}
                      onFeedback={timelineOnFeedback}
                      onFeedbackPrepare={timelineOnFeedbackPrepare}
                      onFeedbackSubmit={timelineOnFeedbackSubmit}
                      {...(state.transcript === undefined
                        ? {}
                        : {
                            omittedNodeIds: state.transcript.omittedNodeIds,
                            contentVersions: state.transcript.contentVersions,
                          })}
                      loadFullNode={(nodeId, signal) => store.loadTranscriptNode(nodeId, signal)}
                      loadFullContent={(nodeId) => store.loadTranscriptContent(nodeId)}
                    />
                  ) : (
                    <TrajectoryView
                      sessionId={active.id}
                      contentScope={`${state.connectionEpoch}:${state.timeline.sessionId ?? active.id}`}
                      {...(state.transcript === undefined
                        ? {}
                        : {
                            omittedNodeIds: state.transcript.omittedNodeIds,
                            contentVersions: state.transcript.contentVersions,
                          })}
                      loadFullNode={(nodeId, signal) => store.loadTranscriptNode(nodeId, signal)}
                      panelId={CONVERSATION_VIEW_IDS.trajectory.panel}
                      panelLabelledBy={CONVERSATION_VIEW_IDS.trajectory.tab}
                      nodes={state.timeline.nodes}
                      {...(state.timeline.nodeChangeStart === undefined
                        ? {}
                        : { nodeChangeStart: state.timeline.nodeChangeStart })}
                      {...(state.timeline.nodeChangeBase === undefined
                        ? {}
                        : { nodeChangeBase: state.timeline.nodeChangeBase })}
                      streaming={streaming}
                      running={activeRunning}
                    />
                  )}
                  <QueuePanel
                    key={state.activeSessionId}
                    items={state.queue}
                    directEntries={state.directPromptReceipts}
                    {...(state.pendingPrompts === undefined
                      ? {}
                      : {
                          pendingEntries: state.pendingPrompts.filter(
                            (prompt) => prompt.sessionId === state.activeSessionId,
                          ),
                        })}
                    transcript={state.transcript}
                    connected={backend.kind === 'connected'}
                    running={activeRunning}
                    onEdit={queueOnEdit}
                    onRemove={queueOnRemove}
                    onModeChange={queueOnModeChange}
                    onDismissPending={(id) => store.dismissPendingPrompt(id)}
                    onLoadImage={timelineOnLoadImage}
                  />
                  {pendingPermissions.length > 0 || pendingQuestions.length > 0 ? (
                    // No live region here: the cards in this slot carry their
                    // own semantics, and a timed question re-renders its
                    // countdown every 250ms. A `polite` container would queue an
                    // announcement per tick and keep interrupting the user for
                    // as long as the card is on screen. The cards themselves
                    // announce the transitions that matter (an unreachable wait,
                    // a queued reply), and the composer's own `role="status"`
                    // already reports a newly arrived question.
                    <div className="dsh-conversation__interactions">
                      {activeRunning ? null : (
                        <button
                          className="dsh-button dsh-button--danger dsh-button--compact dsh-conversation__interaction-stop"
                          type="button"
                          aria-label={t('composer.stopResponse')}
                          disabled={backend.kind !== 'connected'}
                          onClick={composerOnCancel}
                        >
                          <Icon name="stop" />
                          {t('composer.stop')}
                        </button>
                      )}
                      {pendingPermissions.map(({ request, command, contentPending, contentFailed }) => (
                        <ApprovalCard
                          key={request.id}
                          request={request}
                          disabled={respondingInteractionId !== undefined}
                          contentPending={contentPending}
                          contentFailed={contentFailed}
                          {...(command === undefined ? {} : { command })}
                          onRespond={approvalRespondFor(request)}
                        />
                      ))}
                      {pendingQuestions.map((question) => (
                        <UserQuestionCard
                          key={JSON.stringify([
                            question.sessionId,
                            question.callId ?? question.rpcId ?? question.id,
                          ])}
                          question={question}
                          disabled={respondingInteractionId !== undefined}
                          onRespond={questionRespondFor(question)}
                          onCancel={questionCancelFor(question)}
                          {...(question.state === 'open' && question.timed === true
                            ? {
                                onAttachWait: questionWaitFor(question).attach,
                                onReleaseWait: questionWaitFor(question).release,
                              }
                            : {})}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="dsh-compose-area">
                    {backend.kind === 'connected' ? (
                      <ModsBand
                        key={`${state.connectionEpoch}:${active.id}`}
                        sessionId={active.id}
                        featureRequest={store.featureRequest}
                      />
                    ) : null}
                    {subagentReadOnlyReason === undefined || activeRunning ? (
                      <>
                        <ConnectedComposer
                          key={active.id}
                          draftKey={active.id}
                          store={store}
                          modelScope="session"
                          disabled={backend.kind !== 'connected'}
                          inputDisabled={
                            subagentReadOnlyReason !== undefined ||
                            (activeSubagent !== undefined && activeSubagentState?.parentAvailable === false)
                          }
                          attachmentsDisabled={activeSubagent !== undefined && !state.subagentImagePrompts}
                          running={activeRunning}
                          attachments={attachments}
                          {...(activeSubagent === undefined
                            ? {
                                editorContext: state.editorContext,
                                editorContextAvailableKinds: state.editorContextAvailableKinds,
                                editorContextLoading: state.editorContextLoading,
                                onCaptureEditorContext: composerOnCaptureEditorContext,
                                onRemoveEditorContext: composerOnRemoveEditorContext,
                                onPreviewEditorContext: composerOnPreviewEditorContext,
                              }
                            : {})}
                          configuration={state.configuration}
                          presets={state.presets}
                          {...(newSessionPresetSelectionEnabled === undefined
                            ? {}
                            : { presetSelectionEnabled: newSessionPresetSelectionEnabled })}
                          permissionPresets={state.permissionPresets}
                          commands={state.commands}
                          popupSelects={popupSelects}
                          references={visibleReferenceCandidates}
                          referenceLoading={visibleReferenceLoading}
                          {...(imageLimits === undefined ? {} : { imageLimits })}
                          busyEnter={readyDshUiPreferences?.busyEnter ?? state.busyEnter}
                          modelPickerOpenRequest={modelPickerOpenRequest}
                          {...(estimatedContextTokens === undefined ? {} : { estimatedContextTokens })}
                          {...(contextWindowTokens === undefined ? {} : { contextWindowTokens })}
                          {...(contextPressure?.breakdown === undefined
                            ? {}
                            : { contextBreakdown: contextPressure.breakdown })}
                          promptMode={state.promptMode}
                          configurationDisabled={backend.kind !== 'connected'}
                          presetMutable={
                            activeSubagent === undefined && active.blank && active.status === 'idle'
                          }
                          onConfigurationChange={composerOnConfigurationChange}
                          onPromptModeChange={composerOnPromptModeChange}
                          onCommand={composerOnCommand}
                          onOpenSkillDocument={(skillId) => {
                            void store
                              .openSkillDocument(active.id, skillId)
                              .catch((reason: unknown) =>
                                setError(
                                  reason instanceof Error
                                    ? reason.message
                                    : t('commands.openSkillDocumentFailed'),
                                ),
                              )
                          }}
                          onPopupSelect={composerOnPopupSelect}
                          onCommandQueryChange={composerOnCommandQueryChange}
                          onReferenceQueryChange={composerOnReferenceQueryChange}
                          onPickAttachment={composerOnPickAttachment}
                          onIngestFiles={composerOnIngestFiles}
                          attachmentPreviews={attachmentPreviews}
                          attachmentPreviewFailures={attachmentPreviewFailures}
                          openFileCandidates={visibleOpenFileCandidates}
                          openFilePickerOpen={visibleOpenFilePickerOpen}
                          openFilePickerLoading={visibleOpenFilePickerLoading}
                          {...(state.preferredOpenFileId === undefined
                            ? {}
                            : { preferredOpenFileId: state.preferredOpenFileId })}
                          attachedOpenFileIds={attachedOpenFileIds}
                          {...(attachingOpenFileId === undefined ? {} : { attachingOpenFileId })}
                          onToggleOpenFilePicker={composerOnToggleOpenFilePicker}
                          onExtrasOpenChange={composerOnExtrasOpenChange}
                          onSelectOpenFile={composerOnSelectOpenFile}
                          onRemoveAttachment={composerOnRemoveAttachment}
                          onSubmit={composerOnSubmit}
                          onCancel={composerOnCancel}
                          onSteerQueue={composerOnSteerQueue}
                          queue={state.queue}
                        />
                        {composerStatus === undefined ? null : (
                          <div className="dsh-composer__status">{composerStatus}</div>
                        )}
                      </>
                    ) : (
                      <div className="dsh-subagent-readonly" role="status">
                        <strong>{t('subagents.readOnly.title')}</strong>
                        <span>
                          {t(
                            subagentReadOnlyReason === 'oneShot'
                              ? 'subagents.readOnly.oneShot'
                              : 'subagents.readOnly.parent',
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      </main>
    </AppErrorBoundary>
  )
}
