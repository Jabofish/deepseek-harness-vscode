import { memo, useEffect, useId, useState, type ReactElement } from 'react'
import type { MessageImageReference, QueuedInput, RunningInputMode } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'
import { MessageImages } from '../chat/MessageImages.js'

export interface QueuePanelProps {
  readonly items: readonly QueuedInput[]
  readonly running: boolean
  readonly onEdit: (id: string, text: string) => void
  readonly onRemove: (id: string) => void
  readonly onModeChange: (id: string, mode: RunningInputMode) => void
  readonly onLoadImage?: (image: MessageImageReference) => Promise<string | undefined>
}

export const QueuePanel = memo(function QueuePanel(props: QueuePanelProps): ReactElement | null {
  const { t } = useI18n()
  const listId = useId()
  const [collapsed, setCollapsed] = useState(true)
  const multiple = props.items.length > 1
  // DSH uses `queue` for a normal prompt when idle. Do not turn that
  // transient single-item admission into a visible queue dock; a running
  // item or a real multi-item backlog is the user-facing queue state.
  const visible = multiple || (props.running && props.items.length > 0)

  useEffect(() => {
    if (props.items.length <= 1 && !collapsed) setCollapsed(true)
  }, [collapsed, props.items.length])

  if (!visible) return null

  const expanded = multiple && !collapsed
  const listVisible = props.items.length === 1 || expanded

  return (
    <section className="dsh-queue" aria-label={t('queue.title')}>
      {multiple ? (
        <button
          className="dsh-queue__header"
          type="button"
          aria-controls={listId}
          aria-expanded={expanded}
          onClick={() => setCollapsed((current) => !current)}
        >
          <Icon name="list" className="dsh-queue__header-icon" />
          <span className="dsh-queue__header-label">{t('queue.title')}</span>
          <span className="dsh-queue__count">{props.items.length}</span>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} className="dsh-queue__header-chevron" />
        </button>
      ) : null}
      <ol id={listId} className="dsh-queue__list" hidden={!listVisible}>
        {listVisible
          ? props.items.map((item, index) => (
              <li key={item.id}>
                <div className="dsh-queue__item-main">
                  <span className="dsh-queue__index" aria-hidden="true">
                    {index + 1}
                  </span>
                  {item.images !== undefined && item.images.length > 0 ? (
                    <MessageImages
                      images={item.images}
                      translate={t}
                      {...(props.onLoadImage === undefined ? {} : { loadImage: props.onLoadImage })}
                    />
                  ) : null}
                  <input
                    aria-label={t('queue.edit', { id: item.id })}
                    defaultValue={item.text}
                    readOnly={item.images !== undefined && item.images.length > 0}
                    title={
                      item.images !== undefined && item.images.length > 0
                        ? t('queue.editWithImages')
                        : undefined
                    }
                    onBlur={(event) => {
                      if (event.target.value !== item.text) props.onEdit(item.id, event.target.value)
                    }}
                  />
                </div>
                <div className="dsh-queue__item-actions">
                  <SelectMenu
                    className="dsh-queue__mode"
                    icon="arrow-down"
                    density="compact"
                    displayLabel
                    label={item.mode === 'queue' ? t('queue.mode.queue') : t('queue.mode.steer')}
                    ariaLabel={t('queue.mode', { id: item.id })}
                    title={t('queue.mode', { id: item.id })}
                    value={item.mode}
                    options={[
                      { value: 'queue', label: t('queue.mode.queue') },
                      { value: 'steer', label: t('queue.mode.steer') },
                    ]}
                    placement="below"
                    onChange={(mode) => {
                      if (mode === 'queue' || mode === 'steer') props.onModeChange(item.id, mode)
                    }}
                  />
                  <button
                    className="dsh-icon-button"
                    type="button"
                    aria-label={t('queue.remove', { id: item.id })}
                    onClick={() => props.onRemove(item.id)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </li>
            ))
          : null}
      </ol>
    </section>
  )
})
