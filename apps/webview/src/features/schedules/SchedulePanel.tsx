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
  ScheduleCatalogEntry,
  ScheduleCreateTiming,
  ScheduleRunResult,
  SCHEDULE_INPUT_ERROR_CODES,
} from '@dsh-vscode/domain'
import type { FeatureHostEvent, FeatureRequest } from '@dsh-vscode/webview-protocol'

import { useI18n } from '../../i18n.js'
import type { ScheduleSessionLink } from './session-link.js'
import { ScheduleCreateForm } from './ScheduleCreateForm.js'
import { ScheduleDetail } from './ScheduleDetail.js'
import {
  EMPTY_HISTORY,
  createArguments,
  createValidation,
  deleteResultError,
  expectedFeatureRecord,
  featureTimingChange,
  formatRule,
  historyLoading,
  initialCreateDraft,
  initialDraft,
  isCapabilityUnavailable,
  isHistoryPage,
  isScheduleCreateIndeterminate,
  newRequestId,
  sameEditDraft,
  scheduleCreatePrompt,
  scheduleKey,
  scheduleMatchesCreate,
  timingChange,
  updateResultError,
  wallClockInstant,
  type CatalogPayload,
  type CreateDraft,
  type CreateStatus,
  type DeletePayload,
  type DetailTab,
  type EditDraft,
  type EditState,
  type HistoryPayload,
  type HistoryView,
  type PendingCreate,
  type ScheduleUpdateFeaturePayload,
  type StatusFilter,
  type UpdatePayload,
} from './schedule-model.js'
import './schedule-panel.css'

export interface SchedulePanelProps {
  readonly featureRequest: <T>(request: FeatureRequest) => Promise<T>
  readonly subscribeFeature: (listener: (message: FeatureHostEvent) => void) => () => void
  /** Creates a Session, sends the first prompt, then resolves at that Session turn's terminal event. */
  readonly onStartScheduleSession: (prompt: string) => Promise<string>
  readonly getLinkedSession: (sessionId: string) => ScheduleSessionLink
  readonly onOpenLinkedSession: (sessionId: string) => void
  readonly connectionEpoch: number
}

