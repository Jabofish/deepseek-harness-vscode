import type { ReactElement } from 'react'
import type { DynamicCommand } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'

export interface CommandPaletteProps {
  readonly commands: readonly DynamicCommand[]
  readonly query: string
  readonly argumentOptions?: readonly CommandArgumentOption[]
  readonly onExecute: (command: string, argument?: string) => void
  /** Official escape tier: while equal to `query` the menu renders nothing. */
  readonly dismissedFor?: string
  /** Highlighted row index driven by the composer's keyboard arbitration. */
  readonly highlight?: number
}

export interface CommandArgumentOption {
  readonly value: string
  readonly label: string
}

export interface CommandPaletteSelection {
  readonly command: DynamicCommand
  readonly argument?: string
}

/** One keyboard-navigable menu row: a command candidate or an argument option
 * of the command currently being completed. */
export type CommandMenuRow =
  | { readonly kind: 'command'; readonly command: DynamicCommand }
  | {
      readonly kind: 'argument'
      readonly command: DynamicCommand
      readonly option: CommandArgumentOption
    }

/** Menu rows for a query, mirroring the render branch: a query that already
 * carries arguments for a known command yields the fuzzy-ranked argument
 * options, every other query yields the fuzzy-ranked command candidates. */
export function commandMenuRows(
  query: string,
  commands: readonly DynamicCommand[],
  argumentOptions: readonly CommandArgumentOption[] = [],
): readonly CommandMenuRow[] {
  const parsed = parsePaletteQuery(query)
  if (parsed.argument !== undefined) {
    const command = commands.find((entry) => entry.name.toLocaleLowerCase() === parsed.name)
    if (command !== undefined)
      return rankArgumentOptions(argumentOptions, parsed.argument).map((option) => ({
        kind: 'argument',
        command,
        option,
      }))
  }
  return commands
    .map((command, index) => ({ command, index, score: fuzzyScore(command.name, parsed.name) }))
    .filter(
      (entry): entry is { command: DynamicCommand; index: number; score: number } =>
        entry.score !== undefined,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => ({ kind: 'command', command: entry.command }))
}

/** Return the first official-directory match used by keyboard completion. */
export function firstCommandPaletteSelection(
  query: string,
  commands: readonly DynamicCommand[],
  argumentOptions: readonly CommandArgumentOption[] = [],
): CommandPaletteSelection | undefined {
  const parsed = parsePaletteQuery(query)
  if (parsed.argument !== undefined) {
    const command = commands.find((entry) => entry.name.toLocaleLowerCase() === parsed.name)
    if (command === undefined) return undefined
    const argument = rankArgumentOptions(argumentOptions, parsed.argument)[0]?.value
    return argument === undefined ? { command } : { command, argument }
  }
  const command = commands
    .map((entry, index) => ({ command: entry, index, score: fuzzyScore(entry.name, parsed.name) }))
    .filter(
      (entry): entry is { command: DynamicCommand; index: number; score: number } =>
        entry.score !== undefined,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)[0]?.command
  return command === undefined ? undefined : { command }
}

export const COMMAND_MENU_ID = 'dsh-command-menu'

export function commandMenuOptionId(index: number): string {
  return `dsh-command-option-${index}`
}

