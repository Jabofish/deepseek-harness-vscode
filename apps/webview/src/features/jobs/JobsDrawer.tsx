import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { JobView } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface JobsPopoverProps {
  readonly jobs: readonly JobView[]
}

/** A job the registry still holds open, and whose duration therefore ticks. */
function isLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/** Status-dot semantics: requested endings share the attention color. */
function dotState(status: JobView['status']): string {
  switch (status) {
    case 'running':
      return 'ongoing'
    case 'stopping':
    case 'killed':
      return 'warning'
    case 'completed':
      return 'done'
    case 'failed':
      return 'error'
  }
}

/** Elapsed time in at most two adjacent units; hours is the widest unit. */
function formatDuration(
  elapsedMs: number,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('duration.hoursMinutes', { hours, minutes })
  if (minutes > 0) return t('duration.minutesSeconds', { minutes, seconds })
  return t('duration.seconds', { seconds })
}

/** Live rows first in start order, then settled rows newest-first. */
function ordered(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/**
 * Session-header background-job popover, mirroring the upstream JobListAction:
 * renders nothing until the session has at least one job; live jobs keep the
 * trigger marked; the list orders live rows first and ticks their duration.
 */
export function JobsDrawer(props: JobsPopoverProps): ReactElement | null {
  const { jobs } = props
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const rows = useMemo(() => ordered(jobs), [jobs])
  const runningCount = useMemo(() => jobs.filter((job) => job.status === 'running').length, [jobs])
  const stoppingCount = useMemo(() => jobs.filter((job) => job.status === 'stopping').length, [jobs])
  const liveCount = runningCount + stoppingCount

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
    }
  }, [open])

  // The clock only runs while an open list is showing something that moves.
  useEffect(() => {
    if (!open || liveCount === 0) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1_000)
    return () => {
      clearInterval(timer)
    }
  }, [open, liveCount])

  if (jobs.length === 0) return null

  const count = liveCount > 0 ? liveCount : jobs.length
  const countLabel =
    runningCount > 0 && stoppingCount > 0
      ? t('jobs.count.live', { running: runningCount, stopping: stoppingCount })
      : runningCount > 0
        ? t('jobs.count.running', { count: runningCount })
        : stoppingCount > 0
          ? t('jobs.count.stopping', { count: stoppingCount })
          : t('jobs.count', { count })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className="dsh-jobs-popover" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-jobs-popover__trigger"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          setNow(Date.now())
          setOpen((current) => !current)
        }}
      >
        {liveCount > 0 ? (
          <span className="dsh-jobs-popover__dot" data-state={stoppingCount > 0 ? 'warning' : 'ongoing'} />
        ) : null}
        <span className="dsh-jobs-popover__count">{countLabel}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <ul className="dsh-jobs-popover__menu" aria-label={t('jobs.list.aria')}>
          {rows.map((job) => {
            const live = isLive(job)
            const elapsed = live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt
            const duration = formatDuration(elapsed, t)
            const status = t(`jobs.status.${job.status}`)
            return (
              <li key={job.id} className="dsh-jobs-popover__row" data-live={live ? 'true' : undefined}>
                <span
                  className="dsh-jobs-popover__dot"
                  data-state={dotState(job.status)}
                  role="img"
                  aria-label={status}
                />
                <span className="dsh-jobs-popover__kind">{job.kind}</span>
                <span className="dsh-jobs-popover__label" title={job.label}>
                  {job.label}
                </span>
                <span className="dsh-jobs-popover__status" title={job.detail ?? status}>
                  {job.detail ?? status}
                </span>
                <span className="dsh-jobs-popover__duration">{duration}</span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
