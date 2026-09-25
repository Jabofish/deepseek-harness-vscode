import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type {
  ScheduleAtInput,
  ScheduleAtValue,
  ScheduleCatalogEntry,
  ScheduleDeliveryRecord,
  ScheduleDeleteResult,
  ScheduleHistoryPage,
  ScheduleHistoryResult,
  ScheduleRecord,
  ScheduleTimingChange,
  ScheduleUpdateResult,
} from '@dsh-vscode/domain'
import type { FeatureHostEvent, FeatureRequest } from '@dsh-vscode/webview-protocol'

import { useI18n } from '../../i18n.js'
import './schedule-panel.css'

export interface SchedulePanelProps {
  readonly featureRequest: <T>(request: FeatureRequest) => Promise<T>
  readonly subscribeFeature: (listener: (message: FeatureHostEvent) => void) => () => void
  /** Starts a new DSH Session and focuses its Composer, where `schedule_create` remains Host-owned. */
  readonly onStartScheduleSession: () => void | Promise<void>
}

type CatalogPayload = { readonly kind: 'schedule.catalog'; readonly items: readonly ScheduleCatalogEntry[] }
type HistoryPayload = { readonly kind: 'schedule.history'; readonly result: ScheduleHistoryResult }
type UpdatePayload = { readonly kind: 'schedule.updated'; readonly result: ScheduleUpdateResult }
type DeletePayload = { readonly kind: 'schedule.deleted'; readonly result: ScheduleDeleteResult }
type ScheduleUpdateFeaturePayload = Extract<FeatureRequest, { readonly type: 'schedule.update' }>['payload']
type DetailTab = 'rule' | 'history'
type TimingChoice = 'keep' | 'at' | 'every' | 'daily' | 'weekly' | 'cron'
type StatusFilter = 'all' | 'active' | 'inactive'

interface EditDraft {
  readonly title: string
  readonly prompt: string
  readonly timing: TimingChoice
  readonly date: string
  readonly time: string
  readonly timeZone: string
  readonly seconds: string
  readonly weekdays: readonly number[]
  readonly expression: string
}

interface HistoryView {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly records: readonly ScheduleDeliveryRecord[]
  readonly earlierRecordsUnavailable: boolean
  readonly earlierRecordsPruned: boolean
  readonly retention?: ScheduleHistoryPage['retention']
  readonly nextBefore?: string
  readonly error?: 'schedule_not_found' | 'delivery_cursor_not_found' | 'request_failed'
}

const EMPTY_HISTORY: HistoryView = {
  status: 'idle',
  records: [],
  earlierRecordsUnavailable: false,
  earlierRecordsPruned: false,
}

let requestOrdinal = 0

function newRequestId(): string {
  requestOrdinal += 1
  return `schedule-${Date.now().toString(36)}-${requestOrdinal.toString(36)}`
}

function scheduleKey(record: Pick<ScheduleCatalogEntry, 'sessionId' | 'id'>): string {
  return `${record.sessionId}\u0000${record.id}`
}

function clockTime(value: string): string {
  return /^\d\d:\d\d$/u.test(value) ? `${value}:00` : value
}

function timeParts(instant: string): { readonly date: string; readonly time: string } {
  const value = new Date(instant)
  if (Number.isNaN(value.getTime())) return { date: '', time: '' }
  return {
    date: value.toISOString().slice(0, 10),
    time: value.toISOString().slice(11, 23),
  }
}

function initialDraft(record: ScheduleCatalogEntry): EditDraft {
  const parts = timeParts(record.scheduledAt)
  return {
    title: record.title,
    prompt: record.prompt,
    timing: 'keep',
    date: parts.date,
    time: 'time' in record ? record.time : parts.time,
    timeZone: 'timeZone' in record ? record.timeZone : 'UTC',
    seconds: 'everySeconds' in record ? String(record.everySeconds) : '60',
    weekdays: record.kind === 'weekly' ? [...record.weekdays] : [1],
    expression: record.kind === 'cron' ? record.expression : '0 9 * * 1',
  }
}

