import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from 'react'
import type { CheckpointPreview, CheckpointSummary } from '@dsh-vscode/domain'

import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface CheckpointDrawerProps {
  readonly checkpoints: readonly CheckpointSummary[]
  readonly loading: boolean
  readonly onRefresh: () => Promise<void>
  readonly onCreate: (label?: string) => Promise<CheckpointSummary | undefined>
  readonly onPreview: (checkpointId: string) => Promise<CheckpointPreview | undefined>
  readonly onDelete: (checkpointId: string) => Promise<void>
  readonly onRestore: (checkpointId: string) => Promise<'completed' | 'partial' | undefined>
}

type DialogState =
  | { readonly kind: 'create' }
  | { readonly kind: 'restore'; readonly checkpoint: CheckpointSummary }
  | { readonly kind: 'delete'; readonly checkpoint: CheckpointSummary }
  | undefined

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${Math.round(value / 1_024)} KiB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`
}

function statusKey(state: CheckpointSummary['state']): string {
  return `checkpoints.state.${state}`
}

/** Explicit checkpoint creation, preview, restore-confirmation and deletion UI. */
export function CheckpointDrawer(props: CheckpointDrawerProps): ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogState>()
  const [preview, setPreview] = useState<CheckpointPreview | undefined>()
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  /** The row control that opened the confirmation takes the keyboard back. */
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const dialogWasOpen = useRef(false)

  const dialogOpen = dialog !== undefined
  useEffect(() => {
    if (dialogWasOpen.current && !dialogOpen) {
      const target = dialogTriggerRef.current
      dialogTriggerRef.current = null
      // Deleting a checkpoint removes the row that opened the confirmation.
      if (target !== null && target.isConnected) target.focus()
    }
    dialogWasOpen.current = dialogOpen
  }, [dialogOpen])

  // The popover is pointer-dismissible like its Changes/Jobs siblings. The
  // trigger lives inside `rootRef`, so pressing it again toggles instead of
  // closing on the pointerdown and reopening on the click. A confirmation is
  // `aria-modal`: while one is up, a press elsewhere is not a dismissal.
  useEffect(() => {
    if (!open || dialogOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [dialogOpen, open])

  const closeDialog = (): void => {
    if (busy) return
    setDialog(undefined)
    setPreview(undefined)
    setLabel('')
    setError(undefined)
  }

  const refresh = (): void => {
    if (busy || props.loading) return
    setError(undefined)
    void props.onRefresh().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t('checkpoints.error'))
    })
  }

  const openRestore = (checkpoint: CheckpointSummary): void => {
    if (!checkpoint.restoreAllowed || checkpoint.expectedRevision === undefined || busy) return
    setError(undefined)
    setPreview(undefined)
    setPreviewLoading(true)
    void props
      .onPreview(checkpoint.checkpointId)
      .then((next) => {
        if (next === undefined) throw new Error(t('checkpoints.error'))
        setPreview(next)
        setDialog({ kind: 'restore', checkpoint: next.summary })
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('checkpoints.error'))
      })
      .finally(() => setPreviewLoading(false))
  }

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(undefined)
    void props
      .onCreate(label.trim() === '' ? undefined : label.trim())
      .then((created) => {
        if (created === undefined) throw new Error(t('checkpoints.error'))
        setDialog(undefined)
        setLabel('')
        setNotice(t('checkpoints.created'))
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('checkpoints.error'))
      })
      .finally(() => setBusy(false))
  }

  const deleteCheckpoint = (): void => {
    if (dialog?.kind !== 'delete' || busy) return
    const checkpointId = dialog.checkpoint.checkpointId
    setBusy(true)
    setError(undefined)
    void props
      .onDelete(checkpointId)
      .then(() => {
        closeDialog()
        setNotice(t('checkpoints.deleted'))
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('checkpoints.error'))
      })
      .finally(() => setBusy(false))
  }

  const restore = (): void => {
    if (dialog?.kind !== 'restore' || busy) return
    const checkpointId = dialog.checkpoint.checkpointId
    setBusy(true)
    setError(undefined)
    void props
      .onRestore(checkpointId)
      .then((result) => {
        if (result === undefined) throw new Error(t('checkpoints.error'))
        closeDialog()
        setNotice(result === 'partial' ? t('checkpoints.restorePartial') : t('checkpoints.restoreCompleted'))
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : t('checkpoints.error'))
      })
      .finally(() => setBusy(false))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (dialog !== undefined) closeDialog()
    else {
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  const countLabel = t('checkpoints.count', { count: props.checkpoints.length })
  return (
    <div ref={rootRef} className="dsh-checkpoints-popover" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-checkpoints-popover__trigger"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          setNotice(undefined)
          setOpen((current) => !current)
        }}
      >
        <Icon name="box" />
        <span>{countLabel}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div className="dsh-checkpoints-popover__menu" role="dialog" aria-label={t('checkpoints.list.aria')}>
          <div className="dsh-checkpoints-popover__header">
            <strong>{t('checkpoints.title')}</strong>
            <div className="dsh-checkpoints-popover__header-actions">
              <button
                className="dsh-button dsh-button--secondary dsh-button--compact"
                type="button"
                disabled={busy}
                onClick={(event) => {
                  dialogTriggerRef.current = event.currentTarget
                  setDialog({ kind: 'create' })
                }}
              >
                <Icon name="add" />
                {t('checkpoints.create')}
              </button>
              <button
                className="dsh-icon-button"
                type="button"
                aria-label={t('checkpoints.refresh')}
                title={t('checkpoints.refresh')}
                disabled={busy || props.loading}
                onClick={refresh}
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>
          {props.loading && props.checkpoints.length === 0 ? (
            <div className="dsh-checkpoints-popover__status" role="status">
              {t('checkpoints.loading')}
            </div>
          ) : null}
          {props.checkpoints.length === 0 && !props.loading ? (
            <div className="dsh-checkpoints-popover__status">{t('checkpoints.empty')}</div>
          ) : null}
          <ul className="dsh-checkpoints-popover__rows">
            {props.checkpoints.map((checkpoint) => (
              <li key={checkpoint.checkpointId} className="dsh-checkpoints-popover__row">
                <span
                  className="dsh-checkpoints-popover__state"
                  data-state={checkpoint.state}
                  title={t(statusKey(checkpoint.state))}
                  role="img"
                  aria-label={t(statusKey(checkpoint.state))}
                />
                <div className="dsh-checkpoints-popover__summary">
                  <strong title={checkpoint.label ?? checkpoint.checkpointId}>
                    {checkpoint.label || t('checkpoints.unnamed')}
                  </strong>
                  <span>
                    {t('checkpoints.fileSummary', {
                      files: checkpoint.fileCount,
                      size: formatBytes(checkpoint.totalBytes),
                    })}
                  </span>
                  <span className="dsh-checkpoints-popover__time">
                    {new Date(checkpoint.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="dsh-checkpoints-popover__row-actions">
                  {checkpoint.restoreAllowed && checkpoint.expectedRevision !== undefined ? (
                    <button
                      type="button"
                      className="dsh-icon-button"
                      aria-label={t('checkpoints.restore', {
                        label: checkpoint.label ?? checkpoint.checkpointId,
                      })}
                      title={t('checkpoints.restore', { label: checkpoint.label ?? checkpoint.checkpointId })}
                      disabled={busy || previewLoading}
                      onClick={(event) => {
                        dialogTriggerRef.current = event.currentTarget
                        openRestore(checkpoint)
                      }}
                    >
                      <Icon name="arrow-down" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="dsh-icon-button"
                    aria-label={t('checkpoints.delete', {
                      label: checkpoint.label ?? checkpoint.checkpointId,
                    })}
                    title={t('checkpoints.delete', { label: checkpoint.label ?? checkpoint.checkpointId })}
                    disabled={busy}
                    onClick={(event) => {
                      dialogTriggerRef.current = event.currentTarget
                      setError(undefined)
                      setDialog({ kind: 'delete', checkpoint })
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {notice !== undefined ? (
            <div className="dsh-checkpoints-popover__status" role="status">
              {notice}
            </div>
          ) : null}
          {error !== undefined ? (
            <div className="dsh-checkpoints-popover__error" role="alert">
              {error}
            </div>
          ) : null}
          {dialog?.kind === 'create' ? (
            <form
              className="dsh-checkpoints-popover__dialog"
              aria-label={t('checkpoints.createTitle')}
              onSubmit={create}
            >
              <strong>{t('checkpoints.createTitle')}</strong>
              <p>{t('checkpoints.sensitive')}</p>
              <label>
                <span>{t('checkpoints.label')}</span>
                <input
                  autoFocus
                  maxLength={256}
                  value={label}
                  placeholder={t('checkpoints.labelPlaceholder')}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <div className="dsh-checkpoints-popover__dialog-actions">
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  onClick={closeDialog}
                >
                  {t('checkpoints.cancel')}
                </button>
                <button type="submit" className="dsh-button" disabled={busy}>
                  {busy ? t('checkpoints.working') : t('checkpoints.createSubmit')}
                </button>
              </div>
            </form>
          ) : null}
          {dialog?.kind === 'restore' ? (
            <section className="dsh-checkpoints-popover__dialog" role="alertdialog" aria-modal="true">
              <strong>{t('checkpoints.restoreTitle')}</strong>
              <p>{t('checkpoints.restoreWarning')}</p>
              {preview === undefined ? null : (
                <ul className="dsh-checkpoints-popover__preview-list">
                  {preview.files.map((file) => (
                    <li key={file.relativePath} data-conflict={file.conflict ? 'true' : 'false'}>
                      <span title={file.relativePath}>{file.relativePath}</span>
                      <code title={file.currentHash ?? t('checkpoints.missingHash')}>
                        {file.conflict
                          ? t('checkpoints.conflict')
                          : (file.currentHash ?? t('checkpoints.missingHash')).slice(0, 12)}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
              {preview !== undefined && preview.conflictCount > 0 ? (
                <p className="dsh-checkpoints-popover__conflict">
                  {t('checkpoints.conflictCount', { count: preview.conflictCount })}
                </p>
              ) : null}
              <div className="dsh-checkpoints-popover__dialog-actions">
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  autoFocus
                  onClick={closeDialog}
                >
                  {t('checkpoints.cancel')}
                </button>
                <button
                  type="button"
                  className="dsh-button"
                  disabled={busy || preview === undefined || preview.conflictCount > 0}
                  onClick={restore}
                >
                  {busy ? t('checkpoints.working') : t('checkpoints.restoreConfirm')}
                </button>
              </div>
            </section>
          ) : null}
          {dialog?.kind === 'delete' ? (
            <section className="dsh-checkpoints-popover__dialog" role="alertdialog" aria-modal="true">
              <strong>{t('checkpoints.deleteTitle')}</strong>
              <p>{t('checkpoints.deleteWarning')}</p>
              <div className="dsh-checkpoints-popover__dialog-actions">
                <button
                  type="button"
                  className="dsh-button dsh-button--secondary"
                  disabled={busy}
                  autoFocus
                  onClick={closeDialog}
                >
                  {t('checkpoints.cancel')}
                </button>
                <button
                  type="button"
                  className="dsh-button dsh-button--danger"
                  disabled={busy}
                  onClick={deleteCheckpoint}
                >
                  {busy ? t('checkpoints.working') : t('checkpoints.deleteConfirm')}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
