import type { Dispatch, FormEvent, KeyboardEvent, ReactElement, RefObject, SetStateAction } from 'react'
import type { ScheduleCatalogEntry } from '@dsh-vscode/domain'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import type { Locale, Translate } from '../../i18n.js'
import {
  EDIT_TIMINGS,
  formatDeliveryOccurrence,
  formatRule,
  linkedSessionMessageKey,
  timingChoices,
  timingLabel,
  type DetailTab,
  type EditDraft,
  type EditState,
  type HistoryView,
  type TimingChoice,
} from './schedule-model.js'
import type { ScheduleSessionLink } from './session-link.js'
import type { SchedulePanelProps } from './SchedulePanel.js'

interface ScheduleDetailProps {
  readonly props: SchedulePanelProps
  readonly t: Translate
  readonly locale: Locale
  readonly labelId: string
  readonly selected: ScheduleCatalogEntry
  readonly selectedLinkedSession: ScheduleSessionLink | undefined
  readonly moreActionsTriggerRef: RefObject<HTMLButtonElement | null>
  readonly moreActionsOpen: boolean
  readonly setMoreActionsOpen: Dispatch<SetStateAction<boolean>>
  readonly busy: boolean
  readonly catalogStatus: 'loading' | 'ready' | 'error' | 'unavailable'
  readonly selectedInCatalog: boolean
  readonly closeDetails: () => void
  readonly onTabKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly tabButtonsRef: RefObject<Record<DetailTab, HTMLButtonElement | null>>
  readonly tab: DetailTab
  readonly setActiveTab: (tab: DetailTab) => void
  readonly openHistory: () => void
  readonly operationError: string | undefined
  readonly operationNotice: string | undefined
  readonly catalogSettled: boolean
  readonly confirmDelete: boolean
  readonly confirmDeleteRef: RefObject<HTMLDivElement | null>
  readonly deleteSelected: () => void
  readonly setConfirmDelete: Dispatch<SetStateAction<boolean>>
  readonly editing: boolean
  readonly draft: EditDraft | undefined
  readonly submitEdit: (event: FormEvent<HTMLFormElement>) => void
  readonly patchEditDraft: (patch: Partial<EditDraft>) => void
  readonly updateEditDraft: (update: (current: EditDraft) => EditDraft) => void
  readonly draftDirty: boolean
  readonly setEditState: Dispatch<SetStateAction<EditState>>
  readonly setOperationError: Dispatch<SetStateAction<string | undefined>>
  readonly beginEdit: () => void
  readonly history: HistoryView
  readonly loadHistory: (record: ScheduleCatalogEntry, before?: string, reset?: boolean) => void
  readonly showRetentionDetails: boolean
  readonly setShowRetentionDetails: Dispatch<SetStateAction<boolean>>
}

