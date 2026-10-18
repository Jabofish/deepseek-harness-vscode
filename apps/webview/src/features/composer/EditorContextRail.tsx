import { memo, type ReactElement } from 'react'
import type { EditorContextItem, EditorContextPreview } from '@dsh-vscode/domain'

import { useI18n } from '../../i18n.js'
import { EditorContextChips } from './EditorContextChips.js'

export interface EditorContextRailProps {
  readonly items: readonly EditorContextItem[]
  readonly disabled: boolean
  readonly loading?: boolean
  readonly onRemove?: (contextRef: string) => Promise<void> | void
  readonly onPreview?: (contextRef: string) => Promise<EditorContextPreview | undefined>
}

/**
 * Only attached context owns space above the prompt. Discovery, capture actions
 * and refresh progress use the floating tools without resizing the input.
 */
export const EditorContextRail = memo(function EditorContextRail(
  props: EditorContextRailProps,
): ReactElement | null {
  const { t } = useI18n()
  const managedItems =
    props.onRemove === undefined || props.onPreview === undefined
      ? undefined
      : { onRemove: props.onRemove, onPreview: props.onPreview }
  if (managedItems === undefined || props.items.length === 0) return null

  return (
    <div className="dsh-composer__context-rail" aria-label={t('composer.context')}>
      <div className="dsh-composer__context-content">
        <EditorContextChips
          items={props.items}
          disabled={props.disabled}
          {...(props.loading === undefined ? {} : { loading: props.loading })}
          {...managedItems}
        />
      </div>
    </div>
  )
})