function expectedFeatureRecord(record: ScheduleRecord): ScheduleUpdateFeaturePayload['expected'] {
  const common = {
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    scheduledAt: record.scheduledAt,
  }
  switch (record.kind) {
    case 'at':
      return { ...common, kind: 'at' }
    case 'after':
      return { ...common, kind: 'after', afterSeconds: record.afterSeconds }
    case 'every':
      return { ...common, kind: 'every', everySeconds: record.everySeconds }
    case 'daily':
      return { ...common, kind: 'daily', time: record.time, timeZone: record.timeZone }
    case 'weekly':
      return {
        ...common,
        kind: 'weekly',
        time: record.time,
        timeZone: record.timeZone,
        weekdays: [...record.weekdays],
      }
    case 'cron':
      return { ...common, kind: 'cron', expression: record.expression, timeZone: record.timeZone }
  }
}

function timingChange(draft: EditDraft): ScheduleTimingChange | undefined {
  switch (draft.timing) {
    case 'keep':
      return undefined
    case 'at': {
      const at: ScheduleAtInput = { date: draft.date, time: clockTime(draft.time), timeZone: draft.timeZone }
      const value: ScheduleAtValue = at
      return { kind: 'at', at: value }
    }
    case 'every':
      return { kind: 'every', seconds: Number(draft.seconds) }
    case 'daily':
      return { kind: 'daily', time: clockTime(draft.time), timeZone: draft.timeZone }
    case 'weekly':
      return {
        kind: 'weekly',
        time: clockTime(draft.time),
        timeZone: draft.timeZone,
        weekdays: [...draft.weekdays].sort((left, right) => left - right),
      }
    case 'cron':
      return { kind: 'cron', expression: draft.expression, timeZone: draft.timeZone }
  }
}

function featureTimingChange(
  change: ScheduleTimingChange,
): NonNullable<ScheduleUpdateFeaturePayload['change']> {
  return change.kind === 'weekly' ? { ...change, weekdays: [...change.weekdays] } : change
}

function isHistoryPage(
  value: ScheduleHistoryResult,
): value is Extract<ScheduleHistoryResult, { readonly records: readonly unknown[] }> {
  return 'records' in value
}

function updateResultError(result: ScheduleUpdateResult): string | undefined {
  if ('message' in result) return `schedules.error.${result.code}`
  if ('record' in result) return undefined
  return `schedules.error.${result.code}`
}

function historyLoading(current: HistoryView, reset: boolean): HistoryView {
  return {
    status: 'loading',
    records: current.records,
    earlierRecordsUnavailable: current.earlierRecordsUnavailable,
    earlierRecordsPruned: current.earlierRecordsPruned,
    ...(current.retention === undefined ? {} : { retention: current.retention }),
    ...(reset || current.nextBefore === undefined ? {} : { nextBefore: current.nextBefore }),
  }
}

function deleteResultError(result: ScheduleDeleteResult): string | undefined {
  if ('message' in result) return `schedules.error.${result.code}`
  return result.deleted ? undefined : 'schedules.error.schedule_not_found'
}

function formatRule(record: ScheduleRecord, t: ReturnType<typeof useI18n>['t']): string {
  switch (record.kind) {
    case 'at':
      return `${t('schedules.kind.at')} · ${record.scheduledAt}`
    case 'after':
      return `${t('schedules.kind.after')} · ${record.afterSeconds} ${t('schedules.unit.seconds')}`
    case 'every':
      return `${t('schedules.kind.every')} · ${record.everySeconds} ${t('schedules.unit.seconds')}`
    case 'daily':
      return `${t('schedules.kind.daily')} · ${record.time} · ${record.timeZone}`
    case 'weekly':
      return `${t('schedules.kind.weekly')} · ${record.weekdays.map((day) => t(`schedules.weekday.${day}`)).join(', ')} · ${record.time} · ${record.timeZone}`
    case 'cron':
      return `${t('schedules.kind.cron')} · ${record.expression} · ${record.timeZone}`
  }
}

