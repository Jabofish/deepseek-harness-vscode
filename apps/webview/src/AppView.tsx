import type { ReactElement } from 'react'
import { EmptyState } from '@dsh-vscode/ui'
import { AppErrorBoundary } from './features/errors/AppErrorBoundary.js'
import { AppSettingsDrawer } from './features/settings/AppSettingsDrawer.js'
import { ScheduleDrawer } from './features/schedules/ScheduleDrawer.js'
import { RuntimeMissingView } from './features/runtime/RuntimeMissingView.js'
import { RuntimeConnectionView } from './features/runtime/RuntimeConnectionView.js'
import { EmptySessionPosture } from './features/sessions/EmptySessionPosture.js'
import { ConnectedComposer } from './features/composer/ConnectedComposer.js'
import { AppHeader } from './features/shell/AppHeader.js'
import { SessionLineage } from './features/subagents/SessionLineage.js'
import { ConversationActionsMenu } from './features/shell/ConversationActionsMenu.js'
import { ExportDialog } from './features/export/ExportDialog.js'
import { GoalBar } from './features/goals/GoalBar.js'
import { GoalTodoStrip } from './features/goals/GoalTodoStrip.js'
import { Timeline } from './features/chat/Timeline.js'
import { TrajectoryView } from './features/trajectory/TrajectoryView.js'
import { QueuePanel } from './features/input/QueuePanel.js'
import { ApprovalCard } from './features/interactions/ApprovalCard.js'
import { UserQuestionCard } from './features/interactions/UserQuestionCard.js'
import { TodoList } from './features/goals/TodoList.js'
import { Icon } from './ui/Icon.js'
import { rememberWelcomeDismissal, rememberRuntimeUpdateDismissal } from './app/dismissed-notices.js'
import type { OpenFileCandidate } from './app/store.js'
import type { useAppController } from './AppController.js'
import { CONVERSATION_VIEW_IDS } from './app/conversation-view-ids.js'

