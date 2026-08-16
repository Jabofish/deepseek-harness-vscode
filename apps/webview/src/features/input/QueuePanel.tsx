import type { ReactElement } from 'react'
import type { QueuedInput, RunningInputMode } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'

export interface QueuePanelProps {
  readonly items: readonly QueuedInput[]
  readonly onEdit: (id: string, text: string) => void
  readonly onRemove: (id: string) => void
  readonly onModeChange: (id: string, mode: RunningInputMode) => void
}

export function QueuePanel(props: QueuePanelProps): ReactElement {
  return (
    <section className="dsh-queue" aria-labelledby="queue-title">
      <header className="dsh-queue__header">
        <div>
          <span className="dsh-app__eyebrow">UP NEXT</span>
          <h2 id="queue-title">Queued prompts</h2>
        </div>
        <span className="dsh-queue__count">{props.items.length}</span>
      </header>
      {props.items.length === 0 ? (
        <p className="dsh-queue__empty">No queued prompts.</p>
      ) : (
        <ol className="dsh-queue__list">
          {props.items.map((item) => (
            <li key={item.id}>
              <div className="dsh-queue__item-main">
                <span className="dsh-queue__index" aria-hidden="true">
                  {props.items.indexOf(item) + 1}
                </span>
                <input
                  aria-label={`Edit ${item.id}`}
                  defaultValue={item.text}
                  onBlur={(event) => {
                    if (event.target.value !== item.text) props.onEdit(item.id, event.target.value)
                  }}
                />
              </div>
              <div className="dsh-queue__item-actions">
                <select
                  aria-label={`Mode for ${item.id}`}
                  value={item.mode}
                  onChange={(event) => props.onModeChange(item.id, event.target.value as RunningInputMode)}
                >
                  <option value="queue">Queue</option>
                  <option value="steer">Steer</option>
                </select>
                <button
                  className="dsh-icon-button"
                  type="button"
                  aria-label={`Remove queued prompt ${item.id}`}
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
