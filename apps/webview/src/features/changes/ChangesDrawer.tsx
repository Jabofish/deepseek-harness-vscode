import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { ChangeDetail, ChangeReviewState, ChangeSetFile } from '@dsh-vscode/domain'

import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface ChangesDrawerProps {
  readonly changes: readonly ChangeSetFile[]
  readonly loading: boolean
  readonly onRefresh: () => Promise<void>
  readonly onOpen: (changeId: string) => Promise<void>
  readonly onDetail: (changeId: string) => Promise<ChangeDetail | undefined>
  readonly onMarkReviewed: (
    changeId: string,
    reviewState: ChangeReviewState,
  ) => Promise<ChangeSetFile | undefined>
}

/** Session-scoped structured change review popover. It never renders model text as change evidence. */
export function ChangesDrawer(props: ChangesDrawerProps): ReactElement | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<ChangeDetail | undefined>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [reviewing, setReviewing] = useState<ChangeReviewState | undefined>()
  const [reviewError, setReviewError] = useState(false)
  const [openError, setOpenError] = useState(false)
  const detailRequestGeneration = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void props
      .onRefresh()
      .catch(() => undefined)
      .finally(() => setRefreshing(false))
  }
  const openDetail = (changeId: string): void => {
    const generation = ++detailRequestGeneration.current
    setDetailLoading(true)
    void props
      .onDetail(changeId)
      .then((next) => {
        if (generation === detailRequestGeneration.current) setDetail(next)
      })
      .catch(() => {
        if (generation === detailRequestGeneration.current) setDetail(undefined)
      })
      .finally(() => {
        if (generation === detailRequestGeneration.current) setDetailLoading(false)
      })
  }
  const markDetailReviewed = (
    reviewState: Extract<ChangeReviewState, 'accepted' | 'rejected' | 'needs-attention'>,
  ): void => {
    if (detail === undefined || reviewing !== undefined) return
    setReviewing(reviewState)
    setReviewError(false)
    void props
      .onMarkReviewed(detail.changeId, reviewState)
      .then((next) => {
        if (next !== undefined)
          setDetail((current) => (current === undefined ? current : { ...current, ...next }))
        else setReviewError(true)
      })
      .catch(() => setReviewError(true))
      .finally(() => setReviewing(undefined))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    detailRequestGeneration.current += 1
    setOpen(false)
    setDetail(undefined)
    triggerRef.current?.focus()
  }

  if (props.changes.length === 0 && !props.loading) return null
  const countLabel = t('changes.count', { count: props.changes.length })
  return (
    <div ref={rootRef} className="dsh-changes-popover" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-changes-popover__trigger"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          setOpenError(false)
          setOpen((current) => !current)
        }}
      >
        <Icon name="branch" />
        <span>{countLabel}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div className="dsh-changes-popover__menu" role="dialog" aria-label={t('changes.list.aria')}>
          <div className="dsh-changes-popover__header">
            <strong>{t('changes.title')}</strong>
            <button
              className="dsh-icon-button"
              type="button"
              aria-label={t('changes.refresh')}
              title={t('changes.refresh')}
              disabled={refreshing || props.loading}
              onClick={refresh}
            >
              <Icon name="refresh" />
            </button>
          </div>
          {openError ? (
            <div className="dsh-changes-popover__error" role="alert">
              {t('changes.openFailed')}
            </div>
          ) : null}
          {props.loading && props.changes.length === 0 ? (
            <div className="dsh-changes-popover__status" role="status">
              {t('changes.loading')}
            </div>
          ) : null}
          {props.changes.length === 0 && !props.loading ? (
            <div className="dsh-changes-popover__status">{t('changes.empty')}</div>
          ) : null}
          <ul className="dsh-changes-popover__rows">
            {props.changes.map((change) => (
              <li key={change.changeId} className="dsh-changes-popover__row">
                <button
                  type="button"
                  className="dsh-changes-popover__row-main"
                  title={change.relativePath}
                  onClick={() => {
                    setOpenError(false)
                    void props.onOpen(change.changeId).catch(() => setOpenError(true))
                    if (change.reviewState === 'unreviewed')
                      void props.onMarkReviewed(change.changeId, 'viewed').catch(() => undefined)
                  }}
                >
                  <Icon name={change.applicationState === 'failed' ? 'alert' : 'file'} />
                  <span className="dsh-changes-popover__path">{change.relativePath}</span>
                  <span className="dsh-changes-popover__status-label">
                    {t(`changes.status.${change.status}`)}
                  </span>
                  <span className="dsh-changes-popover__evidence">
                    {t(`changes.evidence.${change.evidence}`)}
                  </span>
                </button>
                <button
                  type="button"
                  className="dsh-icon-button"
                  aria-label={t('changes.detail', { path: change.relativePath })}
                  title={t('changes.detail', { path: change.relativePath })}
                  onClick={() => openDetail(change.changeId)}
                >
                  <Icon name="search" />
                </button>
              </li>
            ))}
          </ul>
          {detailLoading ? (
            <div className="dsh-changes-popover__status" role="status">
              {t('changes.detailLoading')}
            </div>
          ) : null}
          {detail === undefined ? null : (
            <section className="dsh-changes-popover__detail" aria-label={t('changes.detailTitle')}>
              <div className="dsh-changes-popover__detail-header">
                <strong>{detail.relativePath}</strong>
                <button
                  className="dsh-icon-button"
                  type="button"
                  aria-label={t('changes.closeDetail')}
                  onClick={() => setDetail(undefined)}
                >
                  <Icon name="close" />
                </button>
              </div>
              <div className="dsh-changes-popover__detail-meta">
                <span>{t(`changes.evidence.${detail.evidence}`)}</span>
                <span>{t(`changes.application.${detail.applicationState}`)}</span>
                <span>{t(`changes.review.${detail.reviewState}`)}</span>
              </div>
              <pre>{detail.redactedDiff ?? t('changes.noDiff')}</pre>
              <div
                className="dsh-changes-popover__review-actions"
                role="group"
                aria-label={t('changes.reviewActions')}
              >
                <button
                  type="button"
                  className="dsh-button dsh-button--primary dsh-button--compact"
                  disabled={reviewing !== undefined}
                  onClick={() => markDetailReviewed('accepted')}
                >
                  {reviewing === 'accepted' ? t('changes.reviewing') : t('changes.accept')}
                </button>
                <button
                  type="button"
                  className="dsh-button dsh-button--danger dsh-button--compact"
                  disabled={reviewing !== undefined}
                  onClick={() => markDetailReviewed('rejected')}
                >
                  {reviewing === 'rejected' ? t('changes.reviewing') : t('changes.reject')}
                </button>
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary dsh-button--compact"
                  disabled={reviewing !== undefined}
                  onClick={() => markDetailReviewed('needs-attention')}
                >
                  {reviewing === 'needs-attention' ? t('changes.reviewing') : t('changes.needsAttention')}
                </button>
              </div>
              {reviewError ? (
                <div className="dsh-changes-popover__error" role="alert">
                  {t('changes.reviewFailed')}
                </div>
              ) : null}
            </section>
          )}
        </div>
      ) : null}
    </div>
  )
}
