import type { ReactElement } from 'react'
import type { QueuedInput, RunningInputMode } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { SelectMenu } from '../../components/common/SelectMenu.js'

export interface QueuePanelProps {
  readonly items: readonly QueuedInput[]
  readonly onEdit: (id: string, text: string) => void
  readonly onRemove: (id: string) => void
  readonly onModeChange: (id: string, mode: RunningInputMode) => void
}

export function QueuePanel(props: QueuePanelProps): ReactElement {
  const { t } = useI18n()
  return (
    <section className="dsh-queue" aria-labelledby="queue-title">
      <header className="dsh-queue__header">
        <div>
          <span className="dsh-app__eyebrow">{t('queue.eyebrow')}</span>
          <h2 id="queue-title">{t('queue.title')}</h2>
        </div>
        <span className="dsh-queue__count">{props.items.length}</span>
      </header>
      {props.items.length === 0 ? (
        <p className="dsh-queue__empty">{t('queue.empty')}</p>
      ) : (
        <ol className="dsh-queue__list">
          {props.items.map((item) => (
            <li key={item.id}>
              <div className="dsh-queue__item-main">
                <span className="dsh-queue__index" aria-hidden="true">
                  {props.items.indexOf(item) + 1}
                </span>
                <input
                  aria-label={t('queue.edit', { id: item.id })}
                  defaultValue={item.text}
                  onBlur={(event) => {
                    if (event.target.value !== item.text) props.onEdit(item.id, event.target.value)
                  }}
                />
              </div>
              <div className="dsh-queue__item-actions">
                <SelectMenu
                  className="dsh-queue__mode"
                  icon="arrow-down"
                  density="regular"
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
          ))}
        </ol>
      )}
    </section>
  )
}
