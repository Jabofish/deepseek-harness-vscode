import type { FormEvent, ReactElement, Ref } from 'react'

import { useI18n } from '../../i18n.js'
import type { RenameTarget } from './session-drawer-model.js'

export function RenameDialog({
  target,
  draft,
  conflict,
  error,
  busy,
  dialogId,
  dialogRef,
  inputRef,
  onDraftChange,
  onCancel,
  onSubmit,
}: {
  readonly target: RenameTarget
  readonly draft: string
  readonly conflict: boolean
  readonly error: string | undefined
  readonly busy: boolean
  readonly dialogId: string
  readonly dialogRef: Ref<HTMLFormElement>
  readonly inputRef: Ref<HTMLInputElement>
  readonly onDraftChange: (value: string) => void
  readonly onCancel: () => void
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <div className="dsh-session-dialog__backdrop" role="presentation">
      <form
        ref={dialogRef}
        className="dsh-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogId}
        tabIndex={-1}
        onSubmit={onSubmit}
      >
        <h2 id={dialogId} className="dsh-session-dialog__title">
          {target.kind === 'session' ? t('sessions.renameTitle') : t('sessions.renameWorkspaceTitle')}
        </h2>
        <label className="dsh-session-dialog__label" htmlFor={`${dialogId}-input`}>
          {target.kind === 'session' ? t('sessions.sessionName') : t('sessions.workspaceName')}
        </label>
        <input
          ref={inputRef}
          id={`${dialogId}-input`}
          className="dsh-session-dialog__input"
          value={draft}
          maxLength={target.kind === 'session' ? 512 : 256}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        {conflict ? (
          <p className="dsh-session-dialog__warning" role="status">
            {target.kind === 'session' ? t('sessions.renameConflict') : t('sessions.workspaceRenameConflict')}
          </p>
        ) : null}
        {error === undefined ? null : (
          <p className="dsh-session-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="dsh-session-dialog__actions">
          <button
            className="dsh-button dsh-button--secondary"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button className="dsh-button dsh-button--primary" type="submit" disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </div>
  )
}

export function RemoveWorkspaceDialog({
  name,
  sessionCount,
  error,
  busy,
  titleId,
  dialogRef,
  onCancel,
  onConfirm,
}: {
  readonly name: string
  readonly sessionCount: number
  readonly error: string | undefined
  readonly busy: boolean
  readonly titleId: string
  readonly dialogRef: Ref<HTMLDivElement>
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <div className="dsh-session-dialog__backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="dsh-session-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${titleId}-remove-title`}
        tabIndex={-1}
      >
        <h2 id={`${titleId}-remove-title`} className="dsh-session-dialog__title">
          {t('sessions.removeWorkspaceTitle')}
        </h2>
        <p className="dsh-session-dialog__description">
          {t('sessions.removeWorkspaceConfirm', {
            name: name,
            count: sessionCount,
          })}
        </p>
        {error === undefined ? null : (
          <p className="dsh-session-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="dsh-session-dialog__actions">
          <button
            className="dsh-button dsh-button--secondary"
            type="button"
            disabled={busy}
            autoFocus
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button className="dsh-button dsh-button--danger" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? t('common.removing') : t('common.remove')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function DeleteSessionDialog({
  title,
  error,
  busy,
  titleId,
  dialogRef,
  onCancel,
  onConfirm,
}: {
  readonly title: string
  readonly error: string | undefined
  readonly busy: boolean
  readonly titleId: string
  readonly dialogRef: Ref<HTMLDivElement>
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <div className="dsh-session-dialog__backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="dsh-session-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${titleId}-delete-title`}
        tabIndex={-1}
      >
        <h2 id={`${titleId}-delete-title`} className="dsh-session-dialog__title">
          {t('sessions.deleteTitle')}
        </h2>
        <p className="dsh-session-dialog__description">
          {t('sessions.deleteConfirm', {
            title: title,
          })}
        </p>
        {error === undefined ? null : (
          <p className="dsh-session-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="dsh-session-dialog__actions">
          <button
            className="dsh-button dsh-button--secondary"
            type="button"
            disabled={busy}
            autoFocus
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button className="dsh-button dsh-button--danger" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? t('common.removing') : t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
