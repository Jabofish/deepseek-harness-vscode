import { useMemo, useState, type ReactElement } from 'react'
import type { DynamicCommand } from '@dsh-vscode/domain'

import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface ComposerCommandActionsProps {
  readonly commands: readonly DynamicCommand[]
  readonly disabled: boolean
  readonly onInsert: (command: DynamicCommand) => void
}

/** A compact, data-driven command directory for the composer's plus menu. */
export function ComposerCommandActions(props: ComposerCommandActionsProps): ReactElement | null {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const commands = useMemo(
    () =>
      props.commands.filter((command) => {
        if (normalizedQuery === '') return true
        return `${command.name} ${command.description}`.toLocaleLowerCase().includes(normalizedQuery)
      }),
    [normalizedQuery, props.commands],
  )

  if (props.commands.length === 0) return null

  return (
    <details className="dsh-composer__command-actions">
      <summary className="dsh-composer__command-summary">
        <Icon name="terminal" />
        <span>{t('composer.commands')}</span>
        <Icon name="chevron-down" />
      </summary>
      <label className="dsh-composer__command-filter">
        <Icon name="search" />
        <span className="dsh-sr-only">{t('composer.searchCommands')}</span>
        <input
          type="search"
          value={query}
          placeholder={t('composer.searchCommands')}
          disabled={props.disabled}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      {commands.length === 0 ? (
        <span className="dsh-composer__command-empty" role="status">
          {t('composer.noCommands')}
        </span>
      ) : (
        <ul className="dsh-composer__command-list" role="menu" aria-label={t('composer.commands')}>
          {commands.map((command) => (
            <li key={command.name}>
              <button
                className="dsh-composer__command-item"
                type="button"
                role="menuitem"
                disabled={props.disabled}
                onClick={() => props.onInsert(command)}
              >
                <strong>/{command.name}</strong>
                <span>{command.description}</span>
                {command.input === undefined ? null : <small>{command.input.hint}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