export function SchedulePanel(props: SchedulePanelProps): ReactElement {
  const { t, locale } = useI18n()
  const subscribeFeature = props.subscribeFeature
  const labelId = useId()
  const featureRequestRef = useRef(props.featureRequest)

  const [records, setRecords] = useState<readonly ScheduleCatalogEntry[]>([])
  const [nativeManagement, setNativeManagement] = useState(false)
  const [workspaceChoices, setWorkspaceChoices] = useState<readonly { id: string; name: string }[]>([])
  const [creationWorkspaceId, setCreationWorkspaceId] = useState('')
  const [targetMode, setTargetMode] = useState<'new_once' | 'new'>('new_once')
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading')
  const [catalogSettled, setCatalogSettled] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  const [selectedRecord, setSelectedRecord] = useState<ScheduleCatalogEntry | undefined>()
  const [tab, setTab] = useState<DetailTab>('rule')
  const [editState, setEditState] = useState<EditState>({ editing: false })
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  /** The delete confirmation is a destructive alertdialog: it takes the
   * keyboard on open and hands it back to the control that asked for it. */
  const confirmDeleteRef = useRef<HTMLDivElement>(null)
  const moreActionsTriggerRef = useRef<HTMLButtonElement>(null)
  const confirmWasOpen = useRef(false)
  useEffect(() => {
    if (confirmDelete && !confirmWasOpen.current) confirmDeleteRef.current?.focus()
    if (confirmWasOpen.current && !confirmDelete) {
      const target = moreActionsTriggerRef.current
      if (target !== null && target.isConnected) target.focus()
    }
    confirmWasOpen.current = confirmDelete
  }, [confirmDelete])
  const [busy, setBusy] = useState(false)
  const [operationError, setOperationError] = useState<string>()
  const [operationNotice, setOperationNotice] = useState<string>()
  const [showRetentionDetails, setShowRetentionDetails] = useState(false)
  const [sessionStarting, setSessionStarting] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createDraft, setCreateDraft] = useState<CreateDraft>(initialCreateDraft)
  const [createStatus, setCreateStatus] = useState<CreateStatus>('idle')
  const [createError, setCreateError] = useState<string>()
  const [confirmedCreate, setConfirmedCreate] = useState<ScheduleCatalogEntry>()
  const [history, setHistory] = useState<HistoryView>(EMPTY_HISTORY)
  const { draft, editing } = editState
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
  const observedConnectionEpoch = useRef(props.connectionEpoch)
  const mounted = useRef(false)
  const previousSelectedKey = useRef(selectedKey)
  const pendingCreate = useRef<PendingCreate | undefined>(undefined)
  const checkingCreateCatalog = useRef(false)

  const rememberSelectedRecord = (record: ScheduleCatalogEntry | undefined): void => {
    selectedRecordRef.current = record
    setSelectedRecord(record)
  }

  const updateEditDraft = (update: (current: EditDraft) => EditDraft): void => {
    setEditState((current) =>
      current.draft === undefined ? current : { ...current, draft: update(current.draft) },
    )
  }

  const patchEditDraft = (patch: Partial<EditDraft>): void => {
    setEditState((current) =>
      current.draft === undefined ? current : { ...current, draft: { ...current.draft, ...patch } },
    )
  }

  const setActiveTab = (nextTab: DetailTab): void => {
    if (tabRef.current === 'history' && nextTab !== 'history') {
      historyGeneration.current += 1
      if (currentHistoryRequest.current !== undefined) {
        cancelRequest(currentHistoryRequest.current)
        currentHistoryRequest.current = undefined
      }
    }
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
        setNativeManagement(payload.management === 'host')
        setWorkspaceChoices(payload.workspaces ?? [])
        setCreationWorkspaceId((current) =>
          payload.workspaces?.some((item) => item.id === current) === true
            ? current
            : (payload.workspaces?.[0]?.id ?? ''),
        )
        if (selectedKeyRef.current !== undefined) {
          const refreshedSelection = payload.items.find(
            (record) => scheduleKey(record) === selectedKeyRef.current,
          )
          if (refreshedSelection !== undefined) {
            rememberSelectedRecord(refreshedSelection)
            const key = scheduleKey(refreshedSelection)
            setEditState((current) => {
              const baseline = current.baseline
              if (!current.editing || current.draft === undefined || baseline?.key !== key) return current
              const nextBaseline = initialDraft(refreshedSelection)
              if (
                refreshedSelection.target !== undefined &&
                baseline.revision !== undefined &&
                !sameEditDraft(current.draft, baseline.draft)
              )
                return current
              return {
                ...current,
                draft: sameEditDraft(current.draft, baseline.draft) ? nextBaseline : current.draft,
                baseline: {
                  key,
                  draft: nextBaseline,
                  ...(refreshedSelection.target === undefined
                    ? {}
                    : { revision: refreshedSelection.updatedAt ?? null }),
                },
              }
            })
          }
        }
        setRecords(payload.items)
        const pending = pendingCreate.current
        const created =
          pending === undefined
            ? undefined
            : payload.items.find((record) => scheduleMatchesCreate(record, pending))
        if (created !== undefined) {
          pendingCreate.current = undefined
          checkingCreateCatalog.current = false
          setConfirmedCreate(created)
          setCreateStatus('confirmed')
          setCreateError(undefined)
          selectedKeyRef.current = scheduleKey(created)
          rememberSelectedRecord(created)
          setSelectedKey(scheduleKey(created))
        } else if (checkingCreateCatalog.current) {
          checkingCreateCatalog.current = false
          setCreateStatus('unconfirmed')
        }
        setCatalogSettled(true)
        setCatalogStatus('ready')
      })
      .catch((error: unknown) => {
        if (!mounted.current || generation !== catalogGeneration.current) return
        checkingCreateCatalog.current = false
        // A composition without the Schedule service answers every
        // `schedule/*` endpoint with 404. Retrying cannot help until that DSH
        // mounts the service, so it is a settled state, not a transient error.
        const unavailable = isCapabilityUnavailable(error)
        setCatalogStatus(unavailable ? 'unavailable' : 'error')
        if (unavailable) {
          // A bundle change can remove the service after we loaded its catalog.
          // Do not leave records or delivery history visible as if they were
          // still authoritative. Keep the selected key and edit draft so a
          // later re-enable can rehydrate the same record without discarding
          // user input.
          setRecords([])
          rememberSelectedRecord(undefined)
          historyGeneration.current += 1
          if (currentHistoryRequest.current !== undefined) cancelRequest(currentHistoryRequest.current)
          currentHistoryRequest.current = undefined
          setHistory(EMPTY_HISTORY)
        }
      })
      .finally(() => {
        if (currentCatalogRequest.current === requestId) currentCatalogRequest.current = undefined
      })
  }

  const loadHistory = (record: ScheduleCatalogEntry, before?: string, reset = false): void => {
    const generation = reset ? ++historyGeneration.current : historyGeneration.current
    if (reset) setShowRetentionDetails(false)
    if (currentHistoryRequest.current !== undefined) cancelRequest(currentHistoryRequest.current)
    const requestId = newRequestId()
    currentHistoryRequest.current = requestId
    setHistory((current) => historyLoading(current, reset))
    void send<HistoryPayload>({
      type: 'schedule.history',
      requestId,
      payload: {
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
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
      if (
        message.type !== 'feature.event' ||
        (message.name !== 'schedule.invalidated' && message.name !== 'plugin.manager.changed')
      )
        return
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
    if (observedConnectionEpoch.current === props.connectionEpoch) return
    observedConnectionEpoch.current = props.connectionEpoch
    setBusy(false)
    setSessionStarting(false)
    if (pendingCreate.current !== undefined) {
      pendingCreate.current = undefined
      setCreateStatus('unconfirmed')
      setCreateOpen(false)
    }
    reloadRef.current()
    const selected = selectedRecordRef.current
    if (tabRef.current === 'history' && selected !== undefined) reloadHistoryRef.current(selected)
  }, [props.connectionEpoch])

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
      if (statusFilter === 'active' && record.status !== 'active') return false
      if (statusFilter === 'inactive' && record.status === 'active') return false
      if (query === '') return true
      return [record.id, record.title, record.prompt, record.sessionId, formatRule(record, t)].some((value) =>
        (value ?? '').toLocaleLowerCase().includes(query),
      )
    })
  }, [records, search, statusFilter, t])

  const selectedFromCatalog = records.find((record) => scheduleKey(record) === selectedKey)
  const selected =
    selectedFromCatalog ??
    (selectedKey !== undefined && selectedRecord !== undefined && scheduleKey(selectedRecord) === selectedKey
      ? selectedRecord
      : undefined)
  const selectedInCatalog = selectedFromCatalog !== undefined
  const draftDirty =
    selected !== undefined &&
    draft !== undefined &&
    editState.baseline?.key === scheduleKey(selected) &&
    !sameEditDraft(draft, editState.baseline.draft)
  const selectedLinkedSessionId = selected?.sessionId ?? selected?.lastDelivery?.targetSessionId
  const selectedLinkedSession =
    selectedLinkedSessionId === undefined ? undefined : props.getLinkedSession(selectedLinkedSessionId)

  const resetSelectedDetails = (): void => {
    setActiveTab('rule')
    setEditState({ editing: false })
    setConfirmDelete(false)
    setMoreActionsOpen(false)
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
    rememberSelectedRecord(record)
    setSelectedKey(key)
  }

  const closeDetails = (): void => {
    selectedKeyRef.current = undefined
    rememberSelectedRecord(undefined)
    resetSelectedDetails()
    setSelectedKey(undefined)
  }

  const startScheduleSession = (): void => {
    setCreateDraft(initialCreateDraft())
    setCreateError(undefined)
    setConfirmedCreate(undefined)
    setCreateStatus('idle')
    setCreateOpen(true)
  }

  const submitCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (sessionStarting || !createOpen) return
    const validation = createValidation(createDraft)
    if (validation !== undefined) {
      setCreateError(validation)
      return
    }
    if (catalogStatus !== 'ready' || !catalogSettled) {
      setCreateError('schedules.create.validation.catalog')
      return
    }
    const args = createArguments(createDraft)
    if (nativeManagement && !workspaceChoices.some((item) => item.id === creationWorkspaceId)) {
      setCreateError('schedules.create.validation.workspace')
      return
    }
    const expectedAt =
      'at' in args
        ? wallClockInstant(args.at.date, args.at.time, args.at.time_zone)?.toISOString()
        : undefined
    const baselineKeys = new Set(records.map(scheduleKey))
    setCreateError(undefined)
    setCreateStatus('sending')
    setSessionStarting(true)
    if (nativeManagement) {
      const requestEpoch = observedConnectionEpoch.current
      const timing: ScheduleCreateTiming =
        'rrule' in args
          ? { kind: 'rrule', rrule: args.rrule }
          : 'after_seconds' in args
            ? { kind: 'after', seconds: args.after_seconds }
            : 'at' in args
              ? { kind: 'at', at: { date: args.at.date, time: args.at.time, timeZone: args.at.time_zone } }
              : 'every_seconds' in args
                ? { kind: 'every', seconds: args.every_seconds }
                : 'daily' in args
                  ? { kind: 'daily', time: args.daily.time, timeZone: args.daily.time_zone }
                  : 'weekly' in args
                    ? {
                        kind: 'weekly',
                        time: args.weekly.time,
                        timeZone: args.weekly.time_zone,
                        weekdays: args.weekly.weekdays,
                      }
                    : { kind: 'cron', expression: args.cron.expression, timeZone: args.cron.time_zone }
      pendingCreate.current = {
        sessionId: '',
        baselineKeys,
        args,
        workspaceId: creationWorkspaceId,
        targetMode,
        ...(expectedAt === undefined ? {} : { expectedAt }),
      }
      void send<
        | { kind: 'schedule.created'; item: ScheduleCatalogEntry }
        | { kind: 'schedule.create.refused'; reason: (typeof SCHEDULE_INPUT_ERROR_CODES)[number] }
      >({
        type: 'schedule.create',
        requestId: newRequestId(),
        payload: {
          workspaceId: creationWorkspaceId,
          title: args.title,
          prompt: args.prompt,
          targetMode,
          timing: timing.kind === 'weekly' ? { ...timing, weekdays: [...timing.weekdays] } : timing,
        },
      })
        .then((payload) => {
          if (!mounted.current || observedConnectionEpoch.current !== requestEpoch) return
          if (payload.kind === 'schedule.create.refused') {
            pendingCreate.current = undefined
            setCreateStatus('failed')
            setCreateError(`schedules.error.${payload.reason}`)
            setCreateOpen(true)
            return
          }
          if (payload.kind !== 'schedule.created') throw new Error('malformed-create')
          pendingCreate.current = undefined
          setConfirmedCreate(payload.item)
          setCreateStatus('confirmed')
          setCreateOpen(false)
          refreshCatalog()
        })
        .catch((reason: unknown) => {
          if (!mounted.current || observedConnectionEpoch.current !== requestEpoch) return
          const code =
            typeof reason === 'object' && reason !== null ? (reason as { code?: unknown }).code : undefined
          if (
            typeof code === 'string' &&
            [
              'INVALID_CONFIGURATION',
              'PERMISSION_DENIED',
              'RESOURCE_NOT_OWNED',
              'CAPABILITY_UNAVAILABLE',
            ].includes(code)
          ) {
            pendingCreate.current = undefined
            setCreateStatus('failed')
            setCreateError('schedules.create.nativeFailed')
            setCreateOpen(true)
            return
          }
          setCreateOpen(false)
          setCreateStatus('unconfirmed')
          checkingCreateCatalog.current = true
          refreshCatalog()
        })
        .finally(() => {
          if (mounted.current && observedConnectionEpoch.current === requestEpoch) setSessionStarting(false)
        })
      return
    }
    let keepCreateLocked = false
    void Promise.resolve()
      .then(() => props.onStartScheduleSession(scheduleCreatePrompt(args)))
      .then((sessionId) => {
        if (!mounted.current) return
        if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('missing-session-id')
        pendingCreate.current = {
          sessionId,
          baselineKeys,
          args,
          ...(expectedAt === undefined ? {} : { expectedAt }),
        }
        setCreateStatus('pending')
        setCreateOpen(false)
        // The callback resolves only after this Session's turn/end. Retry stays
        // hidden until this post-terminal catalog read confirms or clears it.
        checkingCreateCatalog.current = true
        refreshCatalog()
      })
      .catch((reason: unknown) => {
        if (!mounted.current) return
        if (isScheduleCreateIndeterminate(reason)) {
          keepCreateLocked = true
          setCreateOpen(false)
          setCreateStatus('sending')
          return
        }
        setCreateStatus('failed')
        setCreateError('schedules.create.failed')
        setCreateOpen(true)
      })
      .finally(() => {
        if (mounted.current && !keepCreateLocked) setSessionStarting(false)
      })
  }

  const checkCreateCatalog = (): void => {
    checkingCreateCatalog.current = true
    refreshCatalog()
  }

  const retryCreate = (): void => {
    setCreateError(undefined)
    setCreateStatus('unconfirmed')
    setCreateOpen(true)
  }

  const beginEdit = (): void => {
    if (
      selected === undefined ||
      (selected.status !== 'active' && selected.target === undefined) ||
      !selectedInCatalog ||
      catalogStatus !== 'ready'
    )
      return
    setOperationError(undefined)
    setOperationNotice(undefined)
    const initial = initialDraft(selected)
    setEditState({
      editing: true,
      draft: initial,
      baseline: {
        key: scheduleKey(selected),
        draft: initial,
        ...(selected.target === undefined ? {} : { revision: selected.updatedAt ?? null }),
      },
    })
  }

  const submitEdit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (
      selected === undefined ||
      draft === undefined ||
      busy ||
      (selected.status !== 'active' && selected.target === undefined) ||
      !selectedInCatalog ||
      catalogStatus !== 'ready'
    )
      return
    const operationKey = scheduleKey(selected)
    const requestEpoch = observedConnectionEpoch.current
    if (draft.timing === 'every') {
      const seconds = Number(draft.seconds)
      if (!Number.isSafeInteger(seconds) || seconds < 60) {
        setOperationError('schedules.update.validation.every')
        return
      }
    }
    const change = timingChange(draft)
    const update: ScheduleUpdateFeaturePayload = {
      ...(selected.sessionId === undefined ? {} : { sessionId: selected.sessionId }),
      id: selected.id,
      ...(selected.target === undefined ? {} : { expectedUpdatedAt: editState.baseline?.revision ?? null }),
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
        if (!mounted.current || observedConnectionEpoch.current !== requestEpoch) return
        if (payload.kind !== 'schedule.updated') throw new Error('malformed-update')
        const errorKey = updateResultError(payload.result)
        if (errorKey !== undefined) {
          if (selectedKeyRef.current === operationKey) setOperationError(errorKey)
          if (selected.target !== undefined && errorKey === 'schedules.error.schedule_conflict')
            setEditState((current) => {
              if (current.baseline === undefined) return current
              const baseline = { key: current.baseline.key, draft: current.baseline.draft }
              return { ...current, baseline }
            })
          refreshCatalog()
          return
        }
        if (selectedKeyRef.current === operationKey) {
          setOperationNotice('schedules.update.success')
          setEditState({ editing: false })
        }
        refreshCatalog()
      })
      .catch(() => {
        if (
          mounted.current &&
          observedConnectionEpoch.current === requestEpoch &&
          selectedKeyRef.current === operationKey
        )
          setOperationError('schedules.update.failed')
      })
      .finally(() => {
        if (mounted.current && observedConnectionEpoch.current === requestEpoch) setBusy(false)
      })
  }

  const deleteSelected = (): void => {
    if (selected === undefined || busy || !selectedInCatalog || catalogStatus !== 'ready') return
    const operationKey = scheduleKey(selected)
    const requestEpoch = observedConnectionEpoch.current
    setBusy(true)
    setOperationError(undefined)
    const requestId = newRequestId()
    void send<DeletePayload>({
      type: 'schedule.delete',
      requestId,
      payload: {
        ...(selected.sessionId === undefined ? {} : { sessionId: selected.sessionId }),
        id: selected.id,
        ...(selected.target === undefined ? {} : { expectedUpdatedAt: selected.updatedAt ?? null }),
      },
    })
      .then((payload) => {
        if (!mounted.current || observedConnectionEpoch.current !== requestEpoch) return
        if (payload.kind !== 'schedule.deleted') throw new Error('malformed-delete')
        const errorKey = deleteResultError(payload.result)
        if (errorKey !== undefined) {
          if (selectedKeyRef.current === operationKey) {
            setOperationError(errorKey)
            setConfirmDelete(false)
          }
          refreshCatalog()
          return
        }
        refreshCatalog()
        if (selectedKeyRef.current === operationKey) {
          setConfirmDelete(false)
          rowTriggerRef.current = null
          closeDetails()
        }
      })
      .catch(() => {
        if (
          mounted.current &&
          observedConnectionEpoch.current === requestEpoch &&
          selectedKeyRef.current === operationKey
        )
          setOperationError('schedules.delete.failed')
      })
      .finally(() => {
        if (mounted.current && observedConnectionEpoch.current === requestEpoch) setBusy(false)
      })
  }

  const runSelected = (): void => {
    if (selected === undefined || busy || !selectedInCatalog || catalogStatus !== 'ready') return
    const key = scheduleKey(selected)
    const requestEpoch = observedConnectionEpoch.current
    setBusy(true)
    setOperationError(undefined)
    void send<{ kind: 'schedule.ran'; result: ScheduleRunResult }>({
      type: 'schedule.run',
      requestId: newRequestId(),
      payload: { id: selected.id },
    })
      .then(({ result }) => {
        if (
          mounted.current &&
          observedConnectionEpoch.current === requestEpoch &&
          selectedKeyRef.current === key
        ) {
          if (!result.admitted) setOperationError(`schedules.error.${result.code}`)
          else setOperationNotice('schedules.run.success')
          refreshCatalog()
        }
      })
      .catch(() => {
        if (
          mounted.current &&
          observedConnectionEpoch.current === requestEpoch &&
          selectedKeyRef.current === key
        )
          setOperationError('schedules.run.failed')
      })
      .finally(() => {
        if (mounted.current && observedConnectionEpoch.current === requestEpoch) setBusy(false)
      })
  }
  const toggleSelected = (): void => {
    if (selected === undefined || busy || !selectedInCatalog || catalogStatus !== 'ready') return
    const key = scheduleKey(selected)
    const requestEpoch = observedConnectionEpoch.current
    setBusy(true)
    setOperationError(undefined)
    void send<UpdatePayload>({
      type: 'schedule.update',
      requestId: newRequestId(),
      payload: {
        id: selected.id,
        expected: expectedFeatureRecord(selected),
        expectedUpdatedAt: selected.updatedAt ?? null,
        active: selected.status !== 'active',
      },
    })
      .then(({ result }) => {
        if (
          mounted.current &&
          observedConnectionEpoch.current === requestEpoch &&
          selectedKeyRef.current === key
        ) {
          setOperationError(updateResultError(result))
          refreshCatalog()
        }
      })
      .catch(() => {
        if (
          mounted.current &&
          observedConnectionEpoch.current === requestEpoch &&
          selectedKeyRef.current === key
        )
          setOperationError('schedules.update.failed')
      })
      .finally(() => {
        if (mounted.current && observedConnectionEpoch.current === requestEpoch) setBusy(false)
      })
  }

  const openHistory = (): void => {
    if (selected === undefined) return
    setActiveTab('history')
    loadHistory(selected, undefined, true)
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
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
    if (moreActionsOpen) {
      setMoreActionsOpen(false)
      moreActionsTriggerRef.current?.focus()
      return
    }
    if (confirmDelete) {
      setConfirmDelete(false)
      return
    }
    closeDetails()
  }

  const detailView = {
    runSelected,
    toggleSelected,
    props,
    t,
    locale,
    labelId,
    selectedLinkedSession,
    selectedLinkedSessionId,
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
            <p>{t(nativeManagement ? 'schedules.create.nativeInstructions' : 'schedules.createViaChat')}</p>
          </div>
          <div className="dsh-schedule-panel__heading-actions">
            <button
              type="button"
              className="dsh-schedule-panel__new"
              aria-busy={sessionStarting}
              disabled={
                sessionStarting ||
                createOpen ||
                createStatus === 'pending' ||
                createStatus === 'unconfirmed' ||
                catalogStatus === 'unavailable'
              }
              onClick={startScheduleSession}
            >
              {t('schedules.create.open')}
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

        {createStatus !== 'idle' && !(createStatus === 'failed' && createOpen) ? (
          <div
            className={`dsh-schedule-panel__create-state dsh-schedule-panel__create-state--${createStatus}`}
            role={createStatus === 'failed' ? 'alert' : 'status'}
            aria-live="polite"
          >
            <span>
              {t(
                nativeManagement && createStatus === 'sending'
                  ? 'schedules.create.nativeSending'
                  : `schedules.create.${createStatus}`,
              )}
            </span>
            {createStatus === 'pending' || createStatus === 'unconfirmed' ? (
              <button type="button" disabled={catalogStatus === 'loading'} onClick={checkCreateCatalog}>
                {t('schedules.create.check')}
              </button>
            ) : null}
            {createStatus === 'unconfirmed' || createStatus === 'failed' ? (
              <button type="button" onClick={retryCreate}>
                {t('schedules.create.retry')}
              </button>
            ) : null}
            {createStatus === 'confirmed' && confirmedCreate !== undefined ? (
              <span className="dsh-schedule-panel__create-state-title">{confirmedCreate.title}</span>
            ) : null}
            {createStatus === 'confirmed' ? (
              <button
                type="button"
                aria-label={t('schedules.create.dismiss')}
                onClick={() => {
                  setCreateStatus('idle')
                  setConfirmedCreate(undefined)
                }}
              >
                {t('schedules.create.dismiss')}
              </button>
            ) : null}
          </div>
        ) : null}

        {createOpen ? (
          <ScheduleCreateForm
            nativeManagement={nativeManagement}
            workspaceChoices={workspaceChoices}
            creationWorkspaceId={creationWorkspaceId}
            setCreationWorkspaceId={setCreationWorkspaceId}
            targetMode={targetMode}
            setTargetMode={setTargetMode}
            t={t}
            createDraft={createDraft}
            setCreateDraft={setCreateDraft}
            createError={createError}
            setCreateError={setCreateError}
            submitCreate={submitCreate}
            sessionStarting={sessionStarting}
            catalogStatus={catalogStatus}
            setCreateOpen={setCreateOpen}
            setCreateStatus={setCreateStatus}
            pendingCreate={pendingCreate}
            listHeadingRef={listHeadingRef}
          />
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

        {/* Before the first settled read the panel holds no catalog at all, so a
         * count would report `0 of 0` as if it had verified an empty list. */}
        {catalogSettled ? (
          <p className="dsh-schedule-panel__count" role="status" aria-live="polite">
            {t('schedules.count', { visible: visibleRecords.length, total: records.length })}
          </p>
        ) : null}

        {catalogStatus === 'error' ? (
          <div className="dsh-schedule-panel__notice" role={catalogSettled ? 'status' : 'alert'}>
            <span>{catalogSettled ? t('schedules.stale') : t('schedules.loadFailed')}</span>
            <button type="button" onClick={refreshCatalog}>
              {t('schedules.retry')}
            </button>
          </div>
        ) : null}
        {catalogStatus === 'unavailable' ? (
          <div className="dsh-schedule-panel__notice" role="status">
            <span>{t('schedules.unavailable')}</span>
            <p className="dsh-schedule-panel__muted">{t('schedules.unavailableHint')}</p>
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

      {selected !== undefined ? <ScheduleDetail {...detailView} selected={selected} /> : null}
    </section>
  )
}
