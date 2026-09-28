import type { Dispatch, FormEvent, ReactElement, RefObject, SetStateAction } from 'react'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import type { Translate } from '../../i18n.js'
import {
  CREATE_TIMINGS,
  timingChoices,
  timingLabel,
  type CreateDraft,
  type CreateStatus,
  type CreateTiming,
  type PendingCreate,
} from './schedule-model.js'

interface ScheduleCreateFormProps {
  readonly t: Translate
  readonly createDraft: CreateDraft
  readonly setCreateDraft: Dispatch<SetStateAction<CreateDraft>>
  readonly createError: string | undefined
  readonly setCreateError: Dispatch<SetStateAction<string | undefined>>
  readonly submitCreate: (event: FormEvent<HTMLFormElement>) => void
  readonly sessionStarting: boolean
  readonly catalogStatus: 'loading' | 'ready' | 'error' | 'unavailable'
  readonly setCreateOpen: Dispatch<SetStateAction<boolean>>
  readonly setCreateStatus: Dispatch<SetStateAction<CreateStatus>>
  readonly pendingCreate: RefObject<PendingCreate | undefined>
  readonly listHeadingRef: RefObject<HTMLHeadingElement | null>
}

export function ScheduleCreateForm({
  t,
  createDraft,
  setCreateDraft,
  createError,
  setCreateError,
  submitCreate,
  sessionStarting,
  catalogStatus,
  setCreateOpen,
  setCreateStatus,
  pendingCreate,
  listHeadingRef,
}: ScheduleCreateFormProps): ReactElement {
  return (
    <form
      className="dsh-schedule-panel__editor dsh-schedule-panel__create-form"
      noValidate
      onSubmit={submitCreate}
    >
      <h2>{t('schedules.create.formTitle')}</h2>
      <p className="dsh-schedule-panel__muted">{t('schedules.create.instructions')}</p>
      <label>
        <span>{t('schedules.field.title')}</span>
        <input
          value={createDraft.title}
          maxLength={120}
          required
          onChange={(event) => {
            setCreateDraft({ ...createDraft, title: event.target.value })
            setCreateError(undefined)
          }}
        />
      </label>
      <label>
        <span>{t('schedules.field.prompt')}</span>
        <textarea
          value={createDraft.prompt}
          required
          rows={4}
          onChange={(event) => {
            setCreateDraft({ ...createDraft, prompt: event.target.value })
            setCreateError(undefined)
          }}
        />
      </label>
      <label>
        <span>{t('schedules.field.timing')}</span>
        <SelectMenu
          className="dsh-schedule-panel__timing-picker"
          icon="clock"
          density="regular"
          label={timingLabel(createDraft.timing, t)}
          ariaLabel={t('schedules.field.timing')}
          title={t('schedules.field.timing')}
          value={createDraft.timing}
          options={timingChoices(CREATE_TIMINGS, t)}
          onChange={(value) => {
            const timing = value as CreateTiming
            setCreateDraft({
              ...createDraft,
              timing,
              ...(timing === 'every' && createDraft.timing !== 'every' ? { seconds: '60' } : {}),
            })
            setCreateError(undefined)
          }}
        />
      </label>
      {createDraft.timing === 'after' || createDraft.timing === 'every' ? (
        <div className="dsh-schedule-panel__create-fields">
          <label>
            <span>{t('schedules.field.seconds')}</span>
            <input
              type="number"
              min={createDraft.timing === 'every' ? '60' : '1'}
              step="1"
              required
              value={createDraft.seconds}
              onChange={(event) => {
                setCreateDraft({ ...createDraft, seconds: event.target.value })
                setCreateError(undefined)
              }}
            />
          </label>
          <p className="dsh-schedule-panel__muted">
            {t(createDraft.timing === 'every' ? 'schedules.create.everyHelp' : 'schedules.create.afterHelp')}
          </p>
        </div>
      ) : null}
      {createDraft.timing === 'at' ? (
        <div className="dsh-schedule-panel__timing-fields">
          <label>
            <span>{t('schedules.field.date')}</span>
            <input
              type="date"
              required
              value={createDraft.date}
              onChange={(event) => {
                setCreateDraft({ ...createDraft, date: event.target.value })
                setCreateError(undefined)
              }}
            />
          </label>
          <label>
            <span>{t('schedules.field.time')}</span>
            <input
              type="time"
              step="1"
              required
              value={createDraft.time}
              onChange={(event) => {
                setCreateDraft({ ...createDraft, time: event.target.value })
                setCreateError(undefined)
              }}
            />
          </label>
          <label>
            <span>{t('schedules.field.timeZone')}</span>
            <input
              required
              value={createDraft.timeZone}
              onChange={(event) => {
                setCreateDraft({ ...createDraft, timeZone: event.target.value })
                setCreateError(undefined)
              }}
            />
          </label>
          <p className="dsh-schedule-panel__muted">{t('schedules.create.timeZoneHelp')}</p>
          <p className="dsh-schedule-panel__muted">{t('schedules.create.dstHelp')}</p>
        </div>
      ) : null}
      {createDraft.timing === 'daily' || createDraft.timing === 'weekly' ? (
        <div className="dsh-schedule-panel__timing-fields">
          <label>
            <span>{t('schedules.field.time')}</span>
            <input
              type="time"
              step="1"
              required
              value={createDraft.time}
              onChange={(event) => {
                setCreateDraft({ ...createDraft, time: event.target.value })
                setCreateError(undefined)
              }}
            />
          </label>
          <label>
            <span>{t('schedules.field.timeZone')}</span>
            <input
              required
              value={createDraft.timeZone}
              onChange={(event) => {
                setCreateDraft({ ...createDraft, timeZone: event.target.value })
                setCreateError(undefined)
              }}
            />
          </label>
          {createDraft.timing === 'weekly' ? (
            <fieldset className="dsh-schedule-panel__weekdays">
              <legend>{t('schedules.field.weekdays')}</legend>
              {([1, 2, 3, 4, 5, 6, 7] as const).map((day) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={createDraft.weekdays.includes(day)}
                    onChange={(event) => {
                      setCreateDraft({
                        ...createDraft,
                        weekdays: event.target.checked
                          ? [...createDraft.weekdays, day]
                          : createDraft.weekdays.filter((value) => value !== day),
                      })
                      setCreateError(undefined)
                    }}
                  />
                  <span>{t(`schedules.weekday.${day}`)}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <p className="dsh-schedule-panel__muted">{t('schedules.create.timeZoneHelp')}</p>
          <p className="dsh-schedule-panel__muted">{t('schedules.create.dstRecurringHelp')}</p>
        </div>
      ) : null}
      {createDraft.timing === 'cron' ? (
        <div className="dsh-schedule-panel__timing-fields">
          <label>
            <span>{t('schedules.field.expression')}</span>
            <input
              required
              value={createDraft.expression}
              onChange={(event) => {
                setCreateDraft({ ...createDraft, expression: event.target.value })
                setCreateError(undefined)
              }}
            />
          </label>
          <label>
            <span>{t('schedules.field.timeZone')}</span>
            <input
              required
              value={createDraft.timeZone}
              onChange={(event) => {
                setCreateDraft({ ...createDraft, timeZone: event.target.value })
                setCreateError(undefined)
              }}
            />
          </label>
          <p className="dsh-schedule-panel__muted">{t('schedules.create.cronHelp')}</p>
          <p className="dsh-schedule-panel__muted">{t('schedules.create.timeZoneHelp')}</p>
        </div>
      ) : null}
      {createError !== undefined ? (
        <p className="dsh-schedule-panel__error" role="alert">
          {t(createError)}
        </p>
      ) : null}
      <div className="dsh-schedule-panel__actions">
        <button
          type="submit"
          className="dsh-schedule-panel__primary"
          disabled={sessionStarting || catalogStatus !== 'ready'}
        >
          {sessionStarting ? t('schedules.working') : t('schedules.create.submit')}
        </button>
        <button
          type="button"
          disabled={sessionStarting}
          onClick={() => {
            setCreateOpen(false)
            setCreateStatus(pendingCreate.current === undefined ? 'idle' : 'unconfirmed')
            setCreateError(undefined)
            listHeadingRef.current?.focus()
          }}
        >
          {t('schedules.create.cancel')}
        </button>
      </div>
    </form>
  )
}
