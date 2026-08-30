import { useState, type ReactElement } from 'react'
import type { EditorContextKind } from '@dsh-vscode/domain'

import { useI18n } from '../../i18n.js'
import { Icon, type IconName } from '../../ui/Icon.js'

export interface EditorContextActionsProps {
  readonly disabled: boolean
  /** Host-projected capabilities for the active editor. */
  readonly availableKinds: readonly EditorContextKind[]
  readonly onCapture: (kind: EditorContextKind) => Promise<void> | void
}

interface EditorContextAction {
  readonly kind: EditorContextKind
  readonly icon: IconName
  readonly labelKey: 'composer.contextSelection' | 'composer.contextFile' | 'composer.contextDiagnostic'
  readonly descriptionKey:
    'composer.addSelectionContext' | 'composer.addFileContext' | 'composer.addDiagnosticContext'
}

const CONTEXT_ACTIONS: readonly EditorContextAction[] = [
  {
    kind: 'selection',
    icon: 'edit',
    labelKey: 'composer.contextSelection',
    descriptionKey: 'composer.addSelectionContext',
  },
  {
    kind: 'file',
    icon: 'file',
    labelKey: 'composer.contextFile',
    descriptionKey: 'composer.addFileContext',
  },
  {
    kind: 'diagnostic',
    icon: 'alert',
    labelKey: 'composer.contextDiagnostic',
    descriptionKey: 'composer.addDiagnosticContext',
  },
]

/**
 * Compact editor-context capture actions. The rail owns placement; this
 * component owns the action transaction and its local error state.
 */
export function EditorContextActions(props: EditorContextActionsProps): ReactElement {
  const { t } = useI18n()
  const [capturing, setCapturing] = useState<EditorContextKind | undefined>()
  const [captureError, setCaptureError] = useState(false)

  const capture = (kind: EditorContextKind): void => {
    if (props.disabled || capturing !== undefined) return
    setCapturing(kind)
    setCaptureError(false)
    void Promise.resolve()
      .then(() => props.onCapture(kind))
      .catch(() => setCaptureError(true))
      .finally(() => setCapturing(undefined))
  }

  return (
    <div className="dsh-composer__context-actions">
      {CONTEXT_ACTIONS.filter((action) => props.availableKinds.includes(action.kind)).map((action) => {
        const label = t(action.labelKey)
        const description = t(action.descriptionKey)
        return (
          <button
            className="dsh-button dsh-button--ghost dsh-button--compact dsh-composer__context-capture"
            type="button"
            key={action.kind}
            aria-label={description}
            title={description}
            disabled={props.disabled || capturing !== undefined}
            onClick={() => capture(action.kind)}
          >
            <Icon name={action.icon} />
            <span className="dsh-composer__context-action-label">{label}</span>
          </button>
        )
      })}
      {capturing === undefined ? null : (
        <span className="dsh-composer__context-status" role="status">
          {t('composer.contextCapturing')}
        </span>
      )}
      {captureError ? (
        <span className="dsh-composer__context-status dsh-composer__context-status--error" role="alert">
          {t('composer.contextCaptureError')}
        </span>
      ) : null}
    </div>
  )
}
