import type { Dispatch, ReactElement, RefObject, SetStateAction } from 'react'
import type { AppStore } from '../../app/store.js'
import { setDraft } from '../../app/draft-store.js'
import type { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { JobsDrawer } from '../jobs/JobsDrawer.js'
import { ChangesDrawer } from '../changes/ChangesDrawer.js'
import { TasksDrawer } from '../tasks/TasksDrawer.js'
import { CheckpointDrawer } from '../checkpoints/CheckpointDrawer.js'
import { PromptTemplatesDrawer } from '../prompt-templates/PromptTemplatesDrawer.js'
import { SubagentDrawer } from '../subagents/SubagentDrawer.js'
import { DiagnosticsDrawer } from '../diagnostics/DiagnosticsDrawer.js'
import { ConversationEventToggle } from './ConversationEventToggle.js'

interface ConversationActionItemsProps {
  readonly activeId: string | undefined
  readonly isSubagent: boolean
  readonly state: ReturnType<AppStore['getState']>
  readonly store: AppStore
  readonly codingToolsEnabled: boolean
  readonly dshEventCount: number
  readonly showDshEvents: boolean
  readonly setShowDshEvents: (visible: boolean) => void
  readonly visibleExportSessionId: string | undefined
  readonly toggleExport: () => void
  readonly localeControlRef: RefObject<HTMLSpanElement | null>
  readonly localeOpen: boolean
  readonly setLocaleOpen: Dispatch<SetStateAction<boolean>>
  readonly locale: ReturnType<typeof useI18n>['locale']
  readonly applyLocale: (locale: 'en' | 'zh') => void
  readonly timelineOnOpenLink: (href: string) => Promise<void>
  readonly discardAttachmentDrafts: () => void
  readonly setError: (message: string | undefined) => void
  readonly t: ReturnType<typeof useI18n>['t']
}

export function ConversationActionItems({
  activeId,
  isSubagent,
  state,
  store,
  codingToolsEnabled,
  dshEventCount,
  showDshEvents,
  setShowDshEvents,
  visibleExportSessionId,
  toggleExport,
  localeControlRef,
  localeOpen,
  setLocaleOpen,
  locale,
  applyLocale,
  timelineOnOpenLink,
  discardAttachmentDrafts,
  setError,
  t,
}: ConversationActionItemsProps): ReactElement | null {
  if (activeId === undefined) return null
  return (
    <>
      {/* The keys reset popover state when the last entry disappears,
        so a refilled catalog never reopens stale. */}
      {(state.unavailableLists?.length ?? 0) > 0 ? (
        <div role="alert">
          {t('app.listsUnavailable', {
            lists: state
              .unavailableLists!.map(
                (key) =>
                  ({
                    queue: t('lists.queue'),
                    goals: t('lists.goals'),
                    jobs: t('lists.jobs'),
                    checkpoints: t('lists.checkpoints'),
                    templates: t('lists.templates'),
                  })[key] ?? key,
              )
              .join(', '),
          })}
        </div>
      ) : null}
      <JobsDrawer
        key={state.jobs.length > 0 ? 'jobs' : 'jobs-empty'}
        jobs={state.jobs}
        jobControllerAvailable={state.jobControllerAvailable}
        following={state.jobFollow}
        onFollow={(jobId) => store.followJob(jobId)}
        onStopFollowing={() => store.stopFollowingJob()}
        onKill={(jobId) => store.killJob(jobId)}
      />
      {codingToolsEnabled ? (
        <ChangesDrawer
          key={`changes-${activeId}`}
          changes={state.changes}
          loading={state.changesLoading}
          refreshFailed={state.changesRefreshFailed}
          onRefresh={() => store.refreshChanges(activeId)}
          onOpen={(changeId) => store.openChange(changeId)}
          onDetail={(changeId) => store.getChangeDetail(changeId)}
          onMarkReviewed={(changeId, reviewState) => store.markChangeReviewed(changeId, reviewState)}
        />
      ) : null}
      <TasksDrawer
        key={`tasks-${activeId}`}
        tasks={state.tasks}
        loading={state.tasksLoading}
        scope={state.taskScope}
        complete={state.tasksComplete}
        omittedSessions={state.tasksOmittedSessions}
        alwaysVisible
        onRefresh={() => store.refreshTasks(activeId, false, state.taskScope)}
        onScopeChange={(scope) => store.refreshTasks(activeId, false, scope)}
        onOpen={async (task) => {
          if (task.sessionId === undefined) return
          // A subagent row names the child in `sourceId`; `sessionId` is its
          // parent. The store resolves the child through whichever catalog
          // actually lists it, so a workspace-scoped row stays openable while
          // a different conversation is on screen.
          await store.openSession(task.kind === 'subagent' ? task.sourceId : task.sessionId)
        }}
        onStop={async (task) => {
          await store.stopTask(task.taskId, task.taskRevision)
          await store.refreshTasks(activeId, false, state.taskScope)
        }}
        onAnswer={async (task, answer) => {
          if (task.interactionId === undefined) return
          await store.answerTask(task.taskId, task.interactionId, answer)
          await store.refreshTasks(activeId, false, state.taskScope)
        }}
      />
      <CheckpointDrawer
        key={`checkpoints-${activeId}`}
        checkpoints={state.checkpoints}
        loading={state.checkpointsLoading}
        onRefresh={() => store.refreshCheckpoints(activeId)}
        onCreate={(label) => store.createCheckpoint(label)}
        onPreview={(checkpointId) => store.previewCheckpoint(checkpointId)}
        onDelete={(checkpointId) => store.deleteCheckpoint(checkpointId)}
        onRestore={(checkpointId, previewId, conflictPolicy) =>
          store.restoreCheckpoint(checkpointId, previewId, conflictPolicy)
        }
      />
      <PromptTemplatesDrawer
        onOpenLink={timelineOnOpenLink}
        key={`prompt-templates-${activeId}`}
        templates={state.promptTemplates}
        loading={state.promptTemplatesLoading}
        onRefresh={() => store.refreshPromptTemplates(activeId)}
        onRead={(templateId) => store.readPromptTemplate(templateId)}
        onInsert={(templateId, variables) => store.insertPromptTemplate(templateId, variables)}
        onCreate={(draft) => store.createPromptTemplate(draft)}
        onUpdate={(templateId, patch) => store.updatePromptTemplate(templateId, patch)}
        onDelete={(templateId) => store.deletePromptTemplate(templateId)}
        onApply={(text) => {
          setDraft((current) => (current.trim() === '' ? text : `${current}\n\n${text}`))
          setError(undefined)
        }}
      />
      <SubagentDrawer
        key={`subagents-${activeId}`}
        parentSessionId={activeId}
        catalog={state.subagents}
        summaries={state.sessions}
        onLoadChildren={(sessionId) => store.loadSubagentChildren(sessionId)}
        onOpenChild={(entry, parentAvailable) => {
          // rc.6 requires already-durable image blocks and therefore does
          // not advertise inline subagent image prompts. Alpha hosts do;
          // preserve those opaque drafts across child navigation.
          if (!state.subagentImagePrompts) discardAttachmentDrafts()
          void store
            .openSubagent(entry, parentAvailable)
            .catch((reason: unknown) =>
              setError(reason instanceof Error ? reason.message : t('app.error.openSubagent')),
            )
        }}
      />
      <DiagnosticsDrawer
        key={`diagnostics-${activeId}`}
        onRead={() => store.readDiagnostics()}
        onReconnect={() => store.reconnect()}
        onShowOutput={() => store.showDiagnostics()}
      />
      {codingToolsEnabled && dshEventCount > 0 ? (
        <ConversationEventToggle
          count={dshEventCount}
          pressed={showDshEvents}
          onPressedChange={setShowDshEvents}
        />
      ) : null}
      {!isSubagent ? (
        <button
          type="button"
          className="dsh-conversation__export-trigger"
          aria-expanded={visibleExportSessionId !== undefined}
          onClick={toggleExport}
        >
          {t('export.trigger')}
        </button>
      ) : null}
      <span ref={localeControlRef} className="dsh-conversation__locale-control">
        <button
          type="button"
          className="dsh-conversation__locale-switch"
          aria-label={t('locale.label')}
          title={t('locale.label')}
          aria-haspopup="listbox"
          aria-expanded={localeOpen}
          onClick={() => setLocaleOpen((current) => !current)}
        >
          <span>{locale === 'zh' ? t('locale.chinese') : t('locale.english')}</span>
          <Icon name="chevron-down" />
        </button>
        {localeOpen ? (
          <div className="dsh-conversation__locale-menu" role="listbox" aria-label={t('locale.label')}>
            {(['en', 'zh'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={locale === option}
                className={`dsh-conversation__locale-option${
                  locale === option ? ' dsh-conversation__locale-option--selected' : ''
                }`}
                onClick={() => {
                  applyLocale(option)
                  setLocaleOpen(false)
                }}
              >
                {option === 'zh' ? t('locale.chinese') : t('locale.english')}
              </button>
            ))}
          </div>
        ) : null}
      </span>
    </>
  )
}
