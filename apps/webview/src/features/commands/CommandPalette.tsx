import type { ReactElement } from 'react'
import type { DynamicCommand } from '@dsh-vscode/domain'

export interface CommandPaletteProps {
  readonly commands: readonly DynamicCommand[]
  readonly query: string
  readonly argumentOptions?: readonly CommandArgumentOption[]
  readonly onExecute: (command: string, argument?: string) => void
}

export interface CommandArgumentOption {
  readonly value: string
  readonly label: string
}

export function CommandPalette(props: CommandPaletteProps): ReactElement {
  const parsed = parsePaletteQuery(props.query)
  const argument = parsed.argument
  const argumentCommand =
    argument === undefined
      ? undefined
      : props.commands.find((command) => command.name.toLocaleLowerCase() === parsed.name)
  if (argument !== undefined && argumentCommand !== undefined) {
    return renderArgumentPalette(argumentCommand, argument, props.argumentOptions ?? [], props.onExecute)
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
    <section className="dsh-command-palette" aria-label="Commands">
      {matches.length === 0 ? (
        <p role="status">No command matches “{props.query}”.</p>
      ) : (
        <ul>
          {matches.map(({ command }) => (
            <li key={command.name}>
              <button
                className="dsh-command-palette__item"
                type="button"
                onClick={() => props.onExecute(command.name)}
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

function renderArgumentPalette(
  command: DynamicCommand,
  argument: string,
  options: readonly CommandArgumentOption[],
  onExecute: (command: string, argument?: string) => void,
): ReactElement {
  const query = argument.trim().toLocaleLowerCase()
  const matches = options
    .map((option, index) => ({ option, index, score: fuzzyScore(option.value, query) }))
    .filter(
      (entry): entry is { option: CommandArgumentOption; index: number; score: number } =>
        entry.score !== undefined,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)

  return (
    <section className="dsh-command-palette" aria-label={`Arguments for /${command.name}`}>
      {options.length === 0 ? (
        <p role="status">
          <strong>/{command.name}</strong>
          <span>{command.input?.hint ?? 'Type an argument'}</span>
        </p>
      ) : matches.length === 0 ? (
        <p role="status">No matching arguments.</p>
      ) : (
        <ul>
          {matches.map(({ option }) => (
            <li key={option.value}>
              <button
                className="dsh-command-palette__item dsh-command-palette__item--argument"
                type="button"
                aria-label={`Use /${command.name} ${option.value}`}
                onClick={() => onExecute(command.name, option.value)}
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

function parsePaletteQuery(value: string): { readonly name: string; readonly argument?: string } {
  const query = value.trimStart()
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+(.*))?$/u.exec(query)
  if (match === null || match[1] === undefined) return { name: query.replace(/^\//, '').toLocaleLowerCase() }
  return {
    name: match[1].toLocaleLowerCase(),
    ...(match[2] === undefined ? {} : { argument: match[2] }),
  }
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