const EMPTY_OPEN_FILE_CANDIDATES: readonly OpenFileCandidate[] = []
export function AppView(props: ReturnType<typeof useAppController>): ReactElement {
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
    closeConversationActions,
    codingToolsEnabled,
    compatibilityWarning,
    composerOnCancel,
    composerOnCaptureEditorContext,
    composerOnCommand,
    composerOnCommandQueryChange,
    composerOnConfigurationChange,
    composerOnExtrasOpenChange,
    composerOnIngestFiles,
    composerOnModelRetry,
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
    conversationFontSize,
    conversationFontStyle,
    conversationView,
    discardAttachmentDrafts,
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
    sessionModelCurrent,
    sessionModelDirectoryError,
    sessionModelDirectoryLoading,
    sessionModelFailures,
    sessionModelRoutable,
    sessionModels,
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
  return (
    <AppErrorBoundary>
      <main className="dsh-app" data-dsh-theme={themePreference}>
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
          discardAttachmentDrafts={discardAttachmentDrafts}
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
        {runtimeUpdateVisible ? (
          <div className="dsh-app__runtime-update dsh-toast" role="status">
            <div className="dsh-app__runtime-update-copy">
              <strong>{t('runtime.updateAvailable')}</strong>
              <span>
                {t('runtime.updateAvailableDetail', {
                  version: state.dshUpdate?.latestVersion ?? '—',
                })}
              </span>
              <div className="dsh-app__runtime-update-actions">
                <button
                  className="dsh-button dsh-button--secondary dsh-button--compact"
                  type="button"
                  onClick={() => store.setDrawer('settings')}
                >
                  {t('runtime.openSettings')}
                </button>
              </div>
            </div>
            <button
              className="dsh-icon-button dsh-app__runtime-update-dismiss"
              type="button"
              aria-label={t('runtime.dismissUpdate')}
              title={t('runtime.dismissUpdate')}
              onClick={() => {
                setDismissedRuntimeUpdateVersion(runtimeUpdateVersion)
                rememberRuntimeUpdateDismissal(runtimeUpdateVersion)
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        ) : null}
        {error === undefined ? null : (
          <div key={error} className="dsh-app__error dsh-toast" role="alert" aria-live="assertive">
            <span>{error}</span>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('app.dismissError')}
              title={t('app.dismissError')}
              onClick={() => setError(undefined)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {connectionMessage === undefined || connectionKey === dismissedConnection ? null : (
          <div
            className={`dsh-app__connection-alert dsh-toast${compatibilityWarning === undefined ? '' : ' dsh-app__connection-alert--warning'}`}
            role="alert"
          >
            <div>
              <strong>
                {compatibilityWarning !== undefined
                  ? t('app.compatibilityWarning')
                  : backend.kind === 'port-conflict'
                    ? t('app.portConflict')
                    : t('app.connectionFailed')}
              </strong>
              <span>{connectionMessage}</span>
            </div>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('app.dismissConnectionError')}
              title={t('app.dismissConnectionError')}
              onClick={() => setDismissedConnection(connectionKey)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
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
              {backend.kind === 'connected' &&
              active === undefined &&
              state.sessions.length === 0 &&
              state.workspaces.length > 0 &&
              welcomeVisible ? (
                <div className="dsh-welcome-notice dsh-toast" role="status">
                  <div>
                    <strong>{t('welcome.title')}</strong>
                    <span>{t('welcome.description')}</span>
                  </div>
                  <button
                    className="dsh-icon-button"
                    type="button"
                    aria-label={t('welcome.dismiss')}
                    title={t('welcome.dismiss')}
                    onClick={() => {
                      setWelcomeVisible(false)
                      rememberWelcomeDismissal()
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ) : null}
              {active === undefined && state.pendingSession !== undefined ? (
                <section
                  className="dsh-conversation"
                  data-conversation-font-size={conversationFontSize}
                  aria-label={t('app.createSession')}
                >
                  <div className="dsh-conversation__topbar">
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
                  </div>
                  <div className="dsh-app__empty">
                    <EmptyState title={t('app.createSession')} description={t('app.workspacePickerHint')} />
                  </div>
                  <div className="dsh-compose-area">
                    <ConnectedComposer
                      key={state.pendingSession.revision}
                      disabled={backend.kind !== 'connected'}
                      running={false}
                      attachments={attachments}
                      configuration={state.pendingSession.configuration}
                      models={state.models}
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
                        state={backend}
                        loadingSessionCatalog={backend.kind === 'connected'}
                        onRetry={retryConnection}
                        onOpenSettings={() => store.setDrawer('settings')}
                        onReadDiagnostics={() => store.readDiagnostics()}
                        onReconnectDiagnostics={() => store.reconnect()}
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
                      {codingToolsEnabled ? (
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
                      ) : null}
                    </div>
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
                    <ConversationActionsMenu onClose={closeConversationActions}>
                      {conversationActionItems}
                    </ConversationActionsMenu>
                  </div>
                  {visibleExportSessionId === undefined ? null : (
                    <ExportDialog
                      sessionId={visibleExportSessionId}
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
                  {state.goals.length > 0 ? (
                    <>
                      <GoalBar goals={state.goals} onUpdate={goalOnUpdate} onClear={goalOnClear} />
                      <GoalTodoStrip goals={state.goals} />
                    </>
                  ) : null}
                  {conversationView === 'chat' ? (
                    <Timeline
                      sessionId={active.id}
                      panelId={CONVERSATION_VIEW_IDS.chat.panel}
                      panelLabelledBy={CONVERSATION_VIEW_IDS.chat.tab}
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
                    />
                  ) : (
                    <TrajectoryView
                      sessionId={active.id}
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
                    />
                  )}
                  <QueuePanel
                    items={state.queue}
                    running={activeRunning}
                    onEdit={queueOnEdit}
                    onRemove={queueOnRemove}
                    onModeChange={queueOnModeChange}
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
                      {pendingPermissions.map(({ request, command }) => (
                        <ApprovalCard
                          key={request.id}
                          request={request}
                          disabled={respondingInteractionId !== undefined}
                          {...(command === undefined ? {} : { command })}
                          onRespond={approvalRespondFor(request)}
                        />
                      ))}
                      {pendingQuestions.map((question) => (
                        <UserQuestionCard
                          key={question.id}
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
                    <TodoList key={active?.id ?? 'todo-list'} todos={state.todos} />
                    {pendingPermissions.length === 0 &&
                    pendingQuestions.every((question) => question.state === 'continued') ? (
                      subagentReadOnlyReason === undefined || activeRunning ? (
                        <>
                          <ConnectedComposer
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
                            models={sessionModels}
                            modelFailures={sessionModelFailures}
                            modelLoading={sessionModelDirectoryLoading}
                            {...(sessionModelCurrent === undefined
                              ? {}
                              : { modelCurrent: sessionModelCurrent })}
                            {...(sessionModelDirectoryError === undefined
                              ? {}
                              : { modelError: sessionModelDirectoryError })}
                            onModelRetry={composerOnModelRetry}
                            {...(sessionModelRoutable === undefined
                              ? {}
                              : { modelRoutable: sessionModelRoutable })}
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
                            configurationDisabled={backend.kind !== 'connected' || activeRunning}
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
                          <div className="dsh-composer__status">{composerStatus}</div>
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
                      )
                    ) : (
                      // The interaction cards take the composer's slot while they
                      // wait. Queueing a message is still legitimate DSH input, so
                      // the input surface states why it is unavailable instead of
                      // silently disappearing.
                      <div className="dsh-compose-hint" role="status">
                        <Icon name="alert" />
                        <span>{t('composer.pendingHint')}</span>
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