export function ScheduleDetail(input: ScheduleDetailProps): ReactElement {
  const {
    props,
    t,
    locale,
    labelId,
    selected,
    selectedLinkedSession,
    moreActionsTriggerRef,
    moreActionsOpen,
    setMoreActionsOpen,
    busy,
    catalogStatus,
    selectedInCatalog,
    closeDetails,
    onTabKeyDown,
    tabButtonsRef,
    tab,
    setActiveTab,
    openHistory,
    operationError,
    operationNotice,
    catalogSettled,
    confirmDelete,
    confirmDeleteRef,
    deleteSelected,
    setConfirmDelete,
    editing,
    draft,
    submitEdit,
    patchEditDraft,
    updateEditDraft,
    draftDirty,
    setEditState,
    setOperationError,
    beginEdit,
    history,
    loadHistory,
    showRetentionDetails,
    setShowRetentionDetails,
  } = input
  return (
    <aside
      className="dsh-schedule-panel__detail"
      id={`${labelId}-detail`}
      aria-label={t('schedules.detail.label')}
    >
      <div className="dsh-schedule-panel__detail-heading">
        <div>
          <div className="dsh-schedule-panel__linked-session">
            <button
              type="button"
              className="dsh-schedule-panel__linked-session-button"
              disabled={selectedLinkedSession?.status !== 'available'}
              aria-describedby={
                selectedLinkedSession !== undefined && selectedLinkedSession.status !== 'available'
                  ? `${labelId}-linked-session-state`
                  : undefined
              }
              onClick={() => {
                if (props.getLinkedSession(selected.sessionId).status === 'available')
                  props.onOpenLinkedSession(selected.sessionId)
              }}
            >
              {t('schedules.linkedSession.label', {
                title:
                  selectedLinkedSession?.status === 'available'
                    ? selectedLinkedSession.title
                    : selected.sessionId,
              })}
            </button>
            {selectedLinkedSession !== undefined && selectedLinkedSession.status !== 'available' ? (
              <p className="dsh-schedule-panel__eyebrow" id={`${labelId}-linked-session-state`}>
                {t(linkedSessionMessageKey(selectedLinkedSession))}
              </p>
            ) : null}
          </div>
          <h2>{selected.title}</h2>
        </div>
        <div className="dsh-schedule-panel__detail-heading-actions">
          <div className="dsh-schedule-panel__more-actions">
            <button
              ref={moreActionsTriggerRef}
              type="button"
              className="dsh-schedule-panel__icon-button"
              aria-label={t('schedules.moreActions')}
              aria-expanded={moreActionsOpen}
              aria-controls={moreActionsOpen ? `${labelId}-more-actions` : undefined}
              onClick={() => setMoreActionsOpen((open) => !open)}
            >
              ⋯
            </button>
            {moreActionsOpen ? (
              <div
                id={`${labelId}-more-actions`}
                className="dsh-schedule-panel__more-actions-menu"
                role="group"
                aria-label={t('schedules.moreActions')}
              >
                <button
                  type="button"
                  disabled={busy || catalogStatus === 'loading' || !selectedInCatalog}
                  onClick={() => {
                    setMoreActionsOpen(false)
                    setConfirmDelete(true)
                  }}
                >
                  {t('schedules.delete')}
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="dsh-schedule-panel__icon-button"
            aria-label={t('schedules.closeDetail')}
            onClick={closeDetails}
          >
            ×
          </button>
        </div>
      </div>
      <div
        className="dsh-schedule-panel__tabs"
        role="tablist"
        aria-orientation="horizontal"
        aria-label={t('schedules.detail.tabs')}
        onKeyDown={onTabKeyDown}
      >
        <button
          id={`${labelId}-tab-rule`}
          ref={(node) => {
            tabButtonsRef.current.rule = node
          }}
          type="button"
          role="tab"
          aria-controls={`${labelId}-panel-rule`}
          aria-selected={tab === 'rule'}
          tabIndex={tab === 'rule' ? 0 : -1}
          onClick={() => setActiveTab('rule')}
        >
          {t('schedules.detail.rule')}
        </button>
        <button
          id={`${labelId}-tab-history`}
          ref={(node) => {
            tabButtonsRef.current.history = node
          }}
          type="button"
          role="tab"
          aria-controls={`${labelId}-panel-history`}
          aria-selected={tab === 'history'}
          tabIndex={tab === 'history' ? 0 : -1}
          onClick={openHistory}
        >
          {t('schedules.detail.history')}
        </button>
      </div>

      {operationError !== undefined ? (
        <p className="dsh-schedule-panel__error" role="alert">
          {t(operationError)}
        </p>
      ) : null}
      {operationNotice !== undefined ? (
        <p className="dsh-schedule-panel__notice" role="status">
          {t(operationNotice)}
        </p>
      ) : null}
      {catalogSettled && !selectedInCatalog ? (
        <p className="dsh-schedule-panel__muted" role="status">
          {t('schedules.detail.missingFromCatalog')}
        </p>
      ) : null}

      {confirmDelete ? (
        <div
          ref={confirmDeleteRef}
          tabIndex={-1}
          className="dsh-schedule-panel__confirm"
          role="alertdialog"
          aria-label={t('schedules.delete.confirmTitle')}
          aria-describedby={`${labelId}-delete-copy`}
        >
          <p id={`${labelId}-delete-copy`}>{t('schedules.delete.confirm', { title: selected.title })}</p>
          <div className="dsh-schedule-panel__actions">
            <button
              type="button"
              className="dsh-schedule-panel__danger"
              disabled={busy || catalogStatus === 'loading' || !selectedInCatalog}
              onClick={deleteSelected}
            >
              {busy ? t('schedules.working') : t('schedules.delete.confirmAction')}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
              {t('schedules.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      <div
        id={`${labelId}-panel-rule`}
        role="tabpanel"
        aria-labelledby={`${labelId}-tab-rule`}
        tabIndex={0}
        hidden={tab !== 'rule'}
      >
        {editing && draft !== undefined ? (
          <form className="dsh-schedule-panel__editor" onSubmit={submitEdit}>
            <fieldset
              className="dsh-schedule-panel__editor-fields"
              disabled={
                busy || catalogStatus === 'loading' || !selectedInCatalog || selected.status !== 'active'
              }
            >
              <label>
                <span>{t('schedules.field.title')}</span>
                <input
                  value={draft.title}
                  maxLength={120}
                  required
                  onChange={(event) => patchEditDraft({ title: event.currentTarget.value })}
                />
              </label>
              <label>
                <span>{t('schedules.field.prompt')}</span>
                <textarea
                  value={draft.prompt}
                  required
                  rows={5}
                  onChange={(event) => patchEditDraft({ prompt: event.currentTarget.value })}
                />
              </label>
              <label>
                <span>{t('schedules.field.timing')}</span>
                <SelectMenu
                  className="dsh-schedule-panel__timing-picker"
                  icon="clock"
                  density="regular"
                  label={timingLabel(draft.timing, t)}
                  ariaLabel={t('schedules.field.timing')}
                  title={t('schedules.field.timing')}
                  value={draft.timing}
                  options={timingChoices(EDIT_TIMINGS, t)}
                  onChange={(value) => patchEditDraft({ timing: value as TimingChoice })}
                />
              </label>
              {draft.timing === 'at' ? (
                <div className="dsh-schedule-panel__timing-fields">
                  <label>
                    <span>{t('schedules.field.date')}</span>
                    <input
                      type="date"
                      required
                      value={draft.date}
                      onChange={(event) => patchEditDraft({ date: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>{t('schedules.field.time')}</span>
                    <input
                      type="time"
                      step="0.001"
                      required
                      value={draft.time}
                      onChange={(event) => patchEditDraft({ time: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>{t('schedules.field.timeZone')}</span>
                    <input
                      required
                      value={draft.timeZone}
                      onChange={(event) => patchEditDraft({ timeZone: event.currentTarget.value })}
                    />
                  </label>
                </div>
              ) : null}
              {draft.timing === 'every' ? (
                <label>
                  <span>{t('schedules.field.seconds')}</span>
                  <input
                    type="number"
                    min="60"
                    step="1"
                    required
                    value={draft.seconds}
                    onChange={(event) => patchEditDraft({ seconds: event.currentTarget.value })}
                  />
                </label>
              ) : null}
              {draft.timing === 'daily' || draft.timing === 'weekly' ? (
                <div className="dsh-schedule-panel__timing-fields">
                  <label>
                    <span>{t('schedules.field.time')}</span>
                    <input
                      type="time"
                      step="0.001"
                      required
                      value={draft.time}
                      onChange={(event) => patchEditDraft({ time: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>{t('schedules.field.timeZone')}</span>
                    <input
                      required
                      value={draft.timeZone}
                      onChange={(event) => patchEditDraft({ timeZone: event.currentTarget.value })}
                    />
                  </label>
                  {draft.timing === 'weekly' ? (
                    <fieldset className="dsh-schedule-panel__weekdays">
                      <legend>{t('schedules.field.weekdays')}</legend>
                      {([1, 2, 3, 4, 5, 6, 7] as const).map((day) => (
                        <label key={day}>
                          <input
                            type="checkbox"
                            checked={draft.weekdays.includes(day)}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked
                              updateEditDraft((current) => ({
                                ...current,
                                weekdays: checked
                                  ? [...current.weekdays, day]
                                  : current.weekdays.filter((value) => value !== day),
                              }))
                            }}
                          />
                          <span>{t(`schedules.weekday.${day}`)}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                </div>
              ) : null}
              {draft.timing === 'cron' ? (
                <div className="dsh-schedule-panel__timing-fields">
                  <label>
                    <span>{t('schedules.field.expression')}</span>
                    <input
                      required
                      value={draft.expression}
                      onChange={(event) => patchEditDraft({ expression: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>{t('schedules.field.timeZone')}</span>
                    <input
                      required
                      value={draft.timeZone}
                      onChange={(event) => patchEditDraft({ timeZone: event.currentTarget.value })}
                    />
                  </label>
                </div>
              ) : null}
            </fieldset>
            {draftDirty ? (
              <div className="dsh-schedule-panel__actions dsh-schedule-panel__editor-save-bar">
                <p role="status">{t('schedules.update.unsaved')}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditState({ editing: false })
                    setOperationError(undefined)
                  }}
                >
                  {t('schedules.cancel')}
                </button>
                <button
                  type="submit"
                  className="dsh-schedule-panel__primary"
                  disabled={
                    busy ||
                    catalogStatus !== 'ready' ||
                    !selectedInCatalog ||
                    selected.status !== 'active' ||
                    draft.title.trim() === '' ||
                    draft.title.trim().length > 120 ||
                    draft.prompt.trim() === '' ||
                    (draft.timing === 'weekly' && draft.weekdays.length === 0)
                  }
                >
                  {busy ? t('schedules.update.saving') : t('schedules.save')}
                </button>
              </div>
            ) : null}
          </form>
        ) : (
          <div className="dsh-schedule-panel__rule">
            <dl>
              <div>
                <dt>{t('schedules.field.title')}</dt>
                <dd>{selected.title}</dd>
              </div>
              <div>
                <dt>{t('schedules.field.prompt')}</dt>
                <dd className="dsh-schedule-panel__prompt">{selected.prompt}</dd>
              </div>
              <div>
                <dt>{t('schedules.field.timing')}</dt>
                <dd>{formatRule(selected, t)}</dd>
              </div>
              <div>
                <dt>{t('schedules.field.next')}</dt>
                <dd>
                  <time dateTime={selected.scheduledAt}>
                    {new Date(selected.scheduledAt).toLocaleString()}
                  </time>
                </dd>
              </div>
              {selected.lastDelivery !== undefined ? (
                <div>
                  <dt>{t('schedules.field.lastDelivery')}</dt>
                  <dd>
                    <time dateTime={selected.lastDelivery.scheduledAt}>
                      {formatDeliveryOccurrence(selected.lastDelivery.scheduledAt, selected, locale)}
                    </time>
                  </dd>
                </div>
              ) : null}
            </dl>
            {selected.status === 'inactive' ? (
              <p className="dsh-schedule-panel__muted">{t('schedules.inactiveNotice')}</p>
            ) : null}
            <div className="dsh-schedule-panel__actions">
              <button
                type="button"
                className="dsh-schedule-panel__primary"
                disabled={
                  busy || catalogStatus === 'loading' || !selectedInCatalog || selected.status !== 'active'
                }
                onClick={beginEdit}
              >
                {t('schedules.edit')}
              </button>
            </div>
          </div>
        )}
      </div>
      <section
        id={`${labelId}-panel-history`}
        className="dsh-schedule-panel__history"
        role="tabpanel"
        aria-labelledby={`${labelId}-tab-history`}
        tabIndex={0}
        hidden={tab !== 'history'}
      >
        {history.status === 'idle' || (history.status === 'loading' && history.records.length === 0) ? (
          <p role="status">{t('schedules.history.loading')}</p>
        ) : null}
        {history.status === 'error' ? (
          <div className="dsh-schedule-panel__error" role="alert">
            <span>
              {t(
                history.error === 'schedule_not_found'
                  ? 'schedules.history.missing'
                  : history.error === 'delivery_cursor_not_found'
                    ? 'schedules.history.cursorExpired'
                    : 'schedules.history.failed',
              )}
            </span>
            <button type="button" onClick={() => loadHistory(selected, undefined, true)}>
              {t(
                history.error === 'delivery_cursor_not_found'
                  ? 'schedules.history.refresh'
                  : 'schedules.retry',
              )}
            </button>
          </div>
        ) : null}
        {history.status === 'ready' && history.records.length === 0 ? (
          <p>{t('schedules.history.empty')}</p>
        ) : null}
        {history.earlierRecordsUnavailable ? (
          <p className="dsh-schedule-panel__muted">{t('schedules.history.unavailable')}</p>
        ) : null}
        <ol className="dsh-schedule-panel__deliveries">
          {history.records.map((delivery) => (
            <li key={delivery.messageId}>
              <span className="dsh-schedule-panel__delivery-time">
                <span aria-hidden="true">◷</span>
                <time dateTime={delivery.scheduledAt}>
                  {formatDeliveryOccurrence(delivery.scheduledAt, selected, locale)}
                </time>
              </span>
              {delivery.prompt === undefined ? null : <p>{delivery.prompt}</p>}
            </li>
          ))}
        </ol>
        {history.nextBefore !== undefined ? (
          <button
            type="button"
            disabled={history.status === 'loading'}
            onClick={() => loadHistory(selected, history.nextBefore)}
          >
            {t('schedules.history.loadOlder')}
          </button>
        ) : null}
        {history.status === 'ready' &&
        history.records.length > 0 &&
        history.nextBefore === undefined &&
        history.earlierRecordsPruned ? (
          <div className="dsh-schedule-panel__history-pruned" role="status">
            <span>{t('schedules.history.pruned')}</span>
            {history.retention === undefined ? null : (
              <>
                <button
                  type="button"
                  aria-label={t(
                    showRetentionDetails
                      ? 'schedules.history.retention.hide'
                      : 'schedules.history.retention.show',
                  )}
                  aria-expanded={showRetentionDetails}
                  aria-controls={`${labelId}-history-retention`}
                  onClick={() => setShowRetentionDetails((visible) => !visible)}
                >
                  ⓘ
                </button>
                <p id={`${labelId}-history-retention`} hidden={!showRetentionDetails}>
                  {t('schedules.history.retention', history.retention)}
                </p>
              </>
            )}
          </div>
        ) : null}
      </section>
    </aside>
  )
}