/** Cross-session view and management for the Host Schedule catalog. */
export function SchedulePanel(props: SchedulePanelProps): ReactElement {
  const { t } = useI18n()
  const subscribeFeature = props.subscribeFeature
  const labelId = useId()
  const featureRequestRef = useRef(props.featureRequest)

  const [records, setRecords] = useState<readonly ScheduleCatalogEntry[]>([])
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [catalogSettled, setCatalogSettled] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  const [tab, setTab] = useState<DetailTab>('rule')
  const [draft, setDraft] = useState<EditDraft>()
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [operationError, setOperationError] = useState<string>()
  const [operationNotice, setOperationNotice] = useState<string>()
  const [sessionStarting, setSessionStarting] = useState(false)
  const [sessionStartFailed, setSessionStartFailed] = useState(false)
  const [history, setHistory] = useState<HistoryView>(EMPTY_HISTORY)
  const pendingRequestIds = useRef(new Set<string>())
  const catalogGeneration = useRef(0)
  const historyGeneration = useRef(0)
  const currentCatalogRequest = useRef<string | undefined>(undefined)
  const currentHistoryRequest = useRef<string | undefined>(undefined)
  const selectedKeyRef = useRef(selectedKey)
  const selectedRecordRef = useRef<ScheduleCatalogEntry | undefined>(undefined)
  const tabRef = useRef<DetailTab>('rule')
  const tabButtonsRef = useRef<Record<DetailTab, HTMLButtonElement | null>>({ rule: null, history: null })
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null)
  const listHeadingRef = useRef<HTMLHeadingElement>(null)
  const mounted = useRef(false)
  const previousSelectedKey = useRef(selectedKey)

  const setActiveTab = (nextTab: DetailTab): void => {
    tabRef.current = nextTab
    setTab(nextTab)
  }

  const cancelRequest = (targetRequestId: string): void => {
    const request = {
      type: 'feature.request.cancel' as const,
      requestId: newRequestId(),
      payload: { targetRequestId },
    }
    void featureRequestRef.current(request).catch(() => undefined)
  }

  const send = <T,>(request: FeatureRequest): Promise<T> => {
    pendingRequestIds.current.add(request.requestId)
    return featureRequestRef.current<T>(request).finally(() => {
      pendingRequestIds.current.delete(request.requestId)
    })
  }

  const refreshCatalog = (): void => {
    const generation = ++catalogGeneration.current
    if (currentCatalogRequest.current !== undefined) cancelRequest(currentCatalogRequest.current)
    const requestId = newRequestId()
    currentCatalogRequest.current = requestId
    setCatalogStatus('loading')
    void send<CatalogPayload>({ type: 'schedule.catalog', requestId, payload: {} })
      .then((payload) => {
        if (!mounted.current || generation !== catalogGeneration.current) return
        if (payload.kind !== 'schedule.catalog') throw new Error('malformed-catalog')
        if (selectedKeyRef.current !== undefined) {
          const refreshedSelection = payload.items.find(
            (record) => scheduleKey(record) === selectedKeyRef.current,
          )
          if (refreshedSelection === undefined) {
            selectedKeyRef.current = undefined
            selectedRecordRef.current = undefined
            setSelectedKey(undefined)
          } else selectedRecordRef.current = refreshedSelection
        }
        setRecords(payload.items)
        setCatalogSettled(true)
        setCatalogStatus('ready')
      })
      .catch(() => {
        if (!mounted.current || generation !== catalogGeneration.current) return
        setCatalogStatus('error')
      })
      .finally(() => {
        if (currentCatalogRequest.current === requestId) currentCatalogRequest.current = undefined
      })
  }

  const loadHistory = (record: ScheduleCatalogEntry, before?: string, reset = false): void => {
    const generation = reset ? ++historyGeneration.current : historyGeneration.current
    if (currentHistoryRequest.current !== undefined) cancelRequest(currentHistoryRequest.current)
    const requestId = newRequestId()
    currentHistoryRequest.current = requestId
    setHistory((current) => historyLoading(current, reset))
    void send<HistoryPayload>({
      type: 'schedule.history',
      requestId,
      payload: {
        sessionId: record.sessionId,
        id: record.id,
        limit: 20,
        ...(before === undefined ? {} : { before }),
      },
    })
      .then((payload) => {
        if (
          !mounted.current ||
          generation !== historyGeneration.current ||
          selectedKeyRef.current !== scheduleKey(record)
        )
          return
        if (payload.kind !== 'schedule.history') throw new Error('malformed-history')
        const result = payload.result
        if (!isHistoryPage(result)) {
          setHistory((current) => ({
            status: 'error',
            records: current.records,
            earlierRecordsUnavailable: current.earlierRecordsUnavailable,
            earlierRecordsPruned: current.earlierRecordsPruned,
            ...(current.retention === undefined ? {} : { retention: current.retention }),
            error: result.code,
          }))
          return
        }
        setHistory((current) => ({
          status: 'ready',
          records: reset
            ? result.records
            : [
                ...current.records,
                ...result.records.filter(
                  (item) => !current.records.some((old) => old.messageId === item.messageId),
                ),
              ],
          earlierRecordsUnavailable: result.earlierRecordsUnavailable,
          earlierRecordsPruned: result.earlierRecordsPruned,
          retention: result.retention,
          ...(result.nextBefore === undefined ? {} : { nextBefore: result.nextBefore }),
        }))
      })
      .catch(() => {
        if (
          !mounted.current ||
          generation !== historyGeneration.current ||
          selectedKeyRef.current !== scheduleKey(record)
        )
          return
        setHistory((current) => ({ ...current, status: 'error', error: 'request_failed' }))
      })
      .finally(() => {
        if (currentHistoryRequest.current === requestId) currentHistoryRequest.current = undefined
      })
  }

  const reloadRef = useRef(refreshCatalog)
  const reloadHistoryRef = useRef<(record: ScheduleCatalogEntry) => void>(() => undefined)

  useEffect(() => {
    featureRequestRef.current = props.featureRequest
  }, [props.featureRequest])

  useEffect(() => {
    reloadRef.current = refreshCatalog
    reloadHistoryRef.current = (record) => loadHistory(record, undefined, true)
  })

  useEffect(() => {
    mounted.current = true
    const pendingRequests = pendingRequestIds.current
    void Promise.resolve().then(() => reloadRef.current())
    const dispose = subscribeFeature((message) => {
      if (message.type !== 'feature.event' || message.name !== 'schedule.invalidated') return
      reloadRef.current()
      const selected = selectedRecordRef.current
      if (tabRef.current === 'history' && selected !== undefined) reloadHistoryRef.current(selected)
    })
    return () => {
      mounted.current = false
      catalogGeneration.current += 1
      historyGeneration.current += 1
      for (const requestId of pendingRequests) cancelRequest(requestId)
      pendingRequests.clear()
      dispose()
    }
  }, [subscribeFeature])

  useEffect(() => {
    if (previousSelectedKey.current !== undefined && selectedKey === undefined) {
      const target = rowTriggerRef.current
      if (target !== null && target.isConnected) target.focus()
      else listHeadingRef.current?.focus()
      rowTriggerRef.current = null
    }
    previousSelectedKey.current = selectedKey
  }, [selectedKey])

  const visibleRecords = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return records.filter((record) => {
      if (statusFilter !== 'all' && record.status !== statusFilter) return false
      if (query === '') return true
      return [record.id, record.title, record.prompt, record.sessionId, formatRule(record, t)].some((value) =>
        value.toLocaleLowerCase().includes(query),
      )
    })
  }, [records, search, statusFilter, t])

  const selected = records.find((record) => scheduleKey(record) === selectedKey)

  const resetSelectedDetails = (): void => {
    setActiveTab('rule')
    setDraft(undefined)
    setEditing(false)
    setConfirmDelete(false)
    setOperationError(undefined)
    setOperationNotice(undefined)
    setHistory(EMPTY_HISTORY)
    historyGeneration.current += 1
    if (currentHistoryRequest.current !== undefined) {
      cancelRequest(currentHistoryRequest.current)
      currentHistoryRequest.current = undefined
    }
  }

  const selectRecord = (record: ScheduleCatalogEntry, trigger: HTMLButtonElement): void => {
    rowTriggerRef.current = trigger
    const key = scheduleKey(record)
    if (selectedKeyRef.current !== key) resetSelectedDetails()
    selectedKeyRef.current = key
    selectedRecordRef.current = record
    setSelectedKey(key)
  }

  const closeDetails = (): void => {
    selectedKeyRef.current = undefined
    selectedRecordRef.current = undefined
    resetSelectedDetails()
    setSelectedKey(undefined)
  }

  const startScheduleSession = (): void => {
    if (sessionStarting) return
    setSessionStarting(true)
    setSessionStartFailed(false)
    void Promise.resolve()
      .then(() => props.onStartScheduleSession())
      .catch(() => setSessionStartFailed(true))
      .finally(() => setSessionStarting(false))
  }

  const beginEdit = (): void => {
    if (selected === undefined || selected.status !== 'active') return
    setOperationError(undefined)
    setOperationNotice(undefined)
    setDraft(initialDraft(selected))
    setEditing(true)
  }

  const submitEdit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (selected === undefined || draft === undefined || busy || selected.status !== 'active') return
    const change = timingChange(draft)
    const update: ScheduleUpdateFeaturePayload = {
      sessionId: selected.sessionId,
      id: selected.id,
      expected: expectedFeatureRecord(selected),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      ...(change === undefined ? {} : { change: featureTimingChange(change) }),
    }
    setBusy(true)
    setOperationError(undefined)
    setOperationNotice(undefined)
    const requestId = newRequestId()
    void send<UpdatePayload>({ type: 'schedule.update', requestId, payload: update })
      .then((payload) => {
        if (!mounted.current) return
        if (payload.kind !== 'schedule.updated') throw new Error('malformed-update')
        const errorKey = updateResultError(payload.result)
        if (errorKey !== undefined) {
          setOperationError(errorKey)
          setEditing(false)
          refreshCatalog()
          return
        }
        setOperationNotice('schedules.update.success')
        setEditing(false)
        setDraft(undefined)
        refreshCatalog()
      })
      .catch(() => {
        if (mounted.current) setOperationError('schedules.update.failed')
      })
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
  }

  const deleteSelected = (): void => {
    if (selected === undefined || busy) return
    setBusy(true)
    setOperationError(undefined)
    const requestId = newRequestId()
    void send<DeletePayload>({
      type: 'schedule.delete',
      requestId,
      payload: { sessionId: selected.sessionId, id: selected.id },
    })
      .then((payload) => {
        if (!mounted.current) return
        if (payload.kind !== 'schedule.deleted') throw new Error('malformed-delete')
        const errorKey = deleteResultError(payload.result)
        if (errorKey !== undefined) {
          setOperationError(errorKey)
          setConfirmDelete(false)
          refreshCatalog()
          return
        }
        setConfirmDelete(false)
        refreshCatalog()
        rowTriggerRef.current = null
        closeDetails()
      })
      .catch(() => {
        if (mounted.current) setOperationError('schedules.delete.failed')
      })
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
  }

  const openHistory = (): void => {
    if (selected === undefined) return
    setActiveTab('history')
    loadHistory(selected, undefined, true)
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = tabRef.current === 'rule' ? 0 : 1
    let nextTab: DetailTab | undefined
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft':
        nextTab = currentIndex === 0 ? 'history' : 'rule'
        break
      case 'Home':
        nextTab = 'rule'
        break
      case 'End':
        nextTab = 'history'
        break
      default:
        return
    }
    event.preventDefault()
    if (nextTab === 'history') openHistory()
    else setActiveTab('rule')
    tabButtonsRef.current[nextTab]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || selectedKey === undefined || busy) return
    event.preventDefault()
    event.stopPropagation()
    if (confirmDelete) {
      setConfirmDelete(false)
      return
    }
    closeDetails()
  }

  return (
    <section className="dsh-schedule-panel" aria-labelledby={`${labelId}-title`} onKeyDown={onKeyDown}>
      <div
        className={`dsh-schedule-panel__catalog${selected === undefined ? '' : ' dsh-schedule-panel__catalog--detail'}`}
      >
        <header className="dsh-schedule-panel__heading">
          <div>
            <h1 id={`${labelId}-title`} ref={listHeadingRef} tabIndex={-1}>
              {t('schedules.title')}
            </h1>
            <p>{t('schedules.createViaChat')}</p>
          </div>
          <div className="dsh-schedule-panel__heading-actions">
            <button
              type="button"
              className="dsh-schedule-panel__new"
              aria-busy={sessionStarting}
              disabled={sessionStarting}
              onClick={startScheduleSession}
            >
              {sessionStarting ? t('schedules.working') : t('schedules.new')}
            </button>
            <button
              type="button"
              className="dsh-schedule-panel__icon-button"
              aria-label={t('schedules.refresh')}
              title={t('schedules.refresh')}
              disabled={catalogStatus === 'loading'}
              onClick={refreshCatalog}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </header>

        {sessionStartFailed ? (
          <p className="dsh-schedule-panel__error" role="alert">
            {t('schedules.createSessionFailed')}
          </p>
        ) : null}

        <div className="dsh-schedule-panel__controls">
          <label className="dsh-schedule-panel__search">
            <span className="dsh-schedule-panel__visually-hidden">{t('schedules.search.label')}</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={search}
              placeholder={t('schedules.search.placeholder')}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="dsh-schedule-panel__filters" role="group" aria-label={t('schedules.filter.label')}>
            {(['all', 'active', 'inactive'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={statusFilter === filter}
                onClick={() => setStatusFilter(filter)}
              >
                {t(`schedules.filter.${filter}`)}
              </button>
            ))}
          </div>
        </div>

        <p className="dsh-schedule-panel__count" role="status" aria-live="polite">
          {t('schedules.count', { visible: visibleRecords.length, total: records.length })}
        </p>

        {catalogStatus === 'error' ? (
          <div className="dsh-schedule-panel__notice" role={catalogSettled ? 'status' : 'alert'}>
            <span>{catalogSettled ? t('schedules.stale') : t('schedules.loadFailed')}</span>
            <button type="button" onClick={refreshCatalog}>
              {t('schedules.retry')}
            </button>
          </div>
        ) : null}
        {catalogStatus === 'loading' && !catalogSettled ? (
          <p className="dsh-schedule-panel__empty" role="status">
            {t('schedules.loading')}
          </p>
        ) : null}
        {catalogStatus === 'ready' && records.length === 0 ? (
          <p className="dsh-schedule-panel__empty">{t('schedules.empty')}</p>
        ) : null}
        {catalogStatus === 'ready' && records.length > 0 && visibleRecords.length === 0 ? (
          <p className="dsh-schedule-panel__empty">{t('schedules.noMatches')}</p>
        ) : null}

        {visibleRecords.length > 0 ? (
          <ul
            className="dsh-schedule-panel__rows"
            aria-label={t('schedules.list.label')}
            aria-busy={catalogStatus === 'loading'}
          >
            {visibleRecords.map((record) => {
              const key = scheduleKey(record)
              const isSelected = selectedKey === key
              return (
                <li key={key}>
                  <button
                    className="dsh-schedule-panel__row"
                    type="button"
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? `${labelId}-detail` : undefined}
                    aria-describedby={`${labelId}-meta-${encodeURIComponent(record.id)}`}
                    onClick={(event) => selectRecord(record, event.currentTarget)}
                  >
                    <span className="dsh-schedule-panel__row-title">{record.title}</span>
                    <span
                      className="dsh-schedule-panel__row-meta"
                      id={`${labelId}-meta-${encodeURIComponent(record.id)}`}
                    >
                      <span
                        className={`dsh-schedule-panel__status dsh-schedule-panel__status--${record.status}`}
                      >
                        {t(`schedules.status.${record.status}`)}
                      </span>
                      <span>{formatRule(record, t)}</span>
                      {record.status === 'active' ? (
                        <time dateTime={record.scheduledAt}>
                          {t('schedules.next', { time: new Date(record.scheduledAt).toLocaleString() })}
                        </time>
                      ) : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>

      {selected !== undefined ? (
        <aside
          className="dsh-schedule-panel__detail"
          id={`${labelId}-detail`}
          aria-label={t('schedules.detail.label')}
        >
          <div className="dsh-schedule-panel__detail-heading">
            <div>
              <p className="dsh-schedule-panel__eyebrow">
                {t('schedules.session', { id: selected.sessionId })}
              </p>
              <h2>{selected.title}</h2>
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

          <div
            id={`${labelId}-panel-rule`}
            role="tabpanel"
            aria-labelledby={`${labelId}-tab-rule`}
            tabIndex={0}
            hidden={tab !== 'rule'}
          >
            {editing && draft !== undefined ? (
              <form className="dsh-schedule-panel__editor" onSubmit={submitEdit}>
                <label>
                  <span>{t('schedules.field.title')}</span>
                  <input
                    value={draft.title}
                    maxLength={120}
                    required
                    onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  />
                </label>
                <label>
                  <span>{t('schedules.field.prompt')}</span>
                  <textarea
                    value={draft.prompt}
                    required
                    rows={5}
                    onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                  />
                </label>
                <label>
                  <span>{t('schedules.field.timing')}</span>
                  <select
                    value={draft.timing}
                    onChange={(event) => setDraft({ ...draft, timing: event.target.value as TimingChoice })}
                  >
                    <option value="keep">{t('schedules.timing.keep')}</option>
                    <option value="at">{t('schedules.kind.at')}</option>
                    <option value="every">{t('schedules.kind.every')}</option>
                    <option value="daily">{t('schedules.kind.daily')}</option>
                    <option value="weekly">{t('schedules.kind.weekly')}</option>
                    <option value="cron">{t('schedules.kind.cron')}</option>
                  </select>
                </label>
                {draft.timing === 'at' ? (
                  <div className="dsh-schedule-panel__timing-fields">
                    <label>
                      <span>{t('schedules.field.date')}</span>
                      <input
                        type="date"
                        required
                        value={draft.date}
                        onChange={(event) => setDraft({ ...draft, date: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{t('schedules.field.time')}</span>
                      <input
                        type="time"
                        step="0.001"
                        required
                        value={draft.time}
                        onChange={(event) => setDraft({ ...draft, time: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{t('schedules.field.timeZone')}</span>
                      <input
                        required
                        value={draft.timeZone}
                        onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
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
                      onChange={(event) => setDraft({ ...draft, seconds: event.target.value })}
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
                        onChange={(event) => setDraft({ ...draft, time: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{t('schedules.field.timeZone')}</span>
                      <input
                        required
                        value={draft.timeZone}
                        onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
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
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  weekdays: event.target.checked
                                    ? [...draft.weekdays, day]
                                    : draft.weekdays.filter((value) => value !== day),
                                })
                              }
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
                        onChange={(event) => setDraft({ ...draft, expression: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{t('schedules.field.timeZone')}</span>
                      <input
                        required
                        value={draft.timeZone}
                        onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
                      />
                    </label>
                  </div>
                ) : null}
                <div className="dsh-schedule-panel__actions">
                  <button
                    type="submit"
                    className="dsh-schedule-panel__primary"
                    disabled={
                      busy ||
                      draft.title.trim() === '' ||
                      draft.title.trim().length > 120 ||
                      draft.prompt.trim() === '' ||
                      (draft.timing === 'weekly' && draft.weekdays.length === 0)
                    }
                  >
                    {busy ? t('schedules.working') : t('schedules.save')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false)
                      setDraft(undefined)
                      setOperationError(undefined)
                    }}
                  >
                    {t('schedules.cancel')}
                  </button>
                </div>
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
                        <time dateTime={selected.lastDelivery.deliveredAt}>
                          {new Date(selected.lastDelivery.deliveredAt).toLocaleString()}
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
                    disabled={busy || selected.status !== 'active'}
                    onClick={beginEdit}
                  >
                    {t('schedules.edit')}
                  </button>
                  <button
                    type="button"
                    className="dsh-schedule-panel__danger"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t('schedules.delete')}
                  </button>
                </div>
                {confirmDelete ? (
                  <div
                    className="dsh-schedule-panel__confirm"
                    role="alertdialog"
                    aria-label={t('schedules.delete.confirmTitle')}
                    aria-describedby={`${labelId}-delete-copy`}
                  >
                    <p id={`${labelId}-delete-copy`}>
                      {t('schedules.delete.confirm', { title: selected.title })}
                    </p>
                    <div className="dsh-schedule-panel__actions">
                      <button
                        type="button"
                        className="dsh-schedule-panel__danger"
                        disabled={busy}
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
                  {t('schedules.retry')}
                </button>
              </div>
            ) : null}
            {history.status === 'ready' && history.records.length === 0 ? (
              <p>{t('schedules.history.empty')}</p>
            ) : null}
            {history.status === 'ready' && history.retention !== undefined ? (
              <p className="dsh-schedule-panel__muted">
                {t('schedules.history.retention', history.retention)}
              </p>
            ) : null}
            {history.earlierRecordsUnavailable ? (
              <p className="dsh-schedule-panel__muted">{t('schedules.history.unavailable')}</p>
            ) : null}
            {history.earlierRecordsPruned ? (
              <p className="dsh-schedule-panel__muted">{t('schedules.history.pruned')}</p>
            ) : null}
            <ol className="dsh-schedule-panel__deliveries">
              {history.records.map((delivery) => (
                <li key={delivery.messageId}>
                  <time dateTime={delivery.deliveredAt}>
                    {new Date(delivery.deliveredAt).toLocaleString()}
                  </time>
                  <span>
                    {t('schedules.history.scheduledFor', {
                      time: new Date(delivery.scheduledAt).toLocaleString(),
                    })}
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
          </section>
        </aside>
      ) : null}
    </section>
  )
}
