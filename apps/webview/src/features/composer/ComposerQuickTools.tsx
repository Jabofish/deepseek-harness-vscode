import type { ReactElement } from 'react'
import type { EditorContextKind } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { EditorContextActions } from './EditorContextActions.js'

/** The current file stays visible; attachments and other context actions expand on focus. */
export function ComposerQuickTools(props: {
  readonly disabled: boolean
  readonly loading: boolean
  readonly availableKinds: readonly EditorContextKind[]
  readonly onPickAttachment: () => void
  readonly onCapture?: (kind: EditorContextKind) => Promise<void> | void
}): ReactElement {
  const { t } = useI18n()
  return (
    <div
      className="dsh-composer__quick-tools"
      role="group"
      aria-label={t('composer.context')}
      aria-busy={props.loading}
    >
      <button
        type="button"
        className="dsh-icon-button dsh-composer__quick-attach"
        aria-label={t('composer.attach')}
        title={t('composer.attach')}
        disabled={props.disabled}
        onClick={props.onPickAttachment}
      >
        <Icon name="paperclip" />
      </button>
      {props.onCapture === undefined || props.availableKinds.length === 0 ? null : (
        <EditorContextActions
          disabled={props.disabled}
          availableKinds={props.availableKinds}
          onCapture={props.onCapture}
        />
      )}
      {props.loading ? (
        <span className="dsh-sr-only" role="status">
          {t('composer.contextLoading')}
        </span>
      ) : null}
    </div>
  )
}
