import { memo, type ReactElement } from 'react'
import type { EditorContextItem, EditorContextKind, EditorContextPreview } from '@dsh-vscode/domain'

import { useI18n } from '../../i18n.js'
import { EditorContextActions } from './EditorContextActions.js'
import { EditorContextChips } from './EditorContextChips.js'

export interface EditorContextRailProps {
  readonly items: readonly EditorContextItem[]
  readonly disabled: boolean
  readonly availableKinds?: readonly EditorContextKind[]
  readonly loading?: boolean
  readonly onCapture?: (kind: EditorContextKind) => Promise<void> | void
  readonly onRemove?: (contextRef: string) => Promise<void> | void
  readonly onPreview?: (contextRef: string) => Promise<EditorContextPreview | undefined>
}

/**
 * The single composer surface for editor context. It deliberately keeps the
 * capture controls beside attached context instead of opening a second tall
 * menu, so important context remains visible without stealing prompt space.
 */
export const EditorContextRail = memo(function EditorContextRail(
  props: EditorContextRailProps,
): ReactElement | null {
  const { t } = useI18n()
  const managedItems =
    props.onRemove === undefined || props.onPreview === undefined
      ? undefined
      : { onRemove: props.onRemove, onPreview: props.onPreview }
  const capture = props.onCapture
  const availableKinds = props.availableKinds ?? []
  const hasItems = managedItems !== undefined && (props.items.length > 0 || props.loading === true)
  const hasCaptureActions = capture !== undefined && availableKinds.length > 0

  if (!hasItems && !hasCaptureActions) return null

  return (
    <div className="dsh-composer__context-rail" aria-label={t('composer.context')}>
      <div className="dsh-composer__context-content">
        {hasItems ? (
          <EditorContextChips
            items={props.items}
            disabled={props.disabled}
            {...(props.loading === undefined ? {} : { loading: props.loading })}
            {...managedItems}
          />
        ) : null}
        {hasCaptureActions ? (
          <EditorContextActions
            disabled={props.disabled}
            availableKinds={availableKinds}
            onCapture={capture}
          />
        ) : null}
      </div>
    </div>
  )
})
