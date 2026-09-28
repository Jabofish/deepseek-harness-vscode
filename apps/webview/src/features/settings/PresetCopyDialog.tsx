import type { AgentPresetDescriptor } from '@dsh-vscode/domain'
import type { Ref, ReactElement } from 'react'

import { useI18n } from '../../i18n.js'

export interface CopyDraft {
  readonly from: string
  readonly fromTitle: string
  readonly id: string
  readonly name: string
  readonly saving: boolean
  readonly error: string | undefined
}

/** Exported for the i18n key spec, which pins one label per blocker. */
export type PresetCopyBlocker = 'idRequired' | 'idInvalid' | 'idTaken'

/** Ids a preset directory may be named, mirroring the host's own rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** Why this copy cannot be submitted yet; the host re-checks on submit. */
export function copyBlocker(
  draft: CopyDraft,
  rows: readonly AgentPresetDescriptor[],
): PresetCopyBlocker | undefined {
  if (draft.id === '') return 'idRequired'
  if (!PRESET_ID.test(draft.id)) return 'idInvalid'
  // A copy never overwrites: landing on a name already in use would replace
  // something the user did not open.
  if (rows.some((row) => row.id === draft.id)) return 'idTaken'
  return undefined
}

export function PresetCopyDialog({
  copy,
  rows,
  overlayRef,
  onChange,
  onConfirm,
  onDismiss,
}: {
  readonly copy: CopyDraft
  readonly rows: readonly AgentPresetDescriptor[]
  readonly overlayRef: Ref<HTMLDivElement>
  readonly onChange: (draft: CopyDraft) => void
  readonly onConfirm: () => void
  readonly onDismiss: () => void
}): ReactElement {
  const { t } = useI18n()
  const blocker = copyBlocker(copy, rows)
  const copyMessage = copy.error ?? (blocker === undefined ? undefined : t(`presets.${blocker}`))
  return (
    <div className="dsh-presets__modal-backdrop" role="presentation">
      <div
        ref={overlayRef}
        className="dsh-presets__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('presets.copyAria')}
      >
        <h3>{t('presets.copyHeading', { name: copy.fromTitle })}</h3>
        <label className="dsh-presets__field">
          <span>{t('presets.id')}</span>
          <input
            value={copy.id}
            autoFocus
            spellCheck={false}
            placeholder="my-preset"
            onChange={(event) => onChange({ ...copy, id: event.target.value, error: undefined })}
          />
        </label>
        <label className="dsh-presets__field">
          <span>{t('presets.displayName')}</span>
          <input
            value={copy.name}
            spellCheck={false}
            placeholder={t('presets.displayNamePlaceholder')}
            onChange={(event) => onChange({ ...copy, name: event.target.value, error: undefined })}
          />
        </label>
        {copyMessage === undefined ? null : (
          <p className="dsh-presets__dialog-error" role="alert">
            {copyMessage}
          </p>
        )}
        <div className="dsh-presets__dialog-actions">
          <button
            className="dsh-button dsh-button--secondary dsh-button--compact"
            type="button"
            disabled={copy.saving}
            onClick={onDismiss}
          >
            {t('presets.cancel')}
          </button>
          <button
            className="dsh-button dsh-button--compact"
            type="button"
            disabled={copy.saving || blocker !== undefined}
            onClick={onConfirm}
          >
            {copy.saving ? t('presets.creating') : t('presets.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