export function CommandPalette(props: CommandPaletteProps): ReactElement {
  const { t } = useI18n()
  if (props.dismissedFor === props.query) return <></>
  const parsed = parsePaletteQuery(props.query)
  const argument = parsed.argument
  const argumentCommand =
    argument === undefined
      ? undefined
      : props.commands.find((command) => command.name.toLocaleLowerCase() === parsed.name)
  if (argument !== undefined && argumentCommand !== undefined) {
    return renderArgumentPalette(
      argumentCommand,
      argument,
      props.argumentOptions ?? [],
      props.highlight,
      props.onExecute,
      t,
    )
  }

  const query = parsed.name
  const matches = props.commands
    .map((command, index) => ({ command, index, score: fuzzyScore(command.name, query) }))
    .filter(
      (entry): entry is { command: DynamicCommand; index: number; score: number } =>
        entry.score !== undefined,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
  return (
    <section className="dsh-command-palette" id={COMMAND_MENU_ID} aria-label={t('commands.aria')}>
      {matches.length === 0 ? (
        <p role="status">{t('commands.noMatch', { query: props.query })}</p>
      ) : (
        <ul role="listbox" aria-label={t('commands.aria')}>
          {matches.map(({ command }, index) => (
            <li key={command.name} ref={scrollHighlighted(index, props.highlight)}>
              <button
                id={commandMenuOptionId(index)}
                className={`dsh-command-palette__item${
                  index === props.highlight ? ' dsh-command-palette__item--highlighted' : ''
                }`}
                type="button"
                role="option"
                aria-selected={index === props.highlight}
                // Official combobox: rows pick on mousedown and the textarea
                // keeps focus (preventDefault stops the native focus shift).
                onMouseDown={(event) => {
                  event.preventDefault()
                  props.onExecute(command.name)
                }}
              >
                <strong>/{command.name}</strong>
                <span>{command.description}</span>
                {command.input === undefined ? null : <small>{command.input.hint}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Keeps the highlighted row inside the menu's scroll area (official clamp). */
function scrollHighlighted(
  index: number,
  highlight: number | undefined,
): (element: HTMLLIElement | null) => void {
  return (element) => {
    if (index === highlight && element !== null && typeof element.scrollIntoView === 'function')
      element.scrollIntoView({ block: 'nearest' })
  }
}

function renderArgumentPalette(
  command: DynamicCommand,
  argument: string,
  options: readonly CommandArgumentOption[],
  highlight: number | undefined,
  onExecute: (command: string, argument?: string) => void,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): ReactElement {
  const matches = rankArgumentOptions(options, argument)

  return (
    <section
      className="dsh-command-palette"
      id={COMMAND_MENU_ID}
      aria-label={t('commands.arguments', { command: command.name })}
    >
      {options.length === 0 ? (
        <p role="status">
          <strong>/{command.name}</strong>
          <span>{command.input?.hint ?? t('commands.typeArgument')}</span>
        </p>
      ) : matches.length === 0 ? (
        <p role="status">{t('commands.noArguments')}</p>
      ) : (
        <ul role="listbox" aria-label={t('commands.arguments', { command: command.name })}>
          {matches.map((option, index) => (
            <li key={option.value} ref={scrollHighlighted(index, highlight)}>
              <button
                id={commandMenuOptionId(index)}
                className={`dsh-command-palette__item dsh-command-palette__item--argument${
                  index === highlight ? ' dsh-command-palette__item--highlighted' : ''
                }`}
                type="button"
                role="option"
                aria-selected={index === highlight}
                aria-label={t('commands.use', { command: command.name, argument: option.value })}
                onMouseDown={(event) => {
                  event.preventDefault()
                  onExecute(command.name, option.value)
                }}
              >
                <strong>{option.label}</strong>
                <span>/{command.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function parsePaletteQuery(value: string): { readonly name: string; readonly argument?: string } {
  const query = value.trimStart()
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+(.*))?$/u.exec(query)
  if (match === null || match[1] === undefined) return { name: query.replace(/^\//, '').toLocaleLowerCase() }
  return {
    name: match[1].toLocaleLowerCase(),
    ...(match[2] === undefined ? {} : { argument: match[2] }),
  }
}

/** Fuzzy-rank argument options for the argument portion of a query; the
 * ranking is shared by the rendered menu, the keyboard row model, and the
 * Tab-completion selection so the three can never disagree. */
function rankArgumentOptions(
  options: readonly CommandArgumentOption[],
  argument: string,
): readonly CommandArgumentOption[] {
  const query = argument.trim().toLocaleLowerCase()
  return options
    .map((option, index) => ({ option, index, score: fuzzyScore(option.value, query) }))
    .filter(
      (entry): entry is { option: CommandArgumentOption; index: number; score: number } =>
        entry.score !== undefined,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.option)
}

function fuzzyScore(name: string, query: string): number | undefined {
  if (query === '') return 0
  const value = name.toLocaleLowerCase()
  let cursor = 0
  let score = 0
  let previous = -1
  for (const character of query) {
    const index = value.indexOf(character, cursor)
    if (index < 0) return undefined
    if (index === 0) score -= 100
    if (index !== previous + 1) score += 10 + index
    else score -= 2
    cursor = index + 1
    previous = index
  }
  if (value.startsWith(query)) score -= 50
  return score + value.length
}
