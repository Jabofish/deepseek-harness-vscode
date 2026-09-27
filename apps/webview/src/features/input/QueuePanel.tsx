import { memo, useId, useState, type ReactElement } from 'react'
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

  if (props.items.length <= 1 && !collapsed) setCollapsed(true)

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
                  {item.files === undefined || item.files.length === 0 ? null : (
                    <span className="dsh-queue__files" aria-label={t('timeline.attachedFiles')}>
                      {item.files.map((name, fileIndex) => (
                        <span className="dsh-queue__file" key={`${name}:${fileIndex}`} title={name}>
                          <Icon name="file" />
                          <span>{name}</span>
                        </span>
                      ))}
                    </span>
                  )}
                  <QueueItemEditor item={item} position={index + 1} onEdit={props.onEdit} />
                </div>
                <div className="dsh-queue__item-actions">
                  <SelectMenu
                    className="dsh-queue__mode"
                    icon="arrow-down"
                    density="compact"
                    displayLabel
                    label={item.mode === 'queue' ? t('queue.mode.queue') : t('queue.mode.steer')}
                    ariaLabel={t('queue.mode', { position: index + 1 })}
                    title={
                      item.mode === 'queue'
                        ? t('queue.mode', { position: index + 1 })
                        : t('queue.mode.fixed', { position: index + 1 })
                    }
                    value={item.mode}
                    // The pinned Host only turns a queued prompt into a steer
                    // request; nothing moves it back. A steering row therefore
                    // reports its mode instead of offering a switch that would
                    // silently do nothing.
                    options={
                      item.mode === 'queue'
                        ? [
                            { value: 'queue', label: t('queue.mode.queue') },
                            { value: 'steer', label: t('queue.mode.steer') },
                          ]
                        : [{ value: 'steer', label: t('queue.mode.steer') }]
                    }
                    disabled={item.mode !== 'queue' || !props.running}
                    placement="below"
                    onChange={(mode) => {
                      if (mode === 'steer' && props.running) props.onModeChange(item.id, mode)
                    }}
                  />
                  <button
                    className="dsh-icon-button"
                    type="button"
                    aria-label={t('queue.remove', { position: index + 1 })}
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

function QueueItemEditor(props: {
  readonly item: QueuedInput
  readonly position: number
  readonly onEdit: QueuePanelProps['onEdit']
}): ReactElement {
  const { t } = useI18n()
  const [value, setValue] = useState(props.item.text)
  const [previousText, setPreviousText] = useState(props.item.text)
  /** The text this row last sent to the Host; Enter and blur share its guard. */
  const [committedText, setCommittedText] = useState(props.item.text)
  if (previousText !== props.item.text) {
    // Queue projections are authoritative. Refresh a mounted editor whenever
    // DSH reports a newer value so an old uncontrolled default cannot be
    // submitted later and overwrite that update.
    setPreviousText(props.item.text)
    setValue(props.item.text)
    setCommittedText(props.item.text)
  }

  const commitIfChanged = (): void => {
    if (value !== committedText) {
      setCommittedText(value)
      props.onEdit(props.item.id, value)
    }
  }

  return (
    <input
      aria-label={t('queue.edit', { position: props.position })}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      // The only queue edit the host accepts replaces the whole content with
      // text, so a row that carries an image or a file stays read-only rather
      // than losing what it holds.
      readOnly={!props.item.textOnly}
      title={props.item.textOnly ? undefined : t('queue.editWithAttachments')}
      onBlur={commitIfChanged}
      onKeyDown={(event) => {
        // An IME composition's Enter confirms the candidate, never the row.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') {
          event.preventDefault()
          commitIfChanged()
        } else if (event.key === 'Escape') {
          // Escape discards the uncommitted draft; the blur that may follow
          // then sees the committed text and never re-sends it.
          event.preventDefault()
          setValue(committedText)
        }
      }}
    />
  )
}
